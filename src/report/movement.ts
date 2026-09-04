/**
 * The movement report: what advanced in a period, what did not, and how long
 * the still ones have been still.
 *
 * The generator is pure - the model and a history lookup go in, a report comes
 * out - and the rendering is a second pure step over that report, so both are
 * testable without an extension host and the command layer only has to open the
 * resulting text in an editor.
 *
 * The derivation defaults to `history/derive.ts` but can be supplied, which is
 * how the report is exercised against fixed movements and stalls rather than
 * against a history store.
 */

import { movementSince, stallOf } from '../history/derive.ts';
import { addDays, isComplete, makeProgress } from '../model/keys.ts';
import type {
  Change,
  ChangeHistory,
  LedgerModel,
  Movement,
  MovementReport,
  ReportRow,
  Stall,
} from '../model/types.ts';

export interface MovementReportInput {
  model: LedgerModel;
  /** Length of the period in days; the command defaults to 7. */
  days: number;
  /** Upper bound of the period, `YYYY-MM-DD`. */
  today: string;
  historyFor: (rootPath: string, changeId: string) => ChangeHistory | undefined;
  derive?: { movementSince: typeof movementSince; stallOf: typeof stallOf };
}

const DEFAULT_DERIVATION = { movementSince, stallOf };

export function buildMovementReport(input: MovementReportInput): MovementReport {
  const derive = input.derive ?? DEFAULT_DERIVATION;
  // A period of zero or fewer days would silently report nothing at all, which
  // the reader could not tell apart from a quiet week.
  const days = Number.isFinite(input.days) ? Math.max(1, Math.trunc(input.days)) : 1;
  const since = addDays(input.today, -days);

  const moved: ReportRow[] = [];
  const didNotMove: ReportRow[] = [];
  const undecomposed: Array<{ rootLabel: string; changeId: string }> = [];

  for (const rootModel of input.model.roots) {
    const rootLabel = rootModel.root.label;
    for (const change of rootModel.changes) {
      if (change.undecomposed) {
        // Zero percent would read as work not started; the truth is a proposal
        // that was never decomposed (design.md D5).
        undecomposed.push({ rootLabel, changeId: change.id });
        continue;
      }
      const history = input.historyFor(change.rootPath, change.id);
      const movement = derive.movementSince(history, since, change);
      const complete = isComplete(change.taskFile?.progress);
      // A change at 100 percent is never stalled, so the report does not ask.
      const stall = complete ? undefined : derive.stallOf(history, change, input.today);
      const row = buildRow(rootLabel, change, movement, stall, complete);
      (row.completedInPeriod > 0 ? moved : didNotMove).push(row);
    }
  }

  moved.sort(byMovementDescending);
  didNotMove.sort(byStallDescending);

  return {
    since,
    generatedFor: input.today,
    days,
    moved,
    didNotMove,
    undecomposed,
  };
}

function buildRow(
  rootLabel: string,
  change: Change,
  movement: Movement,
  stall: Stall | undefined,
  complete: boolean,
): ReportRow {
  const progress = change.taskFile?.progress;
  // A change created inside the period has no earlier snapshot to read, and its
  // start is a known zero rather than an unknown.
  const start = movement.newInPeriod
    ? { completed: movement.startCompleted ?? 0, total: movement.startTotal ?? 0 }
    : { completed: movement.startCompleted, total: movement.startTotal };
  return {
    rootLabel,
    rootPath: change.rootPath,
    changeId: change.id,
    startCompleted: start.completed,
    startTotal: start.total,
    nowCompleted: progress?.completed ?? 0,
    nowTotal: progress?.total ?? 0,
    completedInPeriod: movement.completedSince,
    stall,
    newInPeriod: movement.newInPeriod,
    complete,
  };
}

function byMovementDescending(a: ReportRow, b: ReportRow): number {
  return b.completedInPeriod - a.completedInPeriod || byName(a, b);
}

function byStallDescending(a: ReportRow, b: ReportRow): number {
  return stallDays(b) - stallDays(a) || byName(a, b);
}

/** Rows with no stall figure sort last: there is nothing to rank them by. */
function stallDays(row: ReportRow): number {
  return row.stall?.days ?? -1;
}

