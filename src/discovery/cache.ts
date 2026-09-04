/**
 * The discovered root list, held until something that could change it happens.
 *
 * The spec asks for rediscovery when a workspace folder is added or removed,
 * when the additional-roots setting changes, or when the user refreshes - and
 * explicitly *not* when a file inside a known root is edited. In an
 * agent-driven session that last case fires many times a second, so the cache
 * is what keeps a `tasks.md` write from re-walking nine repositories.
 */

import type { OpenSpecRoot } from '../model/types.ts';
import { discoverRoots, type DiscoveryInput } from './roots.ts';

interface Run {
  /** The value of `#generation` when the walk started. */
  generation: number;
  controller: AbortController;
  /** The signal the walk actually observes: the cache's, plus the caller's. */
  signal: AbortSignal;
  promise: Promise<OpenSpecRoot[]>;
}

export class RootCache {
  #roots: OpenSpecRoot[] | undefined;
  #run: Run | undefined;
  /** Bumped by `invalidate`, so a walk that began before it is not kept. */
  #generation = 0;

  /** The last completed discovery, or undefined when none has completed. Not a copy. */
  get current(): OpenSpecRoot[] | undefined {
    return this.#roots;
  }

  get(input: DiscoveryInput): Promise<OpenSpecRoot[]> {
    const cached = this.#roots;
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    const running = this.#run;
    if (running !== undefined) {
      // A second caller joins the walk under way rather than starting its own.
      return running.promise;
    }

    const controller = new AbortController();
    const signal =
      input.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, input.signal]);

    const promise = discoverRoots({ ...input, signal });
    const run: Run = { generation: this.#generation, controller, signal, promise };
    this.#run = run;

    // Bookkeeping is attached after `#run` is set, so the completion handler
    // can never observe a half-registered run. It runs before any caller's
    // continuation, which is what makes `current` valid the moment `get`
    // resolves.
    void promise.then(
      (roots) => this.#finish(run, roots),
      () => this.#finish(run, undefined),
    );
    return promise;
  }

  /**
   * Drop the cached list. A walk already under way keeps running for whoever
   * joined it, but its result is no longer stored: it was started against a
   * workspace that has since changed.
   */
  invalidate(): void {
    this.#generation++;
    this.#roots = undefined;
    this.#run = undefined;
  }

  /** Abort a walk in progress. A list discovered earlier stays valid. */
  cancel(): void {
    this.#run?.controller.abort();
    this.#run = undefined;
  }

  #finish(run: Run, roots: OpenSpecRoot[] | undefined): void {
    if (this.#run === run) {
      this.#run = undefined;
    }
    // A cancelled walk, or one overtaken by an invalidation, may have seen only
    // part of the tree. Its result goes to whoever joined it and no further.
    if (roots !== undefined && run.generation === this.#generation && !run.signal.aborted) {
      this.#roots = roots;
    }
  }
}
