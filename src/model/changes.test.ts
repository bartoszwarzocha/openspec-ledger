import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileCache, listChangeIds, readChange } from './changes.ts';
import type { OpenSpecRoot } from './types.ts';

// ---------------------------------------------------------------------------
// Fixtures. Everything lives under os.tmpdir() and is removed in a finally.
// ---------------------------------------------------------------------------

async function withFixture(run: (dir: string, root: OpenSpecRoot) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'osl-changes-'));
  try {
    await run(dir, rootFor(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function rootFor(dir: string): OpenSpecRoot {
  return {
    path: dir,
    openspecPath: path.join(dir, 'openspec'),
    label: path.basename(dir),
    hasConfig: true,
    fromSettings: false,
  };
}

/** Keys are paths relative to the change directory, so `specs/x/spec.md` works. */
async function writeChange(
  dir: string,
  id: string,
  files: Record<string, string>,
  changesDir = 'changes',
): Promise<string> {
  const changeDir = path.join(dir, 'openspec', changesDir, id);
  await fs.mkdir(changeDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(changeDir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  return changeDir;
}

/** A cache that records which files it actually had to read. */
class CountingCache extends FileCache {
  readonly reads: string[] = [];

  override load<T>(
    filePath: string,
    read: (filePath: string) => Promise<T | undefined>,
  ): Promise<T | undefined> {
    return super.load(filePath, async (target) => {
      this.reads.push(target);
      return read(target);
    });
  }
}

const TASKS = ['## 1. Provider', '- [x] 1.1 Done', '- [ ] 1.2 Pending'].join('\n');

// ---------------------------------------------------------------------------

test('a change with the full document set reports all four documents', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'add-lookup-provider', {
      '.openspec.yaml': 'schema: openspec-change@1\ncreated: 2026-02-13\n',
      'proposal.md': '# Why\n',
      'design.md': '# Design\n',
      'tasks.md': TASKS,
      'specs/lookup/spec.md': '# Spec\n',
    });

    const change = await readChange(root, 'add-lookup-provider');

    assert.deepEqual(change.documents, {
      proposal: true,
      design: true,
      tasks: true,
      specs: true,
    });
    assert.equal(change.id, 'add-lookup-provider');
    assert.equal(change.rootPath, dir);
    assert.equal(change.path, path.join(dir, 'openspec', 'changes', 'add-lookup-provider'));
    assert.equal(change.tasksPath, path.join(change.path, 'tasks.md'));
    assert.equal(change.schema, 'openspec-change@1');
    assert.equal(change.undecomposed, false);
    assert.deepEqual(change.taskFile?.progress, { completed: 1, total: 2, percent: 50 });
    assert.deepEqual(change.problems, []);
  });
});

test('a change holding only .openspec.yaml is still a change', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'spec-consistency-fixes', {
      '.openspec.yaml': 'schema: openspec-change@1\n',
    });

    assert.deepEqual(await listChangeIds(root), ['spec-consistency-fixes']);

    const change = await readChange(root, 'spec-consistency-fixes');
    assert.deepEqual(change.documents, {
      proposal: false,
      design: false,
      tasks: false,
      specs: false,
    });
    assert.equal(change.undecomposed, true);
    assert.equal(change.taskFile, undefined);
    assert.equal(change.tasksPath, undefined);
    assert.deepEqual(change.problems, []);
  });
});

test('directories under changes/archive are not enumerated as active changes', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'live-change', { 'tasks.md': TASKS });
    await writeChange(dir, 'archived-change', { 'tasks.md': TASKS }, path.join('changes', 'archive'));

    assert.deepEqual(await listChangeIds(root), ['live-change']);
  });
});

test('change ids come back sorted and an unreadable changes directory yields none', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'zeta', { 'tasks.md': TASKS });
    await writeChange(dir, 'alpha', { 'tasks.md': TASKS });
    assert.deepEqual(await listChangeIds(root), ['alpha', 'zeta']);

    assert.deepEqual(await listChangeIds(rootFor(path.join(dir, 'nowhere'))), []);
  });
});

test('a declared creation date is used as declared', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'dated', {
      '.openspec.yaml': 'schema: openspec-change@1\ncreated: 2026-02-13\n',
      'proposal.md': '# Why\n',
    });

    const change = await readChange(root, 'dated');
    assert.equal(change.createdInferred, false);
    assert.equal(change.created?.getFullYear(), 2026);
    assert.equal(change.created?.getMonth(), 1);
    assert.equal(change.created?.getDate(), 13);
  });
});

test('without a created key the earliest document time is inferred', async () => {
  await withFixture(async (dir, root) => {
    const changeDir = await writeChange(dir, 'undated', {
      '.openspec.yaml': 'schema: openspec-change@1\n',
      'proposal.md': '# Why\n',
      'tasks.md': TASKS,
    });

    const oldest = new Date('2026-01-05T09:00:00.000Z');
    const newer = new Date('2026-03-20T09:00:00.000Z');
    await fs.utimes(path.join(changeDir, 'proposal.md'), oldest, oldest);
    await fs.utimes(path.join(changeDir, '.openspec.yaml'), newer, newer);
    await fs.utimes(path.join(changeDir, 'tasks.md'), newer, newer);

    const change = await readChange(root, 'undated');
    assert.equal(change.createdInferred, true);
    assert.equal(change.created?.getTime(), oldest.getTime());
  });
});

