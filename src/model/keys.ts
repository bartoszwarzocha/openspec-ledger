/**
 * Pure helpers over the model types: identity keys, progress arithmetic and
 * calendar-day maths. No I/O, no `vscode`.
 */

import type { Progress, Task } from './types.ts';

/** Matches the checkbox prefix of a task line, capturing indent and marker. */
export const TASK_LINE_RE = /^(\s*)[-*] \[([ xX~-])\]\s+(.*)$/;

/**
 * Identity of a task across revisions of `tasks.md`.
 *
 * The marker is deliberately excluded: the whole point is to follow one task
 * from pending to complete, so the key has to survive the tick. Leading
 * whitespace and the list marker go too, and runs of whitespace are collapsed,
 * because re-indenting a task does not make it a different task.
 */
export function taskKey(rawLine: string): string {
  const match = TASK_LINE_RE.exec(rawLine);
  const text = match ? (match[3] ?? '') : rawLine;
  return text.trim().replace(/\s+/g, ' ');
}

/** Identity of a change across roots. */
export function changeKey(rootPath: string, changeId: string): string {
  return `${rootPath}::${changeId}`;
}

/**
 * Build a progress figure.
 *
 * 100 percent is reserved for genuinely complete work: 109 of 110 rounds to 99,
 * not to 100. An empty task list is 0 percent rather than vacuously complete.
 */
export function makeProgress(completed: number, total: number): Progress {
  if (total <= 0) {
    return { completed: 0, total: 0, percent: 0 };
  }
  if (completed >= total) {
    return { completed: total, total, percent: 100 };
  }
  const percent = Math.min(99, Math.round((completed / total) * 100));
  return { completed, total, percent };
}

export function emptyProgress(): Progress {
  return { completed: 0, total: 0, percent: 0 };
}

/** True only when there is at least one task and all of them are complete. */
export function isComplete(progress: Progress | undefined): boolean {
  return !!progress && progress.total > 0 && progress.completed === progress.total;
}

export function sumProgress(parts: Iterable<Progress>): Progress {
  let completed = 0;
  let total = 0;
  for (const part of parts) {
    completed += part.completed;
    total += part.total;
  }
  return makeProgress(completed, total);
}

/** Every task in the tree, parents first, in file order. */
export function flattenTasks(tasks: readonly Task[]): Task[] {
  const out: Task[] = [];
  const walk = (list: readonly Task[]): void => {
    for (const task of list) {
      out.push(task);
      if (task.children.length > 0) {
        walk(task.children);
      }
    }
  };
  walk(tasks);
  return out;
}

/** Only tasks with no children contribute to progress (design.md D4). */
export function leafTasks(tasks: readonly Task[]): Task[] {
  return flattenTasks(tasks).filter((task) => task.children.length === 0);
}

// ---------------------------------------------------------------------------
// Calendar days
//
// Snapshots are per local calendar day. Storing `YYYY-MM-DD` rather than an
// instant keeps "one snapshot per day" trivially true and survives time-zone
// changes on the same machine.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Local midnight of a `YYYY-MM-DD` key. Invalid input yields an invalid Date. */
export function fromDateKey(key: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) {
    return new Date(NaN);
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(fromDateKey(value).getTime());
}

/**
 * Whole days from `from` to `to`, positive when `to` is later.
 *
 * Rounding rather than flooring the millisecond difference keeps this correct
 * across a daylight-saving boundary, where two local midnights are 23 or 25
 * hours apart.
 */
export function daysBetween(from: string, to: string): number {
  const a = fromDateKey(from).getTime();
  const b = fromDateKey(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return 0;
  }
  return Math.round((b - a) / MS_PER_DAY);
}

export function addDays(key: string, days: number): string {
  const date = fromDateKey(key);
  if (Number.isNaN(date.getTime())) {
    return key;
  }
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Forward slashes, no trailing separator. Comparison form, not a display form. */
export function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  return slashed.length > 1 && slashed.endsWith('/') ? slashed.slice(0, -1) : slashed;
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

export function pathKey(p: string): string {
  const normalized = normalizePath(p);
  return CASE_INSENSITIVE ? normalized.toLowerCase() : normalized;
}

export function pathsEqual(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** True when `child` is `parent` or sits beneath it. */
export function isPathInside(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}
