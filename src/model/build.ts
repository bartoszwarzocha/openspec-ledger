/**
 * Turning a set of discovered roots into the model the rest of the extension
 * reads.
 *
 * The builder is long-lived: it owns the file cache, so a rebuild triggered by
 * one edited `tasks.md` re-reads that file and nothing else (design.md D13).
 */

import * as path from 'node:path';

import type { Change, LedgerModel, OpenSpecRoot, Progress, RootModel } from './types.ts';
import { sumProgress } from './keys.ts';
import { FileCache, listArchivedChangeIds, listChangeIds, readChange } from './changes.ts';
import type { ReadChangeOptions } from './changes.ts';
import * as fsx from '../util/fsx.ts';
import { log } from '../util/log.ts';

export interface BuildOptions {
  /**
   * Also read `openspec/changes/archive/`. Off by default: the archive is only
   * looked at when the reader has asked to see it.
   */
  includeArchived?: boolean;
}

export interface ModelBuilderOptions {
  /** Columns a tab advances in `tasks.md`. Default 4. */
  tabWidth?: number;
  /**
   * Test seam: a cache whose reads can be observed. Production code lets the
   * builder own one, which is what makes an unchanged rebuild free.
   */
  cache?: FileCache;
}

export class ModelBuilder {
  private readonly tabWidth: number | undefined;
  private readonly cache: FileCache;

  constructor(options?: ModelBuilderOptions) {
    this.tabWidth = options?.tabWidth;
    this.cache = options?.cache ?? new FileCache();
  }

  /** Rejects with the signal's reason when cancelled; never for a bad document. */
  build(
    roots: readonly OpenSpecRoot[],
    signal?: AbortSignal,
    options: BuildOptions = {},
  ): Promise<LedgerModel> {
    const archived = options.includeArchived === true;
    const what = archived ? 'model build (with archive)' : 'model build';
    return log.time(`${what} over ${roots.length} root(s)`, async (): Promise<LedgerModel> => {
      const models: RootModel[] = [];
      // Roots are built one at a time so a workspace with fourteen of them does
      // not put every change directory in flight at once.
      for (const root of roots) {
        models.push(await this.buildRoot(root, signal, archived));
      }
      return { roots: models, builtAt: new Date() };
    });
  }

  /** Drop one file from the cache, or the whole cache when nothing is named. */
  invalidate(filePath?: string): void {
    if (filePath === undefined) {
      this.cache.clear();
    } else {
      this.cache.invalidate(filePath);
    }
  }

  private async buildRoot(
    root: OpenSpecRoot,
    signal: AbortSignal | undefined,
    includeArchived: boolean,
  ): Promise<RootModel> {
    signal?.throwIfAborted();

    const problems: string[] = [];
    const ids = await listChangeIds(root);
    if (ids.length === 0 && !(await fsx.isDirectory(path.join(root.openspecPath, 'changes')))) {
      problems.push('this root has no changes directory');
    }

    const options: ReadChangeOptions = {
      tabWidth: this.tabWidth,
      cache: this.cache,
      signal,
    };
    const changes = await Promise.all(ids.map((id) => readChange(root, id, options)));

    const model: RootModel = { root, changes, progress: aggregate(changes), problems };

    // The archive is a record of finished work: it is read only while somebody
    // is looking at it, so a project with three hundred archived changes costs
    // nothing on the path that draws the active list.
    if (includeArchived) {
      signal?.throwIfAborted();
      const archivedIds = await listArchivedChangeIds(root);
      model.archived = await Promise.all(
        archivedIds.map((id) => readChange(root, id, { ...options, archived: true })),
      );
    }

    // Deliberately not folded into `progress`: a root's percentage answers
    // "how far is the work in flight", and archived changes are all finished,
    // so counting them would drag every root towards 100 percent for ever.
    return model;
  }
}

/** D5: an undecomposed change has no denominator, so it joins no aggregate. */
function aggregate(changes: readonly Change[]): Progress {
  const parts: Progress[] = [];
  for (const change of changes) {
    if (!change.undecomposed && change.taskFile !== undefined) {
      parts.push(change.taskFile.progress);
    }
  }
  return sumProgress(parts);
}
