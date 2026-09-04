import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Change, OpenSpecRoot, ProgressSnapshot } from '../model/types.ts';
import { toDateKey } from '../model/keys.ts';
import { runGit } from '../util/git.ts';
import { backfillChange, backfillRoot } from './backfill.ts';
import { HistoryStore } from './store.ts';

interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The fixtures are real repositories: backfill is a claim about what `git log`
 * and `git show` do, and a fake would only test the fake.
 */
function git(args: readonly string[], cwd: string, env?: Record<string, string>): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      windowsHide: true,
      shell: false,
      env: env ? { ...process.env, ...env } : process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

let gitPresent: Promise<boolean> | undefined;

function hasGit(): Promise<boolean> {
  gitPresent ??= git(['--version'], os.tmpdir()).then(
    (result) => result.code === 0,
    () => false,
  );
  return gitPresent;
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'osl-backfill-'));
  await git(['init', '-q'], dir);
  // Local only: the fixture must not depend on the machine's identity, hooks or signing key.
  for (const [key, value] of [
    ['user.name', 'Ledger Fixture'],
    ['user.email', 'fixture@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ]) {
    await git(['config', key ?? '', value ?? ''], dir);
  }
  return dir;
}

async function remove(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** Day `index` of the fixture calendar, at local noon so no time zone can move it. */
function dayOf(index: number): Date {
  return new Date(2026, 0, 1 + index, 12, 0, 0);
}

function tasksBody(complete: number, total: number): string {
  const lines = ['# Tasks', '', '## 1. Implementation', ''];
  for (let index = 0; index < total; index++) {
    lines.push(`- [${index < complete ? 'x' : ' '}] 1.${index + 1} Task number ${index + 1}`);
  }
  return `${lines.join('\n')}\n`;
}

async function commitFile(repo: string, target: string, contents: string, index: number): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
  await git(['add', '-A'], repo);
  const at = dayOf(index).toISOString();
  const result = await git(['commit', '-q', '-m', `revision ${index}`], repo, {
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_DATE: at,
  });
  assert.equal(result.code, 0, result.stderr);
}

function changeOf(repo: string, id: string): Change {
  const changePath = path.join(repo, 'openspec', 'changes', id);
  return {
    id,
    path: changePath,
    rootPath: repo,
    documents: { proposal: false, design: false, tasks: true, specs: false },
    createdInferred: false,
    tasksPath: path.join(changePath, 'tasks.md'),
    undecomposed: false,
    problems: [],
  };
}

function rootOf(repo: string): OpenSpecRoot {
  return {
    path: repo,
    openspecPath: path.join(repo, 'openspec'),
    label: 'fixture',
    hasConfig: true,
    fromSettings: false,
  };
}

test('forty commits are reconstructed, marked backfilled, within the budget', async (t) => {
  if (!(await hasGit())) {
    t.skip('git is not on PATH');
    return;
  }
  const repo = await makeRepo();
  try {
    const tasksPath = path.join(repo, 'openspec', 'changes', 'add-lookup-provider', 'tasks.md');
    for (let index = 0; index < 40; index++) {
      await commitFile(repo, tasksPath, tasksBody(index + 1, 40), index);
    }

    // Calibrate against this machine, right now. Backfill's cost is dominated by
    // spawning git once per revision, and on Windows a spawn is expensive and
    // gets much more so while a dozen sibling test files are spawning their own.
    // Comparing against a fixed wall-clock number would make this assertion a
    // measure of how busy the machine is rather than of how fast the code is.
    const spawnStarted = Date.now();
    for (let index = 0; index < 4; index++) {
      await runGit(['rev-parse', 'HEAD'], { cwd: repo });
    }
    const perSpawn = (Date.now() - spawnStarted) / 4;

    const started = Date.now();
    const result = await backfillChange({ repoRoot: repo, tasksPath });
    const elapsed = Date.now() - started;

    assert.ok(result);
    assert.equal(result.commits, 40);
    assert.equal(result.skipped, 0);
    assert.equal(result.snapshots.length, 40);
    assert.match(result.head, /^[0-9a-f]{40}$/);

    for (let index = 0; index < 40; index++) {
      const snapshot: ProgressSnapshot | undefined = result.snapshots[index];
      assert.ok(snapshot);
      assert.equal(snapshot.date, toDateKey(dayOf(index)), `snapshot ${index} is dated by its author date`);
      assert.equal(snapshot.completed, index + 1);
      assert.equal(snapshot.total, 40);
      assert.equal(snapshot.source, 'backfilled');
      assert.match(snapshot.commit ?? '', /^[0-9a-f]{40}$/);
    }

    // Each task was first seen complete on the day its box was ticked.
    assert.equal(result.completions['1.1 Task number 1'], toDateKey(dayOf(0)));
    assert.equal(result.completions['1.40 Task number 40'], toDateKey(dayOf(39)));

    // design.md D13: one change is replayed in under 2 s. Backfill reads the 40
    // revisions six at a time, so the floor is roughly 41 spawns over six lanes;
    // the budget is whichever is the more generous of the design figure and that
    // floor with room to spare. On an idle machine the first always wins - the
    // measured figure against a real repository is 139-264 ms - and the
    // assertion still catches the regression it is there for, which is backfill
    // going back to one revision at a time or re-reading what it has parsed.
    const floor = Math.ceil((41 / 6) * perSpawn * 3);
    const budget = Math.max(2000, floor);
    assert.ok(
      elapsed < budget,
      `backfill of forty commits took ${elapsed} ms against a budget of ${budget} ms ` +
        `(one git spawn currently costs ${perSpawn.toFixed(0)} ms on this machine)`,
    );
  } finally {
    await remove(repo);
  }
});

test('a renamed change directory is followed back past the rename', async (t) => {
  if (!(await hasGit())) {
    t.skip('git is not on PATH');
    return;
  }
  const repo = await makeRepo();
  try {
    const before = path.join(repo, 'openspec', 'changes', 'old-name', 'tasks.md');
    for (let index = 0; index < 3; index++) {
      await commitFile(repo, before, tasksBody(index + 1, 6), index);
    }

    await git(['mv', 'openspec/changes/old-name', 'openspec/changes/new-name'], repo);
    const renamedAt = dayOf(3).toISOString();
    await git(['commit', '-q', '-m', 'rename the change'], repo, {
      GIT_AUTHOR_DATE: renamedAt,
      GIT_COMMITTER_DATE: renamedAt,
    });

    const after = path.join(repo, 'openspec', 'changes', 'new-name', 'tasks.md');
    for (let index = 4; index < 6; index++) {
      await commitFile(repo, after, tasksBody(index, 6), index);
    }

    const result = await backfillChange({ repoRoot: repo, tasksPath: after });
    assert.ok(result);
    assert.equal(result.skipped, 0);
    assert.equal(result.snapshots.length, 6);
    assert.equal(result.snapshots[0]?.date, toDateKey(dayOf(0)), 'the first revision predates the rename');
    assert.equal(result.snapshots[0]?.completed, 1);
    assert.equal(result.snapshots[5]?.completed, 5);
  } finally {
    await remove(repo);
  }
});

test('a commit whose blob cannot be read is skipped and counted', async (t) => {
  if (!(await hasGit())) {
    t.skip('git is not on PATH');
    return;
  }
  const repo = await makeRepo();
  try {
    const tasksPath = path.join(repo, 'openspec', 'changes', 'a-change', 'tasks.md');
    for (let index = 0; index < 5; index++) {
      await commitFile(repo, tasksPath, tasksBody(index + 1, 5), index);
    }

    const relative = 'openspec/changes/a-change/tasks.md';
    const listed = await git(['log', '--format=%H', '--reverse', '--', relative], repo);
    const middle = listed.stdout.trim().split(/\r?\n/)[2];
    assert.ok(middle);
    const blob = (await git(['rev-parse', `${middle}:${relative}`], repo)).stdout.trim();
    assert.match(blob, /^[0-9a-f]{40}$/);

    // A loose object standing in for a shallow clone's missing blob.
    const object = path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    assert.ok(await fs.stat(object).then(() => true, () => false), 'the fixture blob is a loose object');
    await fs.rm(object, { force: true });

    const result = await backfillChange({ repoRoot: repo, tasksPath });
    assert.ok(result, 'a missing blob does not fail the run');
    assert.equal(result.commits, 5);
    assert.equal(result.skipped, 1);
    assert.equal(result.snapshots.length, 4);
    assert.ok(
      result.snapshots.every((snapshot) => snapshot.date !== toDateKey(dayOf(2))),
      'the unreadable revision contributes no snapshot',
    );
  } finally {
    await remove(repo);
  }
});

test('a directory outside a repository has no history to replay', async (t) => {
  if (!(await hasGit())) {
    t.skip('git is not on PATH');
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'osl-nogit-'));
  try {
    const tasksPath = path.join(dir, 'openspec', 'changes', 'a-change', 'tasks.md');
    await fs.mkdir(path.dirname(tasksPath), { recursive: true });
    await fs.writeFile(tasksPath, tasksBody(1, 3), 'utf8');

    assert.equal(await backfillChange({ repoRoot: dir, tasksPath }), undefined);
  } finally {
    await remove(dir);
  }
});

