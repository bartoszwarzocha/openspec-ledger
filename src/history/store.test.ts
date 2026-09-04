import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Change, ParsedTaskFile, RootHistoryFile, Task, TaskState } from '../model/types.ts';
import { makeProgress, toDateKey } from '../model/keys.ts';
import { HistoryStore } from './store.ts';

/**
 * Task lines built by hand rather than by the parser: these tests are about the
 * store, and a fixture that cannot fail is worth more here than a shared one.
 */
function taskFileOf(lines: readonly string[]): ParsedTaskFile {
  const all: Task[] = lines.map((raw, index) => {
    const state: TaskState = /^\s*[-*] \[[xX]\]/.test(raw) ? 'complete' : 'pending';
    return {
      label: raw.replace(/^\s*[-*] \[.\]\s*/, ''),
      state,
      line: index + 1,
      raw,
      indent: 0,
      children: [],
    };
  });
  const completed = all.filter((task) => task.state === 'complete').length;
  return {
    sections: [{ depth: 0, line: 0, tasks: all }],
    progress: makeProgress(completed, all.length),
    all,
    leaves: all,
  };
}

function changeOf(rootPath: string, id: string, lines: readonly string[]): Change {
  return {
    id,
    path: path.join(rootPath, 'openspec', 'changes', id),
    rootPath,
    documents: { proposal: true, design: false, tasks: true, specs: false },
    createdInferred: false,
    tasksPath: path.join(rootPath, 'openspec', 'changes', id, 'tasks.md'),
    taskFile: taskFileOf(lines),
    undecomposed: false,
    problems: [],
  };
}

function ticked(count: number, total: number): string[] {
  return Array.from({ length: total }, (_unused, index) =>
    index < count ? `- [x] 1.${index + 1} Task ${index + 1}` : `- [ ] 1.${index + 1} Task ${index + 1}`,
  );
}

async function withStorage(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'osl-history-'));
  try {
    await run(dir);
  } finally {
    // `dispose()` starts its final write without awaiting it, so a rename can
    // still land in this directory while it is being removed. On Windows that
    // surfaces as ENOTEMPTY, and only under load - retrying is the remedy.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function readFile(store: HistoryStore, rootPath: string): Promise<RootHistoryFile> {
  const text = await fs.readFile(store.pathFor(rootPath), 'utf8');
  return JSON.parse(text) as RootHistoryFile;
}

test('a second observation on the same day replaces the first', async () => {
  await withStorage(async (dir) => {
    const root = path.join(dir, 'repo');
    const store = new HistoryStore(dir);

    await store.observe(root, changeOf(root, 'route-reads-through-data-service', ticked(61, 63)));
    await store.observe(root, changeOf(root, 'route-reads-through-data-service', ticked(62, 63)));

    const history = store.history(root, 'route-reads-through-data-service');
    assert.ok(history);
    assert.equal(history.snapshots.length, 1);
    assert.deepEqual(history.snapshots[0], {
      date: toDateKey(new Date()),
      completed: 62,
      total: 63,
      source: 'observed',
    });

    await store.flush();
    const onDisk = await readFile(store, root);
    assert.equal(onDisk.changes['route-reads-through-data-service']?.snapshots.length, 1);
    assert.equal(onDisk.changes['route-reads-through-data-service']?.snapshots[0]?.completed, 62);
    store.dispose();
  });
});

test('observations are debounced into a single write', async () => {
  await withStorage(async (dir) => {
    const root = path.join(dir, 'repo');
    const store = new HistoryStore(dir);

    for (const count of [1, 2, 3]) {
      await store.observe(root, changeOf(root, 'a', ticked(count, 10)));
    }
    assert.deepEqual(await fs.readdir(dir), [], 'nothing is written while the burst is still arriving');

    await store.flush();
    assert.deepEqual(await fs.readdir(dir), [store.fileNameFor(root)]);
    assert.equal((await readFile(store, root)).changes['a']?.snapshots[0]?.completed, 3);
    store.dispose();
  });
});

