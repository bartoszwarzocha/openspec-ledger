/**
 * The overview panel as pure data: one row per change, already decided.
 *
 * The tree puts a change's numbers at the end of its label, where a narrow
 * sidebar truncates them and the eye has to travel to find them. This surface
 * exists to answer "what state is everything in" in one pass, so each change
 * gets two lines - identity above, arithmetic below - and every judgement is
 * made here rather than in the webview, which cannot be unit-tested.
 *
 * Nothing about status is decided in this file: `statusOf` owns that, and the
 * filter and the ordering are the tree's own, imported rather than restated, so
 * the two surfaces can never disagree about which changes exist or what order
 * they come in.
 */

import * as path from 'node:path';

import { changeKey } from '../model/keys.ts';
import { rootStatusOf, statusOf } from '../model/status.ts';
import type {
  Change,
  ChangeStatus,
  LedgerModel,
  Overview,
  OverviewRow,
  Progress,
  Stall,
  TreeOptions,
} from '../model/types.ts';
import { filterChanges, sortChanges } from './nodes.ts';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The right-hand caption: the one fact the numbers beside it cannot carry.
 *
 * For an active change that is `last advanced <date>` whenever history knows it.
 * The count pair on the same line already says how much is left - repeating it
 * as `N tasks left` would spend the caption on arithmetic the reader can do by
 * looking - whereas nothing else on the row says whether the change is moving
 * at all. The remainder is the fallback for a change that has never been seen
 * advancing, which is exactly the case where there is no date to print.
 */
export function noteFor(
  status: ChangeStatus,
  progress: Progress | undefined,
  stall: Stall | undefined,
  lastAdvanced: string | undefined,
): string {
  switch (status) {
    case 'complete':
      return 'ready to archive';
    case 'undecomposed':
      return 'not decomposed';
    case 'stale':
      // `statusOf` reaches this state only from a measured stall, so the guard
      // is for hand-built inputs rather than for anything the model produces.
      return stall ? `stalled ${plural(stall.days, 'day')}` : 'stalled';
    case 'active':
      if (!progress || progress.total === 0) {
        // An empty `tasks.md` is decomposed but has no work in it yet, which is
        // a different sentence from "0 of 0 done".
        return 'no tasks yet';
      }
      return lastAdvanced
        ? `last advanced ${lastAdvanced}`
        : `${plural(progress.total - progress.completed, 'task')} left`;
  }
}

/**
 * Mirrors `changeTarget` in `nodes.ts`: the proposal, else the design, else the
 * change directory. Clicking a change has to land in the same place from either
 * surface; the tree's copy is private, so this one repeats the rule rather than
 * inventing a second one.
 */
function targetPath(change: Change): string {
  if (change.documents.proposal) {
    return path.join(change.path, 'proposal.md');
  }
  if (change.documents.design) {
    return path.join(change.path, 'design.md');
  }
  return change.path;
}

function rowFor(
  change: Change,
  rootPath: string,
  rootLabel: string,
  options: TreeOptions,
): OverviewRow {
  const key = changeKey(rootPath, change.id);
  const stall = options.stalls[key];
  const status = statusOf(change, stall, options.staleAfterDays);
  // An undecomposed change has no denominator, so it gets no progress figure
  // rather than a zero that would read as work not started (design.md D5).
  const progress = change.undecomposed ? undefined : change.taskFile?.progress;

  const row: OverviewRow = {
    rootPath,
    rootLabel,
    changeId: change.id,
    status,
    note: noteFor(status, progress, stall, options.lastAdvanced[key]),
    filePath: targetPath(change),
  };
  if (progress) {
    row.progress = progress;
  }
  if (stall) {
    row.stall = stall;
  }
  return row;
}

/**
 * Every change that survives the filter, in the order the tree would list it.
 *
 * Rows stay grouped by root, in discovery order, with the sort applied inside
 * each group: `sortChanges` ranks within one root because its stall lookup is
 * keyed by root, and a reader moving between the two views should not have to
 * re-learn where a change sits. The root label on each row is what tells the
 * panel when the grouping is worth showing.
 */
export function buildOverview(model: LedgerModel, options: TreeOptions): Overview {
  const rows: OverviewRow[] = [];
  for (const rootModel of model.roots) {
    const rootPath = rootModel.root.path;
    const kept = filterChanges(rootModel.changes, options);
    const sorted = sortChanges(kept, {
      sortMode: options.sortMode,
      stalls: options.stalls,
      rootPath,
    });
    for (const change of sorted) {
      rows.push(rowFor(change, rootPath, rootModel.root.label, options));
    }
  }

  // Counted over the rows rather than over the model, so the header describes
  // the list the reader is actually looking at.
  const overview: Overview = {
    rows,
    totals: rootStatusOf(rows.map((row) => row.status)),
    filter: options.filter,
  };
  if (options.loading) {
    overview.loading = true;
  }
  return overview;
}
