/**
 * Reconstructing a change's progress curve from `git log` (design.md D7).
 *
 * Every revision of a `tasks.md` is a dated measurement that already exists on
 * disk, so the history feature is useful on the first launch instead of a week
 * later. The replay is read-only: it lists the commits that touched the file,
 * reads the file at each of them, and parses each revision with the same parser
 * the live model uses.
 *
 * It runs in the background once the tree has rendered, so it yields between
 * changes and stops at the first look at an aborted signal.
 */

import * as path from 'node:path';

import type { Change, OpenSpecRoot, ParsedTaskFile, ProgressSnapshot } from '../model/types.ts';
import { isPathInside, normalizePath, taskKey, toDateKey } from '../model/keys.ts';
import { parseTasks } from '../model/parser.ts';
import { findRepositoryRoot, isGitAvailable, runGit } from '../util/git.ts';
import { log } from '../util/log.ts';
import type { HistoryStore } from './store.ts';

export interface BackfillResult {
  /** One per readable commit, ascending by author date. Two on one day are collapsed by the store. */
  snapshots: ProgressSnapshot[];
  /** Task key -> the earliest day that task was seen complete in any revision. */
  completions: Record<string, string>;
  /** Commits that touched the file, readable or not. */
  commits: number;
  /** Commits whose blob could not be read: a shallow clone, or the file was deleted at that commit. */
  skipped: number;
  head: string;
}

/** Marks a commit header, so it is never confused with a `--name-status` line. */
const RECORD = '\u0001';

/**
 * Spawning `git show` per commit dominates the cost: 40 of them run serially
 * take about 2 s on Windows, which is the whole budget for one change (D13).
 * Six at a time keeps a 40-commit change well inside it without flooding the
 * machine when several roots are replayed one after another.
 */
const CONCURRENCY = 6;

/** A commit hash is immutable, so a revision is parsed once per session, not once per backfill. */
const revisionCache = new Map<string, ParsedTaskFile>();
const REVISION_CACHE_LIMIT = 4000;

interface Revision {
  sha: string;
  /** Author date, ISO 8601 with offset. */
  iso: string;
  /** The file's path at that commit, which differs from today's after a rename. */
  path: string;
}

/**
 * Replay one change's `tasks.md`.
 *
 * Undefined means the replay could not be attempted at all - git is missing,
 * the file is not inside a repository, or the run was aborted - which the
 * caller reports as history being unavailable rather than as an error.
 */
export async function backfillChange(options: {
  repoRoot: string;
  tasksPath: string;
  tabWidth?: number;
  signal?: AbortSignal;
}): Promise<BackfillResult | undefined> {
  const { tasksPath, tabWidth, signal } = options;
  if (signal?.aborted || !(await isGitAvailable())) {
    return undefined;
  }

  const located = await locate(options.repoRoot, tasksPath);
  if (!located) {
    return undefined;
  }
  const { repoRoot, relative } = located;

  const [revisions, head] = await Promise.all([
    listRevisions(repoRoot, relative, signal),
    readHead(repoRoot, signal),
  ]);
  if (!revisions) {
    return undefined;
  }

  const parsed = new Array<ParsedTaskFile | undefined>(revisions.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!signal?.aborted) {
      const index = next++;
      if (index >= revisions.length) {
        return;
      }
      const revision = revisions[index];
      if (!revision) {
        return;
      }
      parsed[index] = await revisionOf(repoRoot, revision, tabWidth, signal);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(revisions.length, 1)) }, () => worker()),
  );

  if (signal?.aborted) {
    // A partial replay would be recorded as a completed one for this head, so
    // an abandoned run reports nothing at all.
    return undefined;
  }

  const snapshots: ProgressSnapshot[] = [];
  const completions: Record<string, string> = {};
  let skipped = 0;

  for (let index = 0; index < revisions.length; index++) {
    const revision = revisions[index];
    const file = parsed[index];
    if (!revision) {
      continue;
    }
    const at = new Date(revision.iso);
    if (!file || Number.isNaN(at.getTime())) {
      skipped++;
      continue;
    }
    const date = toDateKey(at);
    snapshots.push({
      date,
      completed: file.progress.completed,
      total: file.progress.total,
      source: 'backfilled',
      commit: revision.sha,
    });
    for (const task of file.all) {
      if (task.state !== 'complete') {
        continue;
      }
      const key = taskKey(task.raw);
      const existing = completions[key];
      // Author dates are not monotonic in log order, so the earliest wins explicitly.
      if (existing === undefined || date < existing) {
        completions[key] = date;
      }
    }
  }

  return { snapshots, completions, commits: revisions.length, skipped, head };
}

/**
 * Replay every decomposed change of one root, skipping the ones already
 * replayed at the current head.
 */
