/**
 * When each archived change reached the archive, read from git.
 *
 * `openspec archive` moves a directory. Nothing it writes records the date, and
 * the two cheap answers on disk are both wrong often enough to be worse than
 * silence: a directory's mtime is reset by a fresh clone, and the date in a
 * change's own id is the day it was *created*, which is exactly the figure a
 * reader would misread as the archive date if it were the only one on the row.
 *
 * What is left is the commit that put the files at their archive path, which is
 * an exact answer wherever the history has one. So this asks git, once per root
 * rather than once per change, and reports nothing at all when it cannot — a
 * shallow clone, a project not under version control, or an archive committed
 * before the repository existed all end here with no date rather than a guess.
 *
 * It runs after the archive is already on screen, like the backfill does, so a
 * slow repository delays a date and never the list.
 */

import * as path from 'node:path';

import { normalizePath } from '../model/keys.ts';
import type { OpenSpecRoot } from '../model/types.ts';
import { findRepositoryRoot, isGitAvailable, runGit } from '../util/git.ts';
import { log } from '../util/log.ts';

/** Marks a commit header, so it is never confused with a `--name-only` line. */
const RECORD = '\u0001';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Rename detection is switched off deliberately.
 *
 * Archiving is a pure rename, and git reports it as `R100` by default — which
 * `--diff-filter=A` does not match, so the commit that did the archiving would
 * be the one commit this misses. With `--no-renames` the same commit is a
 * delete beside an add, and the add is at the archive path, which is what is
 * being asked about.
 */
const ARGS_PREFIX = [
  '-c',
  'core.quotepath=false',
  'log',
  '--no-renames',
  '--diff-filter=A',
  `--format=${RECORD}%ad`,
  '--date=short',
  '--name-only',
  '--',
];

export interface ArchiveDatesInput {
  root: OpenSpecRoot;
  signal?: AbortSignal;
}

/**
 * `changeId` -> `YYYY-MM-DD`, for the archived changes git can date.
 *
 * An id missing from the result is an id with no answer, which every caller
 * renders as no date rather than as an unknown one.
 */
export async function readArchiveDates(
  input: ArchiveDatesInput,
): Promise<Record<string, string>> {
  const { root, signal } = input;
  if (signal?.aborted || !(await isGitAvailable())) {
    return {};
  }

  const archiveDir = path.join(root.openspecPath, 'changes', 'archive');
  const repoRoot = await findRepositoryRoot(archiveDir);
  if (repoRoot === undefined) {
    return {};
  }

  // Relative to the repository root and in POSIX form, because that is both
  // what git takes as a pathspec and what it prints back under `--name-only`.
  const prefix = toPosix(path.relative(repoRoot, archiveDir));
  if (prefix.length === 0 || prefix.startsWith('..')) {
    return {};
  }

  let result;
  try {
    result = await runGit([...ARGS_PREFIX, prefix], { cwd: repoRoot, signal });
  } catch (error) {
    log.warn(`could not date the archive under ${prefix}: ${String(error)}`);
    return {};
  }
  if (result.code !== 0) {
    log.info(
      `no archive dates for ${prefix}: ${result.stderr.trim() || `git exited ${result.code}`}`,
    );
    return {};
  }
  if (result.truncated) {
    // Half an answer is still an answer here: every date this did read is
    // exact, and the changes past the cut simply have none.
    log.info(`the archive listing for ${prefix} was truncated; some dates are missing`);
  }

  return parseArchiveDates(result.stdout, prefix);
}

/**
 * The commit listing, folded into one date per change.
 *
 * Exported for its own tests: the parsing is the part that can be wrong, and it
 * should not need a repository to exercise.
 */
export function parseArchiveDates(stdout: string, prefix: string): Record<string, string> {
  const dates: Record<string, string> = {};
  const root = prefix.endsWith('/') ? prefix : `${prefix}/`;
  let current: string | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith(RECORD)) {
      const date = line.slice(RECORD.length).trim();
      current = DATE.test(date) ? date : undefined;
      continue;
    }
    if (current === undefined || line.length === 0) {
      continue;
    }
    const id = changeIdOf(line, root);
    if (id === undefined) {
      continue;
    }
    const existing = dates[id];
    // The earliest add wins: the day the change first reached the archive. A
    // file added to it later is a second, later commit, and dating the archive
    // by that would move the date every time somebody edited a shelved change.
    if (existing === undefined || current < existing) {
      dates[id] = current;
    }
  }

  return dates;
}

/** `openspec/changes/archive/add-cache/tasks.md` -> `add-cache`. */
function changeIdOf(line: string, root: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(root)) {
    return undefined;
  }
  const rest = trimmed.slice(root.length);
  const slash = rest.indexOf('/');
  // A file directly inside `archive/` belongs to no change.
  return slash > 0 ? rest.slice(0, slash) : undefined;
}

function toPosix(value: string): string {
  return normalizePath(value).replace(/\/+$/, '');
}
