import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeProgress, taskKey } from '../model/keys.ts';
import type {
  Change,
  ChangeHistory,
  OpenSpecRoot,
  ParsedTaskFile,
  Task,
  TaskEvidence,
} from '../model/types.ts';
import { resetGitCaches } from '../util/git.ts';
import { evaluateGitEvidence, isPlanningOnlyRepository } from './git.ts';

const CHANGE_ID = 'add-lookup-provider';
const COMPLETED_ON = '2026-08-21';
const WINDOW_FROM = '2026-08-14';
const TODAY = '2026-08-25';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let gitPresent: boolean | undefined;

function hasGit(): boolean {
  if (gitPresent === undefined) {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      gitPresent = true;
    } catch {
      gitPresent = false;
    }
  }
  return gitPresent;
}

/** Skips rather than fails where git is not installed. */
function gitTest(name: string, run: () => Promise<void>): void {
  test(name, async (t) => {
    if (!hasGit()) {
      t.skip('git is not on PATH');
      return;
    }
    await run();
  });
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

function commit(cwd: string, message: string, date: string): void {
  const stamp = `${date}T12:00:00`;
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message], { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp });
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-ledger-evidence-'));
  // git reports the resolved path, and the temp directory is a link on macOS.
  return fs.realpath(dir);
}

async function removeTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A locked object file under .git is not worth failing a passing test over.
  }
}

