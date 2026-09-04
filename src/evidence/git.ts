/**
 * Git evidence: for each completed task, does a commit exist that corroborates
 * the tick? (design.md D8)
 *
 * The layer is a heuristic and is built to fail towards silence. Three things
 * follow from that and shape the code below:
 *
 * - Only `no-trace` is surfaced, so a search that could not run is reported as
 *   `unknown-date` and says why, rather than as an absence of evidence. A git
 *   command that failed or was cut short must never manufacture a signal.
 * - Every result carries the exact commands that produced it, so the user can
 *   rerun them and disagree.
 * - When the feature is off, nothing here spawns a process. That is an
 *   observable guarantee, so the disabled path returns before any git call.
 *
 * D14: a repository that tracks nothing outside `openspec/` is a planning
 * repository. Its code lives elsewhere, so the layer switches itself off with
 * that reason rather than reporting no trace for every task in it.
 */

import { addDays, isDateKey, pathKey, taskKey } from '../model/keys.ts';
import type {
  Change,
  ChangeGitEvidence,
  ChangeHistory,
  EvidenceState,
  GitEvidenceUnavailable,
  OpenSpecRoot,
  ReferenceMatch,
  Task,
  TaskEvidence,
  TaskReferences,
} from '../model/types.ts';
import { findRepositoryRoot, formatCommand, isGitAvailable, runGit } from '../util/git.ts';
import { log } from '../util/log.ts';
import { extractReferences } from './references.ts';

export interface GitEvidenceInput {
  /** `openspecLedger.gitEvidence.enabled`. False means no git call at all. */
  enabled: boolean;
  root: OpenSpecRoot;
  change: Change;
  /** Backfilled history; without it no completion date is known (design.md D7). */
  history: ChangeHistory | undefined;
  /** Task keys the user has already dismissed for this change. */
  dismissedKeys: readonly string[];
  /** Today as `YYYY-MM-DD`; a completion date later than this cannot be searched. */
  today: string;
  signal?: AbortSignal;
  /** Byte cap on the single window read. Lowered in tests to reach truncation. */
  maxWindowBytes?: number;
}

/** The tick is often some days behind the work, so the window backdates a week. */
const WINDOW_DAYS = 7;

const LOG_LIMIT = 2000;
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const LS_FILES_MAX_BYTES = 256 * 1024;
const PICKAXE_LIMIT = 5;

/**
 * Everything tracked except the specs themselves, at any depth.
 *
 * Git's pathspec wildcards cross directory separators unless `:(glob)` magic is
 * used, so the second pattern covers a root nested anywhere in the repository.
 */
const OUTSIDE_OPENSPEC = ['.', ':(exclude)openspec/*', ':(exclude)*/openspec/*'];

const LS_FILES_ARGS = ['ls-files', '--', ...OUTSIDE_OPENSPEC];
const REV_PARSE_ARGS = ['rev-parse', '--show-toplevel'];

/** Commit id and author date, one commit per line. */
const LOG_HEADER = /^([0-9a-f]{7,64}) (\d{4}-\d{2}-\d{2})$/;

const REASON_TEXT: Record<GitEvidenceUnavailable, string> = {
  disabled:
    'Git evidence is off. Turn on openspecLedger.gitEvidence.enabled to look for commits that corroborate completed tasks.',
  'git-missing':
    'git was not found on PATH, so completed tasks cannot be compared against a commit history.',
  'not-a-repository':
    'This root is not inside a git repository, so there is no commit history to compare completed tasks against.',
  'planning-only':
    'This repository tracks no files outside openspec/, so the code it plans lives in another repository. Nothing here could corroborate a completed task.',
  'no-history':
    'No progress history has been recorded for this change yet, so no completion date is known to search back from.',
};

/** Sentences shown for a search that did not finish, so the gap is legible. */
const TRUNCATED_TEXT =
  'The commit listing reached the size limit this reader accepts, so part of the window was not examined.';
const CANCELLED_TEXT = 'The search was cancelled before it finished.';

function failedText(what: string, code: number | undefined): string {
  return code === undefined
    ? `The ${what} could not be read, so the window was not searched in full.`
    : `The ${what} could not be read (git exited ${code}), so the window was not searched in full.`;
}

