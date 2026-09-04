/**
 * The `tasks.md` reader (design.md D4).
 *
 * The format is a convention, not a schema: the file is markdown that a human
 * or an agent edits by hand, so the parser recognises what it understands and
 * steps over everything else. Nothing here is fatal - a change whose task list
 * cannot be read is still shown, with whatever was recognised.
 *
 * The loop is single-pass and dispatches on the first non-blank character of a
 * line before touching a regular expression, because this file is re-parsed for
 * every revision of every change during a history backfill (D7, D13). Only a
 * fence that is never closed costs a further pass, and that file is broken.
 */

import type { ParsedTaskFile, Task, TaskSection, TaskState } from './types.ts';
import { TASK_LINE_RE, flattenTasks, leafTasks, makeProgress } from './keys.ts';

export interface ParseOptions {
  /** Columns a tab advances when indentation is normalised. Default 4. */
  tabWidth?: number;
}

const DEFAULT_TAB_WIDTH = 4;

/** `1.2` or `1.2.3` at the head of the task text, with the separator that may follow it. */
const NUMBER_RE = /^(\d+\.\d+(?:\.\d+)?)[.:)]?[ \t]+(.*)$/;

export function parseTasks(content: string, options?: ParseOptions): ParsedTaskFile {
  const tabWidth = Math.max(1, Math.trunc(options?.tabWidth ?? DEFAULT_TAB_WIDTH));
  // A byte-order mark would otherwise hide the first heading behind it.
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);

  /**
   * Fence openers demoted back to prose.
   *
   * In a file people edit by hand an unclosed fence is far more often a typo
   * than an intent to hide the rest of the list, and honouring it would drop
   * every task below it - which lets a change with work left in it report
   * itself finished. Showing an example task that was meant to stay hidden is
   * the cheaper mistake, so the opener is re-read as ordinary content and the
   * oddity is recorded for the change to surface. Each pass demotes one more
   * opener and a demoted line can never open again, so the loop terminates.
   */
  const ignoredFences = new Set<number>();
  const problems: string[] = [];
  let scanned = scan(lines, tabWidth, ignoredFences);
  while (scanned.unterminated !== undefined) {
    problems.push(
      `a code fence opened on line ${scanned.unterminated} is never closed, so the lines below it were read as tasks`,
    );
    ignoredFences.add(scanned.unterminated);
    scanned = scan(lines, tabWidth, ignoredFences);
  }
  const sections = scanned.sections;

  const roots: Task[] = [];
  for (const each of sections) {
    roots.push(...each.tasks);
  }
  const all = flattenTasks(roots);
  const leaves = leafTasks(roots);
  let completed = 0;
  for (const leaf of leaves) {
    if (leaf.state === 'complete') {
      completed++;
    }
  }

  const parsed: ParsedTaskFile = {
    sections,
    progress: makeProgress(completed, leaves.length),
    all,
    leaves,
  };
  if (problems.length > 0) {
    parsed.problems = problems;
  }
  return parsed;
}

interface ScanResult {
  sections: TaskSection[];
  /** One-based line of a fence that was still open at end of file, when there was one. */
  unterminated?: number;
}

/** One pass over the file, treating the fence openers in `ignoredFences` as prose. */
function scan(
  lines: readonly string[],
  tabWidth: number,
  ignoredFences: ReadonlySet<number>,
): ScanResult {
  const sections: TaskSection[] = [];
  /** The section tasks are currently landing in; published on its first task. */
  let section: TaskSection | undefined;
  let published = false;
  /** Open ancestors of the next task, shallowest first. */
  const ancestors: Task[] = [];

  let fenceChar = '';
  let fenceLength = 0;
  let fenceLine = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';

    let start = 0;
    while (start < line.length) {
      const char = line[start];
      if (char !== ' ' && char !== '\t') {
        break;
      }
      start++;
    }
    const first = line[start];

    if (fenceChar !== '') {
      // Inside a fenced block nothing is read; only its closing fence is looked for.
      if (first === fenceChar) {
        const run = runLength(line, start, fenceChar);
        if (run >= fenceLength && isBlankFrom(line, start + run)) {
          fenceChar = '';
          fenceLength = 0;
        }
      }
      continue;
    }

    if (first === '`' || first === '~') {
      const run = runLength(line, start, first);
      if (run >= 3 && !ignoredFences.has(index + 1)) {
        fenceChar = first;
        fenceLength = run;
        fenceLine = index + 1;
      }
      continue;
    }

    if (first === '-' || first === '*') {
      const match = TASK_LINE_RE.exec(line);
      if (!match) {
        continue;
      }
      const task = makeTask(line, match, index + 1, tabWidth);

      // A task attaches to the nearest strictly shallower open task; anything at
      // or beyond its own column has closed.
      while (ancestors.length > 0) {
        const top = ancestors[ancestors.length - 1];
        if (top !== undefined && top.indent < task.indent) {
          break;
        }
        ancestors.pop();
      }
      const parent = ancestors[ancestors.length - 1];
      if (parent !== undefined) {
        parent.children.push(task);
      } else {
        if (section === undefined) {
          section = implicitSection();
          published = false;
        }
        if (!published) {
          sections.push(section);
          published = true;
        }
        section.tasks.push(task);
      }
      ancestors.push(task);
      continue;
    }

    if (first === '#') {
      const heading = readHeading(line, start, index + 1);
      if (heading !== undefined) {
        section = heading;
        published = false;
        ancestors.length = 0;
      }
      continue;
    }

    // Prose, tables, blank lines, HTML: ignored, and never a parse failure.
  }

  return fenceChar === '' ? { sections } : { sections, unterminated: fenceLine };
}