async function write(dir: string, relative: string, contents: string): Promise<void> {
  const target = path.join(dir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main', '.']);
  git(dir, ['config', 'user.name', 'Ledger Test']);
  git(dir, ['config', 'user.email', 'ledger@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
}

function leaf(number: string, label: string, line: number): Task {
  return {
    number,
    label,
    state: 'complete',
    line,
    raw: `- [x] ${number} ${label}`,
    indent: 0,
    children: [],
  };
}

function parent(number: string, label: string, line: number, children: Task[]): Task {
  return { ...leaf(number, label, line), children };
}

/** One task per scenario in the spec, all of them ticked. */
const TASKS: Task[] = [
  leaf('1.1', 'Create `src/provider/mod.rs`', 3),
  leaf('1.2', 'Add the `LookupProvider` trait', 4),
  leaf('1.3', 'Record the outcome in `openspec/notes.md`', 5),
  leaf('1.4', 'Handle the `SpecOnlyMarker` case', 6),
  leaf('1.5', 'Wire `src/absent/nothing.rs` to `NeverSeenSymbol`', 7),
  leaf('1.6', 'Write unit tests for the happy path', 8),
  leaf('1.7', 'Ship `src/provider/mod.rs` behind a flag', 9),
];

const TASKS_MD = ['# Tasks', '', '## 1. Work', ...TASKS.map((task) => task.raw), ''].join('\n');

function makeRoot(dir: string): OpenSpecRoot {
  return {
    path: dir,
    openspecPath: path.join(dir, 'openspec'),
    label: 'fixture',
    hasConfig: true,
    fromSettings: false,
  };
}

function makeChange(dir: string, tasks: Task[], leaves: Task[] = tasks): Change {
  const taskFile: ParsedTaskFile = {
    sections: [{ title: '1. Work', depth: 2, line: 3, tasks }],
    progress: makeProgress(leaves.length, leaves.length),
    all: tasks,
    leaves,
  };
  return {
    id: CHANGE_ID,
    path: path.join(dir, 'openspec', 'changes', CHANGE_ID),
    rootPath: dir,
    documents: { proposal: true, design: false, tasks: true, specs: false },
    createdInferred: true,
    tasksPath: path.join(dir, 'openspec', 'changes', CHANGE_ID, 'tasks.md'),
    taskFile,
    undecomposed: false,
    problems: [],
  };
}

/** Every task but the last one has a recorded completion date. */
function makeHistory(tasks: Task[]): ChangeHistory {
  const completions: Record<string, string> = {};
  for (const task of tasks.slice(0, -1)) {
    completions[taskKey(task.raw)] = COMPLETED_ON;
  }
  return {
    changeId: CHANGE_ID,
    snapshots: [{ date: COMPLETED_ON, completed: tasks.length, total: tasks.length, source: 'backfilled' }],
    completions,
  };
}

/** A history dating exactly the tasks given, so a test can vary the windows. */
function historyOf(entries: ReadonlyArray<readonly [Task, string]>): ChangeHistory {
  const completions: Record<string, string> = {};
  for (const [task, date] of entries) {
    completions[taskKey(task.raw)] = date;
  }
  return { changeId: CHANGE_ID, snapshots: [], completions };
}

/**
 * A repository holding the change's specs and one source file, committed
 * separately so a specs-only commit exists in the window.
 */
async function makeWorkedRepo(): Promise<{ dir: string; specCommit: string; codeCommit: string }> {
  const dir = await makeTempDir();
  initRepo(dir);

  await write(dir, `openspec/changes/${CHANGE_ID}/tasks.md`, TASKS_MD);
  await write(dir, 'openspec/notes.md', 'Notes about the change.\n');
  commit(dir, 'plan the change', '2026-08-19');
  const specCommit = git(dir, ['rev-parse', 'HEAD']).trim();

  await write(dir, 'src/provider/mod.rs', 'pub trait LookupProvider {}\n');
  commit(dir, 'add the provider', '2026-08-20');
  const codeCommit = git(dir, ['rev-parse', 'HEAD']).trim();

  return { dir, specCommit, codeCommit };
}

function byLine<T extends TaskEvidence>(results: readonly T[], line: number): T {
  const found = results.find((result) => result.line === line);
  assert.ok(found, `no result for line ${line}`);
  return found;
}

interface SpawnMeter {
  /** Argument vectors of every child process started while the meter was on. */
  stop: () => string[][];
}

function meterSpawns(): SpawnMeter {
  const started: Array<{ spawnargs?: unknown }> = [];
  const listener = (message: unknown): void => {
    const child = (message as { process?: { spawnargs?: unknown } }).process;
    if (child) {
      started.push(child);
    }
  };
  subscribe('child_process', listener);
  return {
    stop: () => {
      unsubscribe('child_process', listener);
      // The channel publishes before `spawnargs` is filled in, so it is read here.
      return started.map((child) =>
        Array.isArray(child.spawnargs) ? child.spawnargs.map((arg) => String(arg)) : [],
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

gitTest('completed tasks are classified against the commits in their window', async () => {
  const { dir, codeCommit } = await makeWorkedRepo();
  try {
    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, TASKS),
      history: makeHistory(TASKS),
      dismissedKeys: [],
      today: TODAY,
    });

    assert.equal(evidence.available, true);
    assert.equal(evidence.reason, undefined);
    assert.equal(evidence.results.length, TASKS.length);

    const path1 = byLine(evidence.results, 3);
    assert.equal(path1.state, 'corroborated');
    assert.deepEqual(path1.references, { paths: ['src/provider/mod.rs'], symbols: [] });
    assert.equal(path1.completedOn, COMPLETED_ON);
    assert.equal(path1.windowFrom, WINDOW_FROM);
    assert.deepEqual(path1.matches, [
      { reference: 'src/provider/mod.rs', kind: 'path', commit: codeCommit, date: '2026-08-20' },
    ]);

    const symbol = byLine(evidence.results, 4);
    assert.equal(symbol.state, 'corroborated');
    assert.deepEqual(symbol.matches, [
      { reference: 'LookupProvider', kind: 'symbol', commit: codeCommit, date: '2026-08-20' },
    ]);

    // The file exists, but only in a commit that touched nothing else.
    const specOnlyPath = byLine(evidence.results, 5);
    assert.equal(specOnlyPath.state, 'no-trace');
    assert.deepEqual(specOnlyPath.matches, []);

    // The symbol exists, but only inside tasks.md.
    const specOnlySymbol = byLine(evidence.results, 6);
    assert.equal(specOnlySymbol.state, 'no-trace');

    const nothingMatched = byLine(evidence.results, 7);
    assert.equal(nothingMatched.state, 'no-trace');
    assert.deepEqual(nothingMatched.references, {
      paths: ['src/absent/nothing.rs'],
      symbols: ['NeverSeenSymbol'],
    });

    assert.equal(byLine(evidence.results, 8).state, 'no-references');
    assert.equal(byLine(evidence.results, 9).state, 'unknown-date');
    assert.equal(byLine(evidence.results, 9).windowFrom, undefined);

    assert.deepEqual(
      evidence.noTrace.map((result) => result.line),
      [5, 6, 7],
    );
  } finally {
    await removeTempDir(dir);
  }
});

gitTest('a no-trace result carries the window and the commands that produced it', async () => {
  const { dir } = await makeWorkedRepo();
  try {
    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, TASKS),
      history: makeHistory(TASKS),
      dismissedKeys: [],
      today: TODAY,
    });

    const result = byLine(evidence.noTrace, 7);
    assert.equal(result.windowFrom, WINDOW_FROM);
    assert.ok(result.commands.length >= 2, 'the log and the pickaxe should both be recorded');
    for (const command of result.commands) {
      assert.match(command, /^git /);
      assert.ok(command.includes(`--since=${WINDOW_FROM}`), command);
    }
    assert.ok(
      result.commands.some((command) => command.includes('-SNeverSeenSymbol')),
      'the pickaxe for the unmatched symbol should be shown',
    );
  } finally {
    await removeTempDir(dir);
  }
});

gitTest('a dismissed task is not surfaced again', async () => {
  const { dir } = await makeWorkedRepo();
  try {
    const dismissed = TASKS.find((task) => task.line === 7);
    assert.ok(dismissed);
    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, TASKS),
      history: makeHistory(TASKS),
      dismissedKeys: [taskKey(dismissed.raw)],
      today: TODAY,
    });

    assert.deepEqual(
      evidence.noTrace.map((result) => result.line),
      [5, 6],
    );
    // Dismissing hides the signal without hiding the finding from the record.
    assert.equal(byLine(evidence.results, 7).state, 'no-trace');
  } finally {
    await removeTempDir(dir);
  }
});

