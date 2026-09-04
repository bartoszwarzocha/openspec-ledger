/**
 * Candidate references taken from a task's own wording (design.md D8).
 *
 * Extraction is purely textual: no source file is opened, so the result depends
 * on nothing but the label, and a wrong guess costs a search rather than a claim
 * about the working tree. Two kinds come out of it, because the git layer has two
 * ways to look: a path is matched against a commit's changed-file list, a symbol
 * against the content of the change itself.
 */

import { normalizePath } from '../model/keys.ts';
import type { TaskReferences } from '../model/types.ts';

/** Below this a token carries no search value: `ok` matches everything. */
const MIN_LENGTH = 3;

/** A file extension on the last path segment: `mod.rs`, `package.json`. */
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

const ALPHANUMERIC = /^[A-Z][A-Za-z0-9]*$/;

interface Token {
  text: string;
  /** Inside an inline-code span, which is by itself enough to make a symbol. */
  inCode: boolean;
}

/** What survived trimming, plus whether a call parenthesis was trimmed off it. */
interface CleanToken {
  text: string;
  hadCall: boolean;
}

export function extractReferences(label: string): TaskReferences {
  const paths: string[] = [];
  const symbols: string[] = [];
  const seenPaths = new Set<string>();
  const seenSymbols = new Set<string>();

  for (const token of tokenize(label)) {
    const { text, hadCall } = cleanToken(token.text);
    if (text.length < MIN_LENGTH || !/[A-Za-z]/.test(text)) {
      // Too short, or made only of digits and punctuation: `5`, `1.1`, `-->`.
      continue;
    }

    if (looksLikePath(text)) {
      // `./src/a.ts` and `src/a.ts` name the same file; the matcher compares suffixes.
      const value = normalizePath(text).replace(/^\.\//, '');
      if (!seenPaths.has(value)) {
        seenPaths.add(value);
        paths.push(value);
      }
      continue;
    }

    if (token.inCode || hadCall || isPascalCase(text)) {
      if (!seenSymbols.has(text)) {
        seenSymbols.add(text);
        symbols.push(text);
      }
    }
  }

  return { paths, symbols };
}

/**
 * Split the label into whitespace-separated tokens in reading order, marking the
 * ones that came out of an inline-code span. Order is preserved because the
 * panel shows these back to the user, and the order they wrote them in is the
 * order that reads naturally.
 */
function tokenize(label: string): Token[] {
  const codeSpan = /(`+)([\s\S]+?)\1/g;
  const out: Token[] = [];
  let cursor = 0;

  for (let match = codeSpan.exec(label); match !== null; match = codeSpan.exec(label)) {
    pushWords(out, label.slice(cursor, match.index), false);
    pushWords(out, match[2] ?? '', true);
    cursor = match.index + match[0].length;
  }
  pushWords(out, label.slice(cursor), false);
  return out;
}

function pushWords(out: Token[], text: string, inCode: boolean): void {
  for (const word of text.split(/\s+/)) {
    if (word.length > 0) {
      out.push({ text: word, inCode });
    }
  }
}

/**
 * Strip the punctuation a token collects from prose and markdown.
 *
 * A trailing call parenthesis is remembered rather than merely removed: on a
 * bare token it is the only thing that marks it as an identifier.
 */
function cleanToken(raw: string): CleanToken {
  // A leading dash goes too: a token is never searched for as `-S--force`.
  let value = raw.replace(/^[-([{"'`*_~]+/, '');
  let hadCall = false;

  for (;;) {
    const trimmed = value.replace(/[.,;:!?"'`*~/\\]+$/, '');
    if (trimmed !== value) {
      value = trimmed;
      continue;
    }
    const call = /^(.+?)\([^()]*\)$/.exec(value);
    const head = call?.[1];
    if (head !== undefined) {
      value = head;
      hadCall = true;
      continue;
    }
    const closed = value.replace(/[)\]}]+$/, '');
    if (closed !== value) {
      value = closed;
      continue;
    }
    return { text: value, hadCall };
  }
}

/** A slash and an extension. A URL has both and is neither a path nor a symbol. */
function looksLikePath(text: string): boolean {
  if (!/[\\/]/.test(text) || text.includes('://')) {
    return false;
  }
  const segments = text.split(/[\\/]/);
  const last = segments[segments.length - 1] ?? '';
  return EXTENSION.test(last);
}

/**
 * `LookupProvider`, not `Create` and not `API`: a hump after the first
 * character is what separates an identifier from a capitalised English word,
 * and a lower-case letter is what separates it from an acronym.
 */
function isPascalCase(text: string): boolean {
  return ALPHANUMERIC.test(text) && /[a-z]/.test(text) && /[A-Z]/.test(text.slice(1));
}
