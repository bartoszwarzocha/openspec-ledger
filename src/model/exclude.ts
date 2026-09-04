/**
 * Hiding roots and changes the reader does not want counted.
 *
 * A workspace accumulates old and throwaway work: a change abandoned in March,
 * a scratch repository, a planning root somebody else owns. Left in, they sit at
 * the top of the "stalled longest" ordering for ever and the ranking stops
 * meaning anything - which defeats the point of having one.
 *
 * Exclusions are absolute paths rather than names or globs, because that is
 * what the context menu has in its hand when the user clicks Hide, and because
 * a path is unambiguous: two roots can hold a change of the same name.
 */

import { isPathInside } from './keys.ts';
import type { LedgerModel, RootModel } from './types.ts';

/** True when `target`, or a directory containing it, has been hidden. */
export function isExcluded(target: string, excluded: readonly string[]): boolean {
  for (const entry of excluded) {
    const trimmed = entry.trim();
    if (trimmed.length > 0 && isPathInside(target, trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * Drop hidden roots and changes from a built model.
 *
 * Applied once, centrally, so the tree, the overview, the badge, the movement
 * report and every aggregate agree about what exists. A view that filtered for
 * itself would eventually disagree with another that forgot to.
 *
 * Progress figures are NOT recomputed here: `RootModel.progress` is rebuilt by
 * the caller that owns the arithmetic, and quietly re-deriving it in a filter
 * would put the same rule in two places.
 */
export function applyExclusions(model: LedgerModel, excluded: readonly string[]): LedgerModel {
  if (excluded.length === 0) {
    return model;
  }

  const roots: RootModel[] = [];
  for (const rootModel of model.roots) {
    if (isExcluded(rootModel.root.path, excluded)) {
      continue;
    }
    const changes = rootModel.changes.filter((change) => !isExcluded(change.path, excluded));
    roots.push(changes.length === rootModel.changes.length ? rootModel : { ...rootModel, changes });
  }

  return { ...model, roots };
}

/**
 * Add a path to the hidden list, keeping it minimal.
 *
 * Hiding a root makes any of its changes already on the list redundant, and a
 * list that grows a stale entry every time somebody hides a folder is one the
 * user cannot later read and tidy.
 */
export function addExclusion(excluded: readonly string[], target: string): string[] {
  if (isExcluded(target, excluded)) {
    return [...excluded];
  }
  const kept = excluded.filter((entry) => !isPathInside(entry, target));
  return [...kept, target];
}

export function removeExclusion(excluded: readonly string[], target: string): string[] {
  return excluded.filter((entry) => entry.trim() !== target.trim());
}