gitTest('the window is read once per change and the pickaxe only where needed', async () => {
  const { dir } = await makeWorkedRepo();
  const meter = meterSpawns();
  try {
    await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, TASKS),
      history: makeHistory(TASKS),
      dismissedKeys: [],
      today: TODAY,
    });

    const calls = meter.stop();
    const logs = calls.filter((args) => args.includes('--name-only'));
    assert.equal(logs.length, 1, 'the changed-file listing should be fetched once');

    const pickaxes = calls.filter((args) => args.some((arg) => arg.startsWith('-S')));
    assert.deepEqual(
      pickaxes.map((args) => args.find((arg) => arg.startsWith('-S'))).sort(),
      ['-SLookupProvider', '-SNeverSeenSymbol', '-SSpecOnlyMarker'],
      'a symbol already matched by a path, or already searched, is not searched again',
    );
  } finally {
    meter.stop();
    await removeTempDir(dir);
  }
});

gitTest('a completion date in the future is not searched', async () => {
  const { dir } = await makeWorkedRepo();
  try {
    const tasks = TASKS.slice(0, 1);
    const history: ChangeHistory = {
      changeId: CHANGE_ID,
      snapshots: [],
      completions: { [taskKey(tasks[0]?.raw ?? '')]: '2027-01-01' },
    };
    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, tasks),
      history,
      dismissedKeys: [],
      today: TODAY,
    });

    assert.equal(byLine(evidence.results, 3).state, 'unknown-date');
    assert.deepEqual(evidence.noTrace, []);
  } finally {
    await removeTempDir(dir);
  }
});

gitTest('a completed parent task is evaluated, not only its leaves', async () => {
  const { dir, codeCommit } = await makeWorkedRepo();
  try {
    // The parent is the line naming the file; its child only says what it did.
    const child = leaf('3.1', 'Write unit tests for the happy path', 11);
    const hook = parent('3', 'Hook `src/provider/mod.rs` into the router', 10, [child]);

    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, [hook, child], [child]),
      history: historyOf([
        [hook, COMPLETED_ON],
        [child, COMPLETED_ON],
      ]),
      dismissedKeys: [],
      today: TODAY,
    });

    assert.equal(evidence.results.length, 2);
    const result = byLine(evidence.results, 10);
    assert.equal(result.state, 'corroborated');
    assert.deepEqual(result.matches, [
      { reference: 'src/provider/mod.rs', kind: 'path', commit: codeCommit, date: '2026-08-20' },
    ]);
    assert.equal(byLine(evidence.results, 11).state, 'no-references');
  } finally {
    await removeTempDir(dir);
  }
});

