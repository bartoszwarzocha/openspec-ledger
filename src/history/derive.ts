/**
 * What the snapshot record says about a change: how much it moved, when it last
 * moved, and how long it has been still.
 *
 * Pure functions over an already-loaded `ChangeHistory` - the tree derives these
 * for every change on every render, so nothing here touches disk or git.
 */

import type { Change, ChangeHistory, Movement, ProgressSnapshot, Stall } from '../model/types.ts';
import { daysBetween, isComplete, toDateKey } from '../model/keys.ts';

/**
 * Progress at the start of a period against progress now.
 *
 * The current figure comes from the live model rather than from the last
 * snapshot, so movement made minutes ago counts before the day's snapshot has
 * settled.
 */
export function movementSince(
  history: ChangeHistory | undefined,
  since: string,
  change: Change,
): Movement {
  const snapshots = ordered(history);
  const created = change.created ? toDateKey(change.created) : undefined;
  const newInPeriod = created !== undefined && daysBetween(since, created) >= 0;

  const start = lastAtOrBefore(snapshots, since);
  const earliest = snapshots[0];
  const current = change.taskFile?.progress;
  const nowCompleted = current?.completed ?? snapshots[snapshots.length - 1]?.completed ?? 0;

  let startCompleted: number | undefined;
  let startTotal: number | undefined;
  /** The count movement is measured from, which is not always a reportable start. */
  let baseline: number | undefined;

  if (start) {
    startCompleted = start.completed;
    startTotal = start.total;
    baseline = start.completed;
  } else if (newInPeriod) {
    // The change did not exist when the period opened, so everything complete
    // now was completed inside it.
    startCompleted = 0;
    startTotal = earliest?.total ?? current?.total ?? 0;
    baseline = 0;
  } else {
    // History does not reach back that far - a root seen for the first time
    // yesterday, or one outside a git repository. Movement is still counted
    // from the earliest day on record, which is the most that can be said, but
    // no starting figure is reported because none was measured.
    baseline = earliest?.completed;
  }

  const movement: Movement = {
    // A count that fell - a box unticked, a task deleted - is reported as no
    // movement rather than as negative movement.
    completedSince: baseline === undefined ? 0 : Math.max(0, nowCompleted - baseline),
    newInPeriod,
  };
  if (startCompleted !== undefined) {
    movement.startCompleted = startCompleted;
  }
  if (startTotal !== undefined) {
    movement.startTotal = startTotal;
  }
  const advanced = lastAdvanced(history);
  if (advanced !== undefined) {
    movement.lastAdvanced = advanced;
  }
  return movement;
}

/**
 * The date of the last rise in the completed count.
 *
 * The first snapshot is a baseline, not an advance: it is where the record
 * begins, and whatever was already ticked was ticked before it. A change whose
 * count never rose therefore has no last-advanced date, which the stall
 * derivation reads as "measure from creation instead".
 */
export function lastAdvanced(history: ChangeHistory | undefined): string | undefined {
  let previous: number | undefined;
  let advanced: string | undefined;
  for (const snapshot of ordered(history)) {
    if (previous !== undefined && snapshot.completed > previous) {
      advanced = snapshot.date;
    }
    previous = snapshot.completed;
  }
  return advanced;
}

/**
 * Whole days since the change last advanced.
 *
 * Nothing is reported for a change at 100 percent, nor for one that was never
 * decomposed (D5): neither is standing still in a way worth flagging.
 */
export function stallOf(
  history: ChangeHistory | undefined,
  change: Change,
  today: string,
): Stall | undefined {
  const progress = change.taskFile?.progress;
  if (change.undecomposed || !progress || isComplete(progress)) {
    return undefined;
  }

  const advanced = lastAdvanced(history);
  if (advanced !== undefined) {
    return { days: Math.max(0, daysBetween(advanced, today)), fromCreation: false };
  }

  const created = change.created ? toDateKey(change.created) : undefined;
  if (created === undefined) {
    // No advance on record and no creation date: there is no date to measure
    // from, and a made-up one would read as fact.
    return undefined;
  }
  return { days: Math.max(0, daysBetween(created, today)), fromCreation: true };
}

// ---------------------------------------------------------------------------

/** Date keys sort lexicographically, so ordering needs no date arithmetic. */
function ordered(history: ChangeHistory | undefined): readonly ProgressSnapshot[] {
  const snapshots = history?.snapshots ?? [];
  for (let index = 1; index < snapshots.length; index++) {
    if ((snapshots[index]?.date ?? '') < (snapshots[index - 1]?.date ?? '')) {
      return [...snapshots].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
  }
  return snapshots;
}

function lastAtOrBefore(
  snapshots: readonly ProgressSnapshot[],
  date: string,
): ProgressSnapshot | undefined {
  for (let index = snapshots.length - 1; index >= 0; index--) {
    const snapshot = snapshots[index];
    if (snapshot && daysBetween(snapshot.date, date) >= 0) {
      return snapshot;
    }
  }
  return undefined;
}