test('an unparseable created value falls back to file times and is reported', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'garbled-date', {
      '.openspec.yaml': 'created: sometime last winter\n',
    });

    const change = await readChange(root, 'garbled-date');
    assert.equal(change.createdInferred, true);
    assert.ok(change.created instanceof Date);
    assert.equal(change.problems.length, 1);
    assert.match(change.problems[0] ?? '', /created: sometime last winter/);
  });
});

test('metadata that is not YAML is a problem, not a dropped change', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'broken-meta', {
      '.openspec.yaml': 'schema: openspec-change@1\nthis line is not a key at all\n',
      'tasks.md': TASKS,
    });

    const change = await readChange(root, 'broken-meta');
    assert.equal(change.schema, 'openspec-change@1');
    assert.equal(change.problems.length, 1);
    assert.match(change.problems[0] ?? '', /could not be read as YAML/);
    assert.deepEqual(change.taskFile?.progress, { completed: 1, total: 2, percent: 50 });
  });
});

test('an absent tasks.md is undecomposed; an empty one is 0 of 0', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'no-tasks-file', { 'proposal.md': '# Why\n' });
    await writeChange(dir, 'empty-tasks-file', { 'proposal.md': '# Why\n', 'tasks.md': '' });
    await writeChange(dir, 'prose-only-tasks-file', {
      'tasks.md': '# Tasks\n\nNothing has been decomposed yet.\n',
    });

    const absent = await readChange(root, 'no-tasks-file');
    assert.equal(absent.undecomposed, true);
    assert.equal(absent.taskFile, undefined);

    for (const id of ['empty-tasks-file', 'prose-only-tasks-file']) {
      const present = await readChange(root, id);
      assert.equal(present.undecomposed, false, id);
      assert.deepEqual(present.taskFile?.progress, { completed: 0, total: 0, percent: 0 }, id);
    }
  });
});

test('a tasks.md whose code fence never closes reports the oddity on the change', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'stray-fence', {
      'tasks.md': ['## 1. Provider', '- [x] 1.1 Done', '```md', '- [ ] 1.2 Pending'].join('\n'),
    });

    const change = await readChange(root, 'stray-fence');
    assert.deepEqual(change.taskFile?.progress, { completed: 1, total: 2, percent: 50 });
    assert.equal(change.problems.length, 1);
    assert.match(change.problems[0] ?? '', /tasks\.md: a code fence opened on line 3/);
  });
});

test('a change directory that is not there is reported, not thrown', async () => {
  await withFixture(async (_dir, root) => {
    const change = await readChange(root, 'never-existed');
    assert.equal(change.id, 'never-existed');
    assert.equal(change.undecomposed, true);
    assert.deepEqual(change.problems, ['the change directory could not be read']);
  });
});

test('the tab width reaches the parser', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'tabbed', {
      'tasks.md': ['- [ ] Parent', '  - [ ] Two spaces', '\t- [ ] One tab'].join('\n'),
    });

    const wide = await readChange(root, 'tabbed', { tabWidth: 4 });
    assert.equal(wide.taskFile?.leaves.length, 1);

    const narrow = await readChange(root, 'tabbed', { tabWidth: 2 });
    assert.equal(narrow.taskFile?.leaves.length, 2);
  });
});

test('a cached tasks.md is not read again until it changes', async () => {
  await withFixture(async (dir, root) => {
    const changeDir = await writeChange(dir, 'cached', {
      '.openspec.yaml': 'created: 2026-02-13\n',
      'tasks.md': TASKS,
    });
    const tasksPath = path.join(changeDir, 'tasks.md');
    const cache = new CountingCache();

    const first = await readChange(root, 'cached', { cache });
    assert.deepEqual(first.taskFile?.progress, { completed: 1, total: 2, percent: 50 });
    assert.equal(cache.reads.filter((file) => file === tasksPath).length, 1);

    cache.reads.length = 0;
    const second = await readChange(root, 'cached', { cache });
    assert.deepEqual(cache.reads, []);
    // The same parsed object is handed back, which is what makes a rebuild free.
    assert.equal(second.taskFile, first.taskFile);

    await fs.writeFile(tasksPath, `${TASKS}\n- [x] 1.3 Added later\n`, 'utf8');
    const bumped = new Date(Date.now() + 2000);
    await fs.utimes(tasksPath, bumped, bumped);

    cache.reads.length = 0;
    const third = await readChange(root, 'cached', { cache });
    assert.deepEqual(cache.reads, [tasksPath]);
    assert.deepEqual(third.taskFile?.progress, { completed: 2, total: 3, percent: 67 });
  });
});

test('invalidating a directory forgets the files beneath it', async () => {
  await withFixture(async (dir, root) => {
    const changeDir = await writeChange(dir, 'invalidated', { 'tasks.md': TASKS });
    const cache = new CountingCache();

    await readChange(root, 'invalidated', { cache });
    cache.reads.length = 0;
    await readChange(root, 'invalidated', { cache });
    assert.deepEqual(cache.reads, []);

    cache.invalidate(changeDir);
    await readChange(root, 'invalidated', { cache });
    assert.deepEqual(cache.reads, [path.join(changeDir, 'tasks.md')]);

    cache.reads.length = 0;
    cache.clear();
    await readChange(root, 'invalidated', { cache });
    assert.equal(cache.reads.length, 1);
  });
});

test('an already cancelled read rejects rather than returning half a change', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'cancelled', { 'tasks.md': TASKS });
    await assert.rejects(() => readChange(root, 'cancelled', { signal: AbortSignal.abort() }));
  });
});