export function markerFor(state: TaskState): string {
  switch (state) {
    case 'complete':
      return 'x';
    case 'in-progress':
      return '-';
    default:
      return ' ';
  }
}

/** Anything outside the grammar reads as pending rather than throwing. */
export function stateFromMarker(marker: string): TaskState {
  const char = marker[0];
  if (char === 'x' || char === 'X') {
    return 'complete';
  }
  if (char === '-' || char === '~') {
    return 'in-progress';
  }
  return 'pending';
}

/**
 * Rewrite the marker of one task line, leaving every other character in place.
 *
 * Undefined means the line is not a task line, which is how the write path
 * detects that `tasks.md` moved underneath it (D11).
 */
export function toggleMarker(rawLine: string, next: TaskState): string | undefined {
  const match = TASK_LINE_RE.exec(rawLine);
  if (!match) {
    return undefined;
  }
  // The grammar fixes the layout: indent, list marker, one space, `[`, marker.
  const at = (match[1] ?? '').length + 3;
  return `${rawLine.slice(0, at)}${markerFor(next)}${rawLine.slice(at + 1)}`;
}

// ---------------------------------------------------------------------------

function implicitSection(): TaskSection {
  // Depth 0 and line 0 are what sorts this section ahead of every heading.
  return { depth: 0, line: 0, tasks: [] };
}

function makeTask(line: string, match: RegExpExecArray, lineNumber: number, tabWidth: number): Task {
  const text = (match[3] ?? '').trimEnd();
  const numbered = NUMBER_RE.exec(text);
  const rest = numbered?.[2]?.trim();

  const task: Task = {
    label: rest !== undefined && rest.length > 0 ? rest : text,
    state: stateFromMarker(match[2] ?? ' '),
    line: lineNumber,
    raw: line,
    indent: expandIndent(match[1] ?? '', tabWidth),
    children: [],
  };
  // A bare `1.2` with nothing after it stays the label: stripping it would
  // leave the task with no text at all.
  if (numbered !== null && rest !== undefined && rest.length > 0) {
    task.number = numbered[1];
  }
  return task;
}

function readHeading(line: string, start: number, lineNumber: number): TaskSection | undefined {
  let index = start;
  while (index < line.length && line[index] === '#') {
    index++;
  }
  const depth = index - start;
  const after = line[index];
  if (depth > 6 || (after !== undefined && after !== ' ' && after !== '\t')) {
    return undefined;
  }
  const title = line.slice(index).trim();
  const section: TaskSection = { depth, line: lineNumber, tasks: [] };
  if (title.length > 0) {
    section.title = title;
  }
  return section;
}

/** Visual column of the list marker, so one tab and four spaces nest identically. */
function expandIndent(indent: string, tabWidth: number): number {
  let column = 0;
  for (let i = 0; i < indent.length; i++) {
    column += indent[i] === '\t' ? tabWidth - (column % tabWidth) : 1;
  }
  return column;
}

function runLength(line: string, start: number, char: string): number {
  let index = start;
  while (index < line.length && line[index] === char) {
    index++;
  }
  return index - start;
}

function isBlankFrom(line: string, start: number): boolean {
  for (let i = start; i < line.length; i++) {
    const char = line[i];
    if (char !== ' ' && char !== '\t' && char !== '\r') {
      return false;
    }
  }
  return true;
}