gitTest('the commands shown carry the window of that task, not the widest one', async () => {
  const { dir } = await makeWorkedRepo();
  try {
    const earlier = leaf('1.1', 'Wire `src/absent/early.rs`', 3);
    const later = leaf('1.2', 'Wire `src/absent/nothing.rs` to `NeverSeenSymbol`', 4);

    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, [earlier, later]),
      history: historyOf([
        [earlier, '2026-08-16'],
        [later, COMPLETED_ON],
      ]),
      dismissedKeys: [],
      today: TODAY,
    });

    // The earlier task widens the single read; that must not widen what the
    // later one shows, or rerunning its commands answers a different question.
    const result = byLine(evidence.noTrace, 4);
    assert.equal(result.windowFrom, WINDOW_FROM);
    assert.ok(result.commands.length >= 2);
    for (const command of result.commands) {
      assert.ok(command.includes(`--since=${WINDOW_FROM}`), command);
    }
    for (const command of byLine(evidence.noTrace, 3).commands) {
      assert.ok(command.includes('--since=2026-08-09'), command);
    }
  } finally {
    await removeTempDir(dir);
  }
});

gitTest('a git read that failed is not reported as a missing completion date', async () => {
  const dir = await makeTempDir();
  try {
    initRepo(dir);
    await write(dir, `openspec/changes/${CHANGE_ID}/tasks.md`, TASKS_MD);
    await write(dir, 'src/provider/mod.rs', 'pub trait LookupProvider {}\n');
    // Staged and never committed: the code is tracked, so the layer stays on,
    // but there is no branch for `git log` to walk and it exits non-zero.
    git(dir, ['add', '-A']);

    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, TASKS),
      history: makeHistory(TASKS),
      dismissedKeys: [],
      today: TODAY,
    });

    const result = byLine(evidence.results, 3);
    assert.equal(result.state, 'unknown-date');
    // The date is known; it is the search that did not happen.
    assert.equal(result.completedOn, COMPLETED_ON);
    assert.match(result.searchIncomplete ?? '', /could not be read/);
    assert.equal(byLine(evidence.results, 9).searchIncomplete, undefined);
    assert.deepEqual(evidence.noTrace, []);
  } finally {
    await removeTempDir(dir);
  }
});

gitTest('a window read cut short at the byte cap reports no trace for nothing', async () => {
  const { dir } = await makeWorkedRepo();
  try {
    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, TASKS),
      history: makeHistory(TASKS),
      dismissedKeys: [],
      today: TODAY,
      maxWindowBytes: 64,
    });

    // Line 7 names a file and a symbol no commit touched, but the listing that
    // would have shown one was only partly read, so nothing was established.
    const result = byLine(evidence.results, 7);
    assert.equal(result.state, 'unknown-date');
    assert.match(result.searchIncomplete ?? '', /size limit/);
    assert.deepEqual(evidence.noTrace, []);
  } finally {
    await removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Unavailable states
// ---------------------------------------------------------------------------

test('the disabled layer runs no git command at all', async () => {
  // A directory that does not exist: nothing here may reach the filesystem either.
  const absent = path.join(os.tmpdir(), 'openspec-ledger-never-created');
  const meter = meterSpawns();
  let calls: string[][];
  let evidence;
  try {
    evidence = await evaluateGitEvidence({
      enabled: false,
      root: makeRoot(absent),
      change: makeChange(absent, TASKS),
      history: makeHistory(TASKS),
      dismissedKeys: [],
      today: TODAY,
    });
  } finally {
    calls = meter.stop();
  }

  assert.deepEqual(calls, []);
  assert.equal(evidence.available, false);
  assert.equal(evidence.reason, 'disabled');
  assert.deepEqual(evidence.results, []);
  assert.deepEqual(evidence.noTrace, []);
  assert.match(evidence.reasonText ?? '', /openspecLedger\.gitEvidence\.enabled/);
});

gitTest('the same call with the feature on does spawn git, so the meter is honest', async () => {
  const { dir } = await makeWorkedRepo();
  const meter = meterSpawns();
  try {
    await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, TASKS),
      history: makeHistory(TASKS),
      dismissedKeys: [],
      today: TODAY,
    });
    assert.ok(meter.stop().length > 0);
  } finally {
    meter.stop();
    await removeTempDir(dir);
  }
});