export async function evaluateGitEvidence(input: GitEvidenceInput): Promise<ChangeGitEvidence> {
  const changeId = input.change.id;

  // Nothing above this line touches git, and nothing below it runs when the
  // feature is off. That is the whole of the "no git command" guarantee.
  if (!input.enabled) {
    return unavailable(changeId, 'disabled', [], []);
  }

  const completed = completedTasks(input.change);

  if (!(await isGitAvailable())) {
    return unavailable(changeId, 'git-missing', completed, [formatCommand(['--version'])]);
  }

  const repoRoot = await findRepositoryRoot(input.root.path);
  if (repoRoot === undefined) {
    return unavailable(changeId, 'not-a-repository', completed, [formatCommand(REV_PARSE_ARGS)]);
  }

  if (await isPlanningOnlyRepository(repoRoot)) {
    return unavailable(changeId, 'planning-only', completed, [formatCommand(LS_FILES_ARGS)]);
  }

  const history = input.history;
  if (history === undefined) {
    return unavailable(changeId, 'no-history', completed, []);
  }

  const plans = completed.map((task) => makePlan(task, history, input.today));

  // One fetch serves every task: the widest window contains all the others, and
  // git reports newest first, so a narrower window is a prefix of this answer.
  let earliest: string | undefined;
  for (const plan of plans) {
    const from = plan.windowFrom;
    if (from !== undefined && hasReferences(plan.references) && (!earliest || from < earliest)) {
      earliest = from;
    }
  }

  if (earliest === undefined) {
    // Nothing to look for: every completed task is either dateless or wordless.
    return {
      changeId,
      available: true,
      results: plans.map((plan) =>
        evidence(plan, plan.windowFrom === undefined ? 'unknown-date' : 'no-references', [], []),
      ),
      noTrace: [],
    };
  }

  const since = earliest;
  const maxBytes = input.maxWindowBytes ?? LOG_MAX_BYTES;
  const window = await readWindow(repoRoot, since, maxBytes, input.signal);
  const searched = new Map<string, SymbolSearch>();
  const results: TaskEvidence[] = [];

  for (const plan of plans) {
    const windowFrom = plan.windowFrom;
    if (windowFrom === undefined) {
      results.push(evidence(plan, 'unknown-date', [], []));
      continue;
    }
    if (!hasReferences(plan.references)) {
      results.push(evidence(plan, 'no-references', [], []));
      continue;
    }

    // One read serves the whole change, but a result is only reproducible if the
    // commands shown carry this task's own window rather than the widest of them.
    const commands: string[] = [formatCommand(windowArgs(windowFrom))];
    const matches: ReferenceMatch[] = [];
    /** A search that could not be completed must not read as an absence. */
    let incomplete = window.incomplete;

    for (const reference of plan.references.paths) {
      const match = matchPath(window.commits, reference, windowFrom);
      if (match) {
        matches.push(match);
      }
    }

    // The pickaxe is the expensive half, so it runs only for what the free half
    // left unmatched, and at most once per distinct symbol in the change.
    if (matches.length === 0) {
      for (const symbol of plan.references.symbols) {
        if (input.signal?.aborted) {
          incomplete = incomplete ?? CANCELLED_TEXT;
          break;
        }
        let search = searched.get(symbol);
        if (!search) {
          search = await readPickaxe(repoRoot, symbol, since, input.signal);
          searched.set(symbol, search);
        }
        commands.push(formatCommand(pickaxeArgs(symbol, windowFrom)));
        incomplete = incomplete ?? search.incomplete;
        const hit = search.commits.find((commit) => commit.date >= windowFrom);
        if (hit) {
          matches.push({ reference: symbol, kind: 'symbol', commit: hit.sha, date: hit.date });
          break;
        }
      }
    }

    const state: EvidenceState =
      matches.length > 0 ? 'corroborated' : incomplete ? 'unknown-date' : 'no-trace';
    results.push(
      evidence(plan, state, matches, commands, state === 'unknown-date' ? incomplete : undefined),
    );
  }

  // The key is the task's line text, so editing the line lapses its dismissal.
  const dismissed = new Set(input.dismissedKeys);
  const noTrace = results.filter(
    (result) => result.state === 'no-trace' && !dismissed.has(result.taskKey),
  );

  log.info(
    `git evidence for ${changeId}: ${results.length} completed, ${noTrace.length} without a trace, ${searched.size} symbol searches`,
  );

  return { changeId, available: true, results, noTrace };
}

/**
 * True when the repository tracks no file outside `openspec/`.
 *
 * A repository with nothing tracked at all counts too: there is equally nothing
 * in it that could corroborate a task.
 */