test('history is written to the storage directory and nowhere near the repository', async () => {
  await withStorage(async (dir) => {
    const storage = path.join(dir, 'storage');
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });

    const store = new HistoryStore(storage);
    await store.observe(repo, changeOf(repo, 'a', ticked(1, 4)));
    await store.flush();

    assert.deepEqual(await fs.readdir(repo), [], 'the user repository is left untouched');
    assert.deepEqual(await fs.readdir(storage), [store.fileNameFor(repo)]);
    assert.match(store.fileNameFor(repo), /^[0-9a-f]{40}\.json$/);
    store.dispose();
  });
});

test('the file name follows the path, not its spelling', () => {
  const store = new HistoryStore('anywhere');
  assert.equal(store.fileNameFor('C:/work/repo'), store.fileNameFor('C:\\work\\repo\\'));
  assert.notEqual(store.fileNameFor('C:/work/repo'), store.fileNameFor('C:/work/other'));
  store.dispose();
});

test('a corrupt history file is discarded rather than reported', async () => {
  await withStorage(async (dir) => {
    const root = path.join(dir, 'repo');
    const store = new HistoryStore(dir);
    await fs.writeFile(store.pathFor(root), '{ this is not json', 'utf8');

    const file = await store.load(root);
    assert.deepEqual(file, { version: 1, rootPath: root, changes: {} });

    // The empty file is usable straight away, which is what lets backfill rebuild it.
    await store.observe(root, changeOf(root, 'a', ticked(2, 5)));
    assert.equal(store.history(root, 'a')?.snapshots[0]?.completed, 2);
    store.dispose();
  });
});

test('a history file of the wrong shape is discarded too', async () => {
  await withStorage(async (dir) => {
    const root = path.join(dir, 'repo');
    const store = new HistoryStore(dir);
    await fs.writeFile(store.pathFor(root), JSON.stringify({ version: 2, changes: 'nope' }), 'utf8');

    assert.deepEqual(await store.load(root), { version: 1, rootPath: root, changes: {} });
    store.dispose();
  });
});

test('unreadable entries are dropped without losing the readable ones', async () => {
  await withStorage(async (dir) => {
    const root = path.join(dir, 'repo');
    const store = new HistoryStore(dir);
    const stored = {
      version: 1,
      rootPath: root,
      changes: {
        a: {
          changeId: 'a',
          snapshots: [
            { date: '2026-08-01', completed: 1, total: 4, source: 'observed' },
            { date: 'not-a-date', completed: 2, total: 4, source: 'observed' },
            { date: '2026-08-02', completed: 2, total: 4, source: 'sideways' },
          ],
          completions: { '1.1 Do it': '2026-08-01', '1.2 Skip it': 'whenever' },
        },
      },
    };
    await fs.writeFile(store.pathFor(root), JSON.stringify(stored), 'utf8');

    const file = await store.load(root);
    assert.equal(file.changes['a']?.snapshots.length, 1);
    assert.deepEqual(file.changes['a']?.completions, { '1.1 Do it': '2026-08-01' });
    store.dispose();
  });
});

test('a backfilled snapshot never overwrites an observed one', async () => {
  await withStorage(async (dir) => {
    const root = path.join(dir, 'repo');
    const store = new HistoryStore(dir);
    const today = toDateKey(new Date());

    await store.observe(root, changeOf(root, 'a', ticked(5, 10)));
    await store.recordBackfill(
      root,
      'a',
      [
        { date: '2026-07-01', completed: 1, total: 10, source: 'backfilled', commit: 'aaa' },
        { date: today, completed: 3, total: 10, source: 'backfilled', commit: 'bbb' },
      ],
      {},
      { head: 'head-sha', commits: 2 },
    );

    const history = store.history(root, 'a');
    assert.equal(history?.snapshots.length, 2);
    assert.equal(history?.snapshots[0]?.date, '2026-07-01');
    assert.deepEqual(history?.snapshots[1], { date: today, completed: 5, total: 10, source: 'observed' });
    assert.deepEqual(history?.backfill, { at: today, head: 'head-sha', commits: 2 });
    store.dispose();
  });
});

test('the earliest completion date wins', async () => {
  await withStorage(async (dir) => {
    const root = path.join(dir, 'repo');
    const store = new HistoryStore(dir);

    await store.recordBackfill(root, 'a', [], { '1.1 Do it': '2026-08-01' }, { head: 'x', commits: 1 });
    await store.recordBackfill(root, 'a', [], { '1.1 Do it': '2026-09-01' }, { head: 'y', commits: 1 });
    assert.equal(store.history(root, 'a')?.completions['1.1 Do it'], '2026-08-01');

    await store.recordBackfill(root, 'a', [], { '1.1 Do it': '2026-07-04' }, { head: 'z', commits: 1 });
    assert.equal(store.history(root, 'a')?.completions['1.1 Do it'], '2026-07-04');
    store.dispose();
  });
});