function byName(a: ReportRow, b: ReportRow): number {
  return a.rootLabel.localeCompare(b.rootLabel) || a.changeId.localeCompare(b.changeId);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const HEADERS = ['Change', 'Root', 'Start', 'Now', 'Done in period', 'Stalled'] as const;

const UNKNOWN = '-';

// The markers are named rather than shown: a line opening with `-` or `*` is a
// list item, and markdown would swallow the very character being explained.
function startFootnote(since: string): string {
  return `A dash under Start means the recorded history does not reach back to ${since}.`;
}

const STALL_FOOTNOTE =
  'An asterisk after a stall figure means it is measured from the change\'s creation ' +
  'date, because the change has not advanced since.';

export function renderMovementReport(report: MovementReport): string {
  const lines: string[] = ['# Movement report', '', headerLine(report), ''];

  lines.push(
    ...section(
      `Moved (${report.moved.length})`,
      report.moved,
      'No change advanced in this period.',
    ),
  );
  lines.push(
    ...section(
      `Did not move (${report.didNotMove.length})`,
      report.didNotMove,
      'Every change advanced in this period.',
      'Ordered by days stalled, longest first.',
    ),
  );

  if (report.undecomposed.length > 0) {
    lines.push(`## Not decomposed (${report.undecomposed.length})`, '');
    lines.push(
      'These changes have no `tasks.md`, so there is no progress to measure. They are',
      'listed here rather than counted at zero percent.',
      '',
    );
    for (const entry of report.undecomposed) {
      lines.push(`- ${entry.changeId} (${entry.rootLabel})`);
    }
    lines.push('');
  }

  const rows = [...report.moved, ...report.didNotMove];
  const footnotes: string[] = [];
  if (rows.some((row) => row.startCompleted === undefined || row.startTotal === undefined)) {
    footnotes.push(startFootnote(report.since));
  }
  if (rows.some((row) => row.stall?.fromCreation)) {
    footnotes.push(STALL_FOOTNOTE);
  }
  if (footnotes.length > 0) {
    lines.push(...footnotes.flatMap((note) => [note, '']));
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function headerLine(report: MovementReport): string {
  const roots = distinctRootLabels(report);
  const span = plural(report.days, 'day');
  const period = `Period ${report.since} to ${report.generatedFor} (${span}).`;
  return roots.length > 0 ? `${period} Roots: ${roots.join(', ')}.` : `${period} No roots covered.`;
}

/**
 * The roots covered, in first-seen order across the report. Taken from the rows
 * because the report itself carries no root list.
 */
function distinctRootLabels(report: MovementReport): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  const add = (label: string): void => {
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  };
  for (const row of report.moved) {
    add(row.rootLabel);
  }
  for (const row of report.didNotMove) {
    add(row.rootLabel);
  }
  for (const entry of report.undecomposed) {
    add(entry.rootLabel);
  }
  return labels;
}

function section(
  title: string,
  rows: readonly ReportRow[],
  emptyText: string,
  note?: string,
): string[] {
  const lines = [`## ${title}`, ''];
  if (note && rows.length > 0) {
    lines.push(note, '');
  }
  if (rows.length === 0) {
    lines.push(emptyText, '');
    return lines;
  }
  lines.push(...renderTable(HEADERS, rows.map(renderRow)), '');
  return lines;
}

function renderRow(row: ReportRow): string[] {
  return [
    row.newInPeriod ? `${row.changeId} (new)` : row.changeId,
    row.rootLabel,
    progressCell(row.startCompleted, row.startTotal),
    progressCell(row.nowCompleted, row.nowTotal),
    `${row.completedInPeriod}`,
    stallCell(row),
  ];
}

function progressCell(completed: number | undefined, total: number | undefined): string {
  if (completed === undefined || total === undefined) {
    return UNKNOWN;
  }
  return `${completed}/${total} (${makeProgress(completed, total).percent}%)`;
}

function stallCell(row: ReportRow): string {
  if (row.stall) {
    return `${plural(row.stall.days, 'day')}${row.stall.fromCreation ? ' *' : ''}`;
  }
  return row.complete ? 'complete' : 'not known';
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * A markdown table padded to a common width per column, so it reads as a table
 * in a plain-text editor and not only after rendering.
 */
function renderTable(headers: readonly string[], rows: readonly string[][]): string[] {
  const cells = rows.map((row) => row.map(escapeCell));
  const widths = headers.map((header, index) =>
    cells.reduce((width, row) => Math.max(width, (row[index] ?? '').length), header.length),
  );
  const line = (values: readonly string[]): string =>
    `| ${widths.map((width, index) => (values[index] ?? '').padEnd(width)).join(' | ')} |`;
  // Three dashes is the minimum a markdown parser accepts for a column rule.
  const rule = `| ${widths.map((width) => '-'.repeat(Math.max(3, width))).join(' | ')} |`;
  return [line(headers), rule, ...cells.map(line)];
}

/** A pipe or a newline inside a label would break the table apart. */
function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}