export async function isPlanningOnlyRepository(repoRoot: string): Promise<boolean> {
  try {
    const result = await runGit(LS_FILES_ARGS, { cwd: repoRoot, maxBytes: LS_FILES_MAX_BYTES });
    if (result.code !== 0) {
      // An unreadable answer is not evidence of a planning repository, and
      // wrongly disabling the layer is the worse of the two mistakes here.
      log.warn(`git evidence: ${result.command} exited ${result.code}: ${firstLine(result.stderr)}`);
      return false;
    }
    return result.stdout.trim().length === 0;
  } catch (error) {
    log.error(`git evidence: could not list tracked files in ${repoRoot}`, error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-task plan
// ---------------------------------------------------------------------------

interface Plan {
  task: Task;
  key: string;
  references: TaskReferences;
  completedOn?: string;
  windowFrom?: string;
}

function makePlan(task: Task, history: ChangeHistory, today: string): Plan {
  const key = taskKey(task.raw);
  const references = extractReferences(task.label);
  const completedOn = history.completions[key];

  // A date the history does not have, cannot parse, or that sits in the future
  // (clock or time-zone skew) gives no usable window. Searching an empty window
  // would report no trace for a task nothing has actually looked for.
  if (completedOn === undefined || !isDateKey(completedOn) || completedOn > today) {
    return { task, key, references };
  }

  return {
    task,
    key,
    references,
    completedOn,
    windowFrom: addDays(completedOn, -WINDOW_DAYS),
  };
}

/**
 * Every ticked task, parents included.
 *
 * Counting leaves only is a progress rule (design.md D4); evidence is about the
 * text of a line, and a parent is often the line that names the file and the
 * symbol its children only allude to.
 */
function completedTasks(change: Change): Task[] {
  return (change.taskFile?.all ?? []).filter((task) => task.state === 'complete');
}

function hasReferences(references: TaskReferences): boolean {
  return references.paths.length > 0 || references.symbols.length > 0;
}

function evidence(
  plan: Plan,
  state: EvidenceState,
  matches: ReferenceMatch[],
  commands: string[],
  searchIncomplete?: string,
): TaskEvidence {
  return {
    taskKey: plan.key,
    line: plan.task.line,
    label: plan.task.label,
    state,
    references: plan.references,
    completedOn: plan.completedOn,
    windowFrom: plan.windowFrom,
    matches,
    commands,
    searchIncomplete,
  };
}

function unavailable(
  changeId: string,
  reason: GitEvidenceUnavailable,
  tasks: readonly Task[],
  commands: readonly string[],
): ChangeGitEvidence {
  return {
    changeId,
    available: false,
    reason,
    reasonText: REASON_TEXT[reason],
    // No window could be computed for any task, which is what `unknown-date`
    // records. `noTrace` stays empty: a layer that could not look has not found
    // anything missing.
    results: tasks.map((task) => ({
      taskKey: taskKey(task.raw),
      line: task.line,
      label: task.label,
      state: 'unknown-date',
      references: extractReferences(task.label),
      matches: [],
      commands: [...commands],
    })),
    noTrace: [],
  };
}

// ---------------------------------------------------------------------------
// Git reads
// ---------------------------------------------------------------------------

interface WindowCommit {
  sha: string;
  /** Author date, `YYYY-MM-DD`. */
  date: string;
  /** Changed files outside `openspec/`. A commit with none is not kept. */
  files: string[];
}

interface WindowLog {
  commits: WindowCommit[];
  /** Set when the read did not finish; the sentence says why it did not. */
  incomplete?: string;
}

interface CommitStamp {
  sha: string;
  date: string;
}

interface SymbolSearch {
  /** Newest first, capped: the window has no upper end, so the newest decide. */
  commits: CommitStamp[];
  /** Set when the read did not finish; the sentence says why it did not. */
  incomplete?: string;
}

function windowArgs(from: string): string[] {
  return [
    '-c',
    'core.quotePath=false',
    'log',
    `--max-count=${LOG_LIMIT}`,
    `--since=${from}`,
    '--date=short',
    '--format=%H %ad',
    '--name-only',
  ];
}

/**
 * Every commit since `from` with its changed files, in one call.
 *
 * `--since` filters on the commit date while the window is expressed in author
 * dates. Committing never precedes authoring, so this is a superset; the exact
 * bound is applied per task against `%ad`.
 */
async function readWindow(
  repoRoot: string,
  from: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<WindowLog> {
  const args = windowArgs(from);
  const command = formatCommand(args);
  try {
    const result = await runGit(args, { cwd: repoRoot, maxBytes, signal });
    if (result.code !== 0) {
      log.warn(`git evidence: ${command} exited ${result.code}: ${firstLine(result.stderr)}`);
      return { commits: [], incomplete: failedText('commit listing', result.code) };
    }
    const commits = parseWindow(result.stdout);
    // Both caps drop the tail of the history rather than the whole answer, so
    // what came back is a partial window: the tasks it serves are not evaluable,
    // because a commit that was never read cannot be reported as absent.
    if (result.truncated) {
      log.warn(`git evidence: ${command} filled the ${maxBytes} byte buffer; the tail was not read`);
      return { commits, incomplete: TRUNCATED_TEXT };
    }
    if (commits.length >= LOG_LIMIT) {
      log.warn(`git evidence: stopped at ${LOG_LIMIT} commits since ${from}; older ones were not read`);
      return { commits, incomplete: TRUNCATED_TEXT };
    }
    return { commits };
  } catch (error) {
    log.error(`git evidence: ${command} failed`, error);
    return { commits: [], incomplete: failedText('commit listing', undefined) };
  }
}

function parseWindow(stdout: string): WindowCommit[] {
  const commits: WindowCommit[] = [];
  let current: WindowCommit | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    const header = LOG_HEADER.exec(line);
    const sha = header?.[1];
    const date = header?.[2];
    if (sha !== undefined && date !== undefined) {
      current = { sha, date, files: [] };
      commits.push(current);
      continue;
    }
    if (current && !isSpecPath(line)) {
      current.files.push(line);
    }
  }

  // A commit that touched only the specs corroborates nothing, so it is dropped
  // here rather than skipped at every comparison.
  return commits.filter((commit) => commit.files.length > 0);
}

function pickaxeArgs(symbol: string, from: string): string[] {
  return [
    '-c',
    'core.quotePath=false',
    'log',
    `--max-count=${PICKAXE_LIMIT}`,
    `--since=${from}`,
    '--date=short',
    '--format=%H %ad',
    // Attached form: a reference beginning with a dash must not read as an option.
    `-S${symbol}`,
    '--',
    ...OUTSIDE_OPENSPEC,
  ];
}

/** One pickaxe search, restricted to files outside `openspec/`. */
async function readPickaxe(
  repoRoot: string,
  symbol: string,
  from: string,
  signal: AbortSignal | undefined,
): Promise<SymbolSearch> {
  const args = pickaxeArgs(symbol, from);
  const command = formatCommand(args);
  try {
    const result = await runGit(args, { cwd: repoRoot, signal });
    if (result.code !== 0) {
      log.warn(`git evidence: ${command} exited ${result.code}: ${firstLine(result.stderr)}`);
      return { commits: [], incomplete: failedText('symbol search', result.code) };
    }
    return { commits: parseStamps(result.stdout) };
  } catch (error) {
    log.error(`git evidence: ${command} failed`, error);
    return { commits: [], incomplete: failedText('symbol search', undefined) };
  }
}

function parseStamps(stdout: string): CommitStamp[] {
  const commits: CommitStamp[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const header = LOG_HEADER.exec(line);
    const sha = header?.[1];
    const date = header?.[2];
    if (sha !== undefined && date !== undefined) {
      commits.push({ sha, date });
    }
  }
  return commits;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** The newest commit in the window that changed a file named by the reference. */
function matchPath(
  commits: readonly WindowCommit[],
  reference: string,
  from: string,
): ReferenceMatch | undefined {
  const wanted = pathKey(reference);
  for (const commit of commits) {
    if (commit.date < from) {
      continue;
    }
    for (const file of commit.files) {
      const key = pathKey(file);
      // A suffix on a segment boundary: `mod.rs` is not matched by `amod.rs`.
      if (key === wanted || key.endsWith(`/${wanted}`)) {
        return { reference, kind: 'path', commit: commit.sha, date: commit.date };
      }
    }
  }
  return undefined;
}

/** A repository-relative path under an `openspec` directory, at any depth. */
function isSpecPath(file: string): boolean {
  const key = pathKey(file);
  return key.startsWith('openspec/') || key.includes('/openspec/');
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? '';
}
