/**
 * A deliberately small YAML reader.
 *
 * The extension needs exactly four scalars out of YAML: `schema` from
 * `openspec/config.yaml`, and `schema` and `created` from a change's
 * `.openspec.yaml`. Both files also carry structure this extension has no
 * business interpreting - `config.yaml` in the reference environment holds a
 * multi-page block scalar and nested rule lists - so the reader takes the
 * top-level scalars and steps over everything else.
 *
 * Pulling in a full YAML parser would buy nothing here and would have to be
 * kept in step with a schema that OpenSpec has not published.
 */

export interface YamlScalars {
  values: Map<string, string>;
  /** Set when the document is not YAML at all, which the caller surfaces on the root. */
  error?: string;
}

const KEY_LINE = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/;

export function readTopLevelScalars(text: string): YamlScalars {
  const values = new Map<string, string>();
  const lines = text.split(/\r?\n/);

  let error: string | undefined;
  let skipIndentedUntilDedent = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';

    if (line.trim().length === 0) {
      continue;
    }

    const indented = /^[ \t]/.test(line);
    if (indented) {
      // Body of a nested mapping, sequence or block scalar. Not our business.
      continue;
    }
    skipIndentedUntilDedent = false;

    const trimmed = line.trimEnd();
    if (trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') {
      continue;
    }
    if (trimmed.startsWith('- ')) {
      // A top-level sequence: a valid document, but not one with named scalars.
      continue;
    }

    const match = KEY_LINE.exec(trimmed);
    if (!match) {
      error ??= `line ${index + 1} is not a key: ${truncate(trimmed)}`;
      continue;
    }

    const key = match[1] ?? '';
    const rawValue = (match[2] ?? '').trim();

    if (rawValue.length === 0 || rawValue.startsWith('|') || rawValue.startsWith('>')) {
      // Nested mapping, sequence or block scalar; the value is not a scalar we read.
      skipIndentedUntilDedent = true;
      continue;
    }

    const value = unquote(stripComment(rawValue));
    if (value === undefined) {
      error ??= `line ${index + 1} has an unterminated quoted value`;
      continue;
    }
    values.set(key, value);
  }

  void skipIndentedUntilDedent;
  return error === undefined ? { values } : { values, error };
}

/** Remove a trailing ` # comment`, respecting quotes. */
function stripComment(value: string): string {
  let quote: string | undefined;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === '\\') {
        i++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && i > 0 && /\s/.test(value[i - 1] ?? '')) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

/** Undefined signals an unterminated quote, which is a genuine parse failure. */
function unquote(value: string): string | undefined {
  const first = value[0];
  if (first !== '"' && first !== "'") {
    return value;
  }
  if (value.length < 2 || !value.endsWith(first)) {
    return undefined;
  }
  const inner = value.slice(1, -1);
  return first === '"' ? inner.replace(/\\(.)/g, '$1') : inner.replace(/''/g, "'");
}

function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

/**
 * Read a `created:` style value into a date.
 *
 * OpenSpec writes `2026-09-04`; a hand-edited file may carry a full timestamp.
 * Anything else is rejected so the caller can fall back to file times and mark
 * the date inferred, rather than showing a wrong date confidently.
 */
export function parseYamlDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    // Local midnight: the change was created on that day in the author's zone.
    const date = new Date(year, month - 1, day);
    if (Number.isNaN(date.getTime())) {
      return undefined;
    }
    // A day that never happened rolls forward into the next month, so
    // `2026-02-31` would otherwise be reported confidently as 2026-03-03.
    const sameDate =
      date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
    return sameDate ? date : undefined;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