export async function backfillRoot(options: {
  root: OpenSpecRoot;
  changes: readonly Change[];
  store: HistoryStore;
  tabWidth?: number;
  signal?: AbortSignal;
  onProgress?: (changeId: string) => void;
}): Promise<void> {
  const { root, changes, store, tabWidth, signal, onProgress } = options;
  if (signal?.aborted) {
    return;
  }
  if (!(await isGitAvailable())) {
    log.info('git is not on PATH, so history is collected from today forward instead of replayed');
    return;
  }
  const repoRoot = await findRepositoryRoot(root.path);
  if (!repoRoot) {
    log.info(`${root.label} is not inside a git repository; history starts from the first observation`);
    return;
  }

  await store.load(root.path);
  const head = await readHead(repoRoot, signal);
  let replayed = 0;

  await log.time(`history backfill for ${root.label}`, async () => {
    for (const change of changes) {
      if (signal?.aborted) {
        return;
      }
      const tasksPath = change.tasksPath;
      if (!tasksPath) {
        // Never decomposed (D5): there is no task file to replay.
        continue;
      }
      if (head.length > 0 && store.history(root.path, change.id)?.backfill?.head === head) {
        continue;
      }

      const result = await backfillChange({ repoRoot, tasksPath, tabWidth, signal });
      if (!result) {
        continue;
      }
      await store.recordBackfill(root.path, change.id, result.snapshots, result.completions, {
        head: result.head,
        commits: result.commits,
      });
      replayed++;
      onProgress?.(change.id);
      // Hand the event loop back between changes: the tree is already on screen
      // and must stay interactive while this runs (D13).
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  });

  if (signal?.aborted) {
    return;
  }
  log.info(`history backfill for ${root.label} covered ${replayed} of ${changes.length} changes`);
  await store.flush();
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

/**
 * The repository to run in and the file's path within it.
 *
 * `git rev-parse` is asked rather than assumed, because a root's own path is
 * not necessarily a repository - under a Stores layout the planning repository
 * is a different one from the code (D14).
 */
async function locate(
  given: string,
  tasksPath: string,
): Promise<{ repoRoot: string; relative: string } | undefined> {
  const detected = await findRepositoryRoot(path.dirname(tasksPath));
  if (!detected) {
    return undefined;
  }
  const candidates =
    isPathInside(tasksPath, given) && isPathInside(given, detected) ? [given, detected] : [detected];

  for (const repoRoot of candidates) {
    const relative = repoRelative(repoRoot, tasksPath);
    if (relative) {
      return { repoRoot, relative };
    }
  }
  return undefined;
}

/** POSIX-separated path of `target` under `repoRoot`, or undefined when it is not under it. */
function repoRelative(repoRoot: string, target: string): string | undefined {
  if (isPathInside(target, repoRoot)) {
    const root = normalizePath(repoRoot);
    const full = normalizePath(target);
    return full.length > root.length ? full.slice(root.length + 1) : undefined;
  }
  // A path that differs only by a symlinked prefix still resolves through `path`.
  const relative = normalizePath(path.relative(repoRoot, target));
  return relative.length === 0 || relative.startsWith('../') ? undefined : relative;
}

async function listRevisions(
  repoRoot: string,
  relative: string,
  signal: AbortSignal | undefined,
): Promise<Revision[] | undefined> {
  // `--follow` carries the replay across a renamed change directory, and
  // `--name-status` reports the file's name at each commit, which is what
  // `git show` needs on the far side of the rename.
  const args = [
    '-c',
    'core.quotepath=false',
    'log',
    `--format=${RECORD}%H%x09%aI`,
    '--follow',
    '--name-status',
    '--',
    relative,
  ];

  let result;
  try {
    result = await runGit(args, { cwd: repoRoot, signal });
  } catch (error) {
    log.warn(`could not list the commits touching ${relative}: ${String(error)}`);
    return undefined;
  }
  if (result.code !== 0) {
    log.info(`no commit history for ${relative}: ${result.stderr.trim() || `exit ${result.code}`}`);
    return undefined;
  }

  const revisions: Revision[] = [];
  let current: Revision | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith(RECORD)) {
      const fields = line.slice(RECORD.length).split('\t');
      const sha = fields[0];
      const iso = fields[1];
      current = sha && iso ? { sha, iso, path: relative } : undefined;
      if (current) {
        revisions.push(current);
      }
      continue;
    }
    if (!current || line.length === 0) {
      continue;
    }
    const fields = line.split('\t');
    const post = fields[fields.length - 1];
    if (fields.length >= 2 && post) {
      // For `R100 old new` the last field is the name after the rename, which is
      // the name the file has at this commit.
      current.path = unquotePath(post);
    }
    // One status line per commit is all this needs; the rest of the block is noise.
    current = undefined;
  }

  // `git log` answers newest first; the record reads forwards.
  return revisions.reverse();
}

async function revisionOf(
  repoRoot: string,
  revision: Revision,
  tabWidth: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ParsedTaskFile | undefined> {
  const key = `${revision.sha}:${revision.path}`;
  const cached = revisionCache.get(key);
  if (cached) {
    return cached;
  }

  let result;
  try {
    result = await runGit(['show', `${revision.sha}:${revision.path}`], { cwd: repoRoot, signal });
  } catch (error) {
    log.warn(`could not read ${revision.path} at ${revision.sha.slice(0, 8)}: ${String(error)}`);
    return undefined;
  }
  if (result.code !== 0) {
    // A shallow clone has no blob, and a commit that deleted the file has none
    // either. Both are ordinary states of a repository, not failures.
    return undefined;
  }

  const parsed = parseTasks(result.stdout, tabWidth === undefined ? undefined : { tabWidth });
  if (revisionCache.size >= REVISION_CACHE_LIMIT) {
    const oldest = revisionCache.keys().next();
    if (!oldest.done) {
      revisionCache.delete(oldest.value);
    }
  }
  revisionCache.set(key, parsed);
  return parsed;
}

/** Empty when there is no commit yet, which makes the "already replayed" check fall through. */
async function readHead(repoRoot: string, signal: AbortSignal | undefined): Promise<string> {
  try {
    const result = await runGit(['rev-parse', 'HEAD'], { cwd: repoRoot, signal, timeoutMs: 5000 });
    return result.code === 0 ? result.stdout.trim() : '';
  } catch {
    return '';
  }
}

/** git quotes a path holding a quote or a control character even with `core.quotepath=false`. */
function unquotePath(value: string): string {
  if (!value.startsWith('"')) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}
