/**
 * A filesystem walk for the roots the editor's index cannot see.
 *
 * design.md D2 rejects a manual walk for the workspace itself - `findFiles`
 * does that job better and is already cancellable. This walk exists for the two
 * cases the index does not cover: `openspecLedger.additionalRoots`, which by
 * definition points outside every open folder, and the unit tests, which run
 * without an extension host.
 */

import * as path from 'node:path';

import { pathKey } from '../model/keys.ts';
import { isDirectory, isFile, listDirectories } from '../util/fsx.ts';
import { log } from '../util/log.ts';

export interface RootCandidate {
  /** Absolute path of a directory named `openspec`. */
  openspecPath: string;
  /** True when `config.yaml` sits directly inside it. */
  hasConfig: boolean;
}

/**
 * Directories that hold no root worth reporting and are expensive to enter.
 *
 * `vscodeSearch.ts` merges the editor's `files.exclude` and `search.exclude`
 * into the same list; this walk has no settings to read, so this is all it has.
 */
export const DEFAULT_EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'target',
  '.vscode-test',
  '.venv',
  '__pycache__',
  'bin',
  'obj',
];

export interface FsSearchOptions {
  /** Levels below each starting directory. Default 32. */
  maxDepth?: number;
  /** Replaces `DEFAULT_EXCLUDED_DIRS` rather than adding to it. */
  excludedDirs?: readonly string[];
  signal?: AbortSignal;
}

/**
 * Levels below a starting directory.
 *
 * The user named that directory, so the cap is not there to keep the walk
 * shallow - it is there so a symlink cycle or a home directory cannot hang the
 * extension. Deep enough that a real repository layout never reaches it.
 */
const DEFAULT_MAX_DEPTH = 32;

/** Directories read at once. Bounded so a wide tree cannot exhaust file handles. */
const CONCURRENCY = 16;

const OPENSPEC_DIR = 'openspec';

interface Visited {
  candidate?: RootCandidate;
  children: string[];
}

/**
 * Find every `openspec` directory at or beneath `dirs`.
 *
 * Level by level rather than depth-first, so `maxDepth` is a real bound on the
 * work and a shallow root is reported before a deep one is even reached. An
 * aborted signal ends the walk and yields what was found so far, because a
 * cancelled discovery is discarded by its caller anyway.
 */
export async function searchFilesystem(
  dirs: readonly string[],
  options: FsSearchOptions = {},
): Promise<RootCandidate[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const excluded = new Set(
    (options.excludedDirs ?? DEFAULT_EXCLUDED_DIRS).map((name) => name.toLowerCase()),
  );
  const signal = options.signal;

  const found = new Map<string, RootCandidate>();
  /** Guards against overlapping start directories walking the same tree twice. */
  const seen = new Set<string>();

  let level: string[] = [];
  for (const dir of dirs) {
    const start = path.resolve(dir);
    if (seen.has(pathKey(start))) {
      continue;
    }
    seen.add(pathKey(start));
    level.push(start);
  }

  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += CONCURRENCY) {
      if (signal?.aborted) {
        return sortCandidates(found);
      }
      const batch = level.slice(index, index + CONCURRENCY);
      const results = await Promise.all(batch.map((dir) => visit(dir, excluded, signal)));
      for (const result of results) {
        if (result.candidate) {
          found.set(pathKey(result.candidate.openspecPath), result.candidate);
        }
        for (const child of result.children) {
          const key = pathKey(child);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          next.push(child);
        }
      }
    }
    level = next;
  }

  // Depth is the only guard against an accidental cycle, so when it is what
  // ended the walk, a root that never appeared has an explanation in the log.
  const unsearched = level[0];
  if (unsearched !== undefined) {
    const count = `${level.length} ${level.length === 1 ? 'directory' : 'directories'}`;
    log.warn(
      `Search stopped at depth ${maxDepth}, leaving ${count} unsearched, starting with ${unsearched}`,
    );
  }

  return sortCandidates(found);
}

async function visit(
  dir: string,
  excluded: ReadonlySet<string>,
  signal: AbortSignal | undefined,
): Promise<Visited> {
  // Checked here as well as per batch, so a cancellation lands between two
  // directories rather than after the whole batch it arrived in.
  if (signal?.aborted) {
    return { children: [] };
  }
  if (path.basename(dir).toLowerCase() === OPENSPEC_DIR) {
    const candidate = await describeRoot(dir);
    // An `openspec` directory is a leaf either way: a root that happens to sit
    // inside another root's `changes/` is a fixture or a copy, not a second root.
    return candidate ? { candidate, children: [] } : { children: [] };
  }

  const children: string[] = [];
  for (const name of await listDirectories(dir)) {
    // The exclusion list applies to what the walk descends into, never to a
    // directory the user pointed at explicitly.
    if (excluded.has(name.toLowerCase())) {
      continue;
    }
    children.push(path.join(dir, name));
  }
  return { children };
}

/** The accept rule of the spec: a `config.yaml` file or a `changes` directory. */
async function describeRoot(openspecPath: string): Promise<RootCandidate | undefined> {
  const [hasConfig, hasChanges] = await Promise.all([
    isFile(path.join(openspecPath, 'config.yaml')),
    isDirectory(path.join(openspecPath, 'changes')),
  ]);
  return hasConfig || hasChanges ? { openspecPath, hasConfig } : undefined;
}

function sortCandidates(found: ReadonlyMap<string, RootCandidate>): RootCandidate[] {
  return [...found.values()].sort((a, b) =>
    pathKey(a.openspecPath).localeCompare(pathKey(b.openspecPath)),
  );
}