test('an aborted replay records nothing', async (t) => {
  if (!(await hasGit())) {
    t.skip('git is not on PATH');
    return;
  }
  const repo = await makeRepo();
  try {
    const tasksPath = path.join(repo, 'openspec', 'changes', 'a-change', 'tasks.md');
    await commitFile(repo, tasksPath, tasksBody(1, 3), 0);

    const controller = new AbortController();
    controller.abort();
    assert.equal(
      await backfillChange({ repoRoot: repo, tasksPath, signal: controller.signal }),
      undefined,
    );
  } finally {
    await remove(repo);
  }
});

test('backfillRoot fills the store once per head', async (t) => {
  if (!(await hasGit())) {
    t.skip('git is not on PATH');
    return;
  }
  const repo = await makeRepo();
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'osl-storage-'));
  const store = new HistoryStore(storage);
  try {
    const change = changeOf(repo, 'a-change');
    const undecomposed = changeOf(repo, 'proposal-only');
    delete undecomposed.tasksPath;
    undecomposed.undecomposed = true;

    for (let index = 0; index < 4; index++) {
      await commitFile(repo, change.tasksPath ?? '', tasksBody(index + 1, 4), index);
    }

    const first: string[] = [];
    await backfillRoot({
      root: rootOf(repo),
      changes: [change, undecomposed],
      store,
      onProgress: (id) => first.push(id),
    });
    assert.deepEqual(first, ['a-change'], 'an undecomposed change has nothing to replay');

    const history = store.history(repo, 'a-change');
    assert.equal(history?.snapshots.length, 4);
    assert.equal(history?.backfill?.commits, 4);
    assert.match(history?.backfill?.head ?? '', /^[0-9a-f]{40}$/);
    assert.deepEqual(await fs.readdir(storage), [store.fileNameFor(repo)]);

    const second: string[] = [];
    await backfillRoot({
      root: rootOf(repo),
      changes: [change],
      store,
      onProgress: (id) => second.push(id),
    });
    assert.deepEqual(second, [], 'the same head is not replayed twice');

    await commitFile(repo, change.tasksPath ?? '', tasksBody(4, 8), 4);
    const third: string[] = [];
    await backfillRoot({
      root: rootOf(repo),
      changes: [change],
      store,
      onProgress: (id) => third.push(id),
    });
    assert.deepEqual(third, ['a-change'], 'a new head is replayed');
    assert.equal(store.history(repo, 'a-change')?.snapshots.length, 5);
  } finally {
    store.dispose();
    await remove(repo);
    await remove(storage);
  }
});

test('a root outside a repository leaves the store empty', async (t) => {
  if (!(await hasGit())) {
    t.skip('git is not on PATH');
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'osl-nogit-root-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'osl-storage-'));
  const store = new HistoryStore(storage);
  try {
    const change = changeOf(dir, 'a-change');
    await fs.mkdir(path.dirname(change.tasksPath ?? ''), { recursive: true });
    await fs.writeFile(change.tasksPath ?? '', tasksBody(1, 3), 'utf8');

    await backfillRoot({ root: rootOf(dir), changes: [change], store });

    assert.equal(store.history(dir, 'a-change'), undefined);
    assert.deepEqual(await fs.readdir(storage), []);
  } finally {
    store.dispose();
    await remove(dir);
    await remove(storage);
  }
});