test('a task already complete at the first observation is not dated today', async () => {
  await withStorage(async (dir) => {
    const root = path.join(dir, 'repo');
    const store = new HistoryStore(dir);
    const today = toDateKey(new Date());

    await store.observe(root, changeOf(root, 'a', ticked(2, 4)));
    assert.deepEqual(
      store.history(root, 'a')?.completions,
      {},
      'those two were ticked on some day the store never saw',
    );

    // The third tick is a transition this session watched happen.
    await store.observe(root, changeOf(root, 'a', ticked(3, 4)));
    assert.deepEqual(store.history(root, 'a')?.completions, { '1.3 Task 3': today });
    store.dispose();
  });
});

test('a reopened store dates only the ticks it watches from then on', async () => {
  await withStorage(async (dir) => {
    const root = path.join(dir, 'repo');
    const today = toDateKey(new Date());
    const store = new HistoryStore(dir);

    await store.observe(root, changeOf(root, 'a', ticked(1, 3)));
    await store.observe(root, changeOf(root, 'a', ticked(2, 3)));
    await store.flush();
    store.dispose();

    const reopened = new HistoryStore(dir);
    await reopened.observe(root, changeOf(root, 'a', ticked(2, 3)));
    // 1.2 keeps the date the earlier session witnessed; 1.1 was complete before
    // any session looked, so it stays undated for backfill to resolve.
    assert.deepEqual(reopened.history(root, 'a')?.completions, { '1.2 Task 2': today });
    await reopened.flush();
    reopened.dispose();
  });
});

test('a backfilled completion date is not pushed forward by a later observation', async () => {
  await withStorage(async (dir) => {
    const root = path.join(dir, 'repo');
    const store = new HistoryStore(dir);

    await store.recordBackfill(root, 'a', [], { '1.2 Task 2': '2026-08-01' }, { head: 'x', commits: 1 });
    await store.observe(root, changeOf(root, 'a', ticked(1, 3)));
    await store.observe(root, changeOf(root, 'a', ticked(2, 3)));

    assert.equal(store.history(root, 'a')?.completions['1.2 Task 2'], '2026-08-01');
    store.dispose();
  });
});

test('an undecomposed change contributes no snapshot', async () => {
  await withStorage(async (dir) => {
    const root = path.join(dir, 'repo');
    const store = new HistoryStore(dir);
    const change = changeOf(root, 'proposal-only', []);
    delete change.taskFile;
    delete change.tasksPath;
    change.undecomposed = true;

    await store.observe(root, change);
    assert.equal(store.history(root, 'proposal-only'), undefined);
    store.dispose();
  });
});

test('dismissals are per change, deduplicated, and survive a reload', async () => {
  await withStorage(async (dir) => {
    const root = path.join(dir, 'repo');
    const store = new HistoryStore(dir);

    assert.deepEqual(store.dismissals(root, 'a'), []);
    await store.dismiss(root, 'a', '1.1 Do it');
    await store.dismiss(root, 'a', '1.1 Do it');
    await store.dismiss(root, 'a', '1.2 Do it twice');
    await store.dismiss(root, 'b', '2.1 Elsewhere');
    await store.flush();

    assert.deepEqual(store.dismissals(root, 'a'), ['1.1 Do it', '1.2 Do it twice']);
    assert.deepEqual(store.dismissals(root, 'b'), ['2.1 Elsewhere']);
    store.dispose();

    const reopened = new HistoryStore(dir);
    await reopened.load(root);
    assert.deepEqual(reopened.dismissals(root, 'a'), ['1.1 Do it', '1.2 Do it twice']);
    reopened.dispose();
  });
});

test('concurrent loads of one root share a single record', async () => {
  await withStorage(async (dir) => {
    const root = path.join(dir, 'repo');
    const store = new HistoryStore(dir);
    const [first, second] = await Promise.all([store.load(root), store.load(root)]);
    assert.equal(first, second);
    store.dispose();
  });
});
