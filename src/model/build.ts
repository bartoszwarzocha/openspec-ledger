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
import { FileCache, listChangeIds, readChange } from './changes.ts';
import type { ReadChangeOptions } from './changes.ts';
import * as fsx from '../util/fsx.ts';
import { log } from '../util/log.ts';

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
  build(roots: readonly OpenSpecRoot[], signal?: AbortSignal): Promise<LedgerModel> {
    return log.time(`model build over ${roots.length} root(s)`, async (): Promise<LedgerModel> => {
      const models: RootModel[] = [];
      // Roots are built one at a time so a workspace with fourteen of them does
      // not put every change directory in flight at once.
      for (const root of roots) {
        models.push(await this.buildRoot(root, signal));
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

  private async buildRoot(root: OpenSpecRoot, signal?: AbortSignal): Promise<RootModel> {
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

    return { root, changes, progress: aggregate(changes), problems };
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
