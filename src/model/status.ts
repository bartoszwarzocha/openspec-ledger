/**
 * The one place that decides what state a change is in.
 *
 * Both surfaces read it - the tree paints an icon from it, the overview paints
 * a row - and they have to agree, because a reader who sees a green tick in one
 * and a warning in the other stops trusting both.
 */

import { isComplete } from './keys.ts';
import type { Change, ChangeStatus, RootStatus, Stall } from './types.ts';

/** Days without advancing after which a change is called stale. */
export const DEFAULT_STALE_AFTER_DAYS = 30;

/**
 * Order of precedence, and why:
 *
 * 1. Undecomposed first. It has no denominator, so no other question applies.
 * 2. Complete next. Finished work is never stale, however long it has sat -
 *    what it is waiting for is archiving, not attention.
 * 3. Stale last, and only against a threshold the user can move or switch off.
 */
export function statusOf(
  change: Change,
  stall: Stall | undefined,
  staleAfterDays: number = DEFAULT_STALE_AFTER_DAYS,
): ChangeStatus {
  if (change.undecomposed) {
    return 'undecomposed';
  }
  if (isComplete(change.taskFile?.progress)) {
    return 'complete';
  }
  if (staleAfterDays > 0 && stall !== undefined && stall.days >= staleAfterDays) {
    return 'stale';
  }
  return 'active';
}

/**
 * What a root's own row should say.
 *
 * A root is green only when everything under it is finished, and carries the
 * warning as soon as one change is stale: the badge exists to stop the reader
 * expanding fourteen roots to find the one that needs them. An empty root is
 * reported as active rather than complete - nothing has been finished there.
 */
export function rootStatusOf(statuses: readonly ChangeStatus[]): RootStatus {
  const counts: RootStatus = {
    status: 'active',
    complete: 0,
    stale: 0,
    active: 0,
    undecomposed: 0,
  };
  for (const status of statuses) {
    counts[status] += 1;
  }

  const decomposed = counts.complete + counts.stale + counts.active;
  if (counts.stale > 0) {
    counts.status = 'stale';
  } else if (decomposed > 0 && counts.complete === decomposed) {
    counts.status = 'complete';
  } else if (decomposed === 0 && counts.undecomposed > 0) {
    counts.status = 'undecomposed';
  }
  return counts;
}