gitTest('git missing from PATH disables the layer with that reason', async () => {
  const dir = await makeTempDir();
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = dir;
    resetGitCaches();
    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, TASKS),
      history: makeHistory(TASKS),
      dismissedKeys: [],
      today: TODAY,
    });

    assert.equal(evidence.available, false);
    assert.equal(evidence.reason, 'git-missing');
    assert.match(evidence.reasonText ?? '', /PATH/);
    assert.equal(evidence.results.length, TASKS.length);
    assert.ok(evidence.results.every((result) => result.state === 'unknown-date'));
  } finally {
    process.env.PATH = originalPath;
    resetGitCaches();
    await removeTempDir(dir);
  }
});

gitTest('a root outside any repository reports every completed task as undated', async () => {
  const dir = await makeTempDir();
  try {
    let inRepository = true;
    try {
      git(dir, ['rev-parse', '--show-toplevel']);
    } catch {
      inRepository = false;
    }
    if (inRepository) {
      // The temp directory of this machine happens to sit inside a repository.
      return;
    }

    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, TASKS),
      history: undefined,
      dismissedKeys: [],
      today: TODAY,
    });

    assert.equal(evidence.available, false);
    assert.equal(evidence.reason, 'not-a-repository');
    assert.equal(evidence.results.length, TASKS.length);
    assert.ok(evidence.results.every((result) => result.state === 'unknown-date'));
    assert.ok(evidence.results.every((result) => result.completedOn === undefined));
    assert.deepEqual(evidence.noTrace, []);
  } finally {
    await removeTempDir(dir);
  }
});

gitTest('a repository holding only specs reports that the code lives elsewhere', async () => {
  const dir = await makeTempDir();
  try {
    initRepo(dir);
    await write(dir, `openspec/changes/${CHANGE_ID}/tasks.md`, TASKS_MD);
    commit(dir, 'plan the change', '2026-08-19');

    assert.equal(await isPlanningOnlyRepository(dir), true);

    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, TASKS),
      history: makeHistory(TASKS),
      dismissedKeys: [],
      today: TODAY,
    });

    assert.equal(evidence.available, false);
    assert.equal(evidence.reason, 'planning-only');
    assert.match(evidence.reasonText ?? '', /another repository/);
    assert.deepEqual(evidence.noTrace, []);

    await write(dir, 'src/main.rs', 'fn main() {}\n');
    commit(dir, 'add the code', '2026-08-20');
    assert.equal(await isPlanningOnlyRepository(dir), false);
  } finally {
    await removeTempDir(dir);
  }
});

gitTest('a change with no recorded history is not searched', async () => {
  const { dir } = await makeWorkedRepo();
  try {
    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, TASKS),
      history: undefined,
      dismissedKeys: [],
      today: TODAY,
    });

    assert.equal(evidence.available, false);
    assert.equal(evidence.reason, 'no-history');
    assert.ok(evidence.results.every((result) => result.state === 'unknown-date'));
    assert.deepEqual(evidence.noTrace, []);
  } finally {
    await removeTempDir(dir);
  }
});

gitTest('a change with no tasks is available and empty', async () => {
  const { dir } = await makeWorkedRepo();
  try {
    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: makeRoot(dir),
      change: makeChange(dir, []),
      history: makeHistory(TASKS),
      dismissedKeys: [],
      today: TODAY,
    });

    assert.equal(evidence.available, true);
    assert.deepEqual(evidence.results, []);
    assert.deepEqual(evidence.noTrace, []);
  } finally {
    await removeTempDir(dir);
  }
});
