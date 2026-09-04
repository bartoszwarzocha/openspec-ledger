import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModelBuilder } from './build.ts';
import { FileCache } from './changes.ts';
import type { OpenSpecRoot } from './types.ts';

async function withFixture(run: (dir: string, root: OpenSpecRoot) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'osl-build-'));
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

async function writeChange(dir: string, id: string, files: Record<string, string>): Promise<string> {
  const changeDir = path.join(dir, 'openspec', 'changes', id);
  await fs.mkdir(changeDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(changeDir, name), content, 'utf8');
  }
  return changeDir;
}

/** `completed` of `total` leaf tasks, as a task file. */
function taskFile(completed: number, total: number): string {
  const lines = ['## 1. Generated'];
  for (let index = 1; index <= total; index++) {
    lines.push(`- [${index <= completed ? 'x' : ' '}] 1.${index} Task number ${index}`);
  }
  return lines.join('\n');
}

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

// ---------------------------------------------------------------------------

test('aggregate progress covers decomposed changes only', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'alpha', { 'tasks.md': taskFile(2, 4) });
    await writeChange(dir, 'beta', { 'tasks.md': taskFile(3, 3) });
    await writeChange(dir, 'gamma', { '.openspec.yaml': 'schema: openspec-change@1\n' });
    await writeChange(dir, 'delta', { 'proposal.md': '# Why\n' });

    const model = await new ModelBuilder().build([root]);

    assert.equal(model.roots.length, 1);
    const built = model.roots[0];
    assert.ok(built);
    assert.deepEqual(
      built.changes.map((change) => change.id),
      ['alpha', 'beta', 'delta', 'gamma'],
    );
    assert.equal(built.changes.filter((change) => change.undecomposed).length, 2);
    // 5 of 7, not 5 of 7 plus two empty denominators.
    assert.deepEqual(built.progress, { completed: 5, total: 7, percent: 71 });
    assert.deepEqual(built.problems, []);
    assert.ok(model.builtAt instanceof Date);
  });
});

test('a root with no changes directory is built with a problem rather than dropped', async () => {
  await withFixture(async (dir, root) => {
    await fs.mkdir(path.join(dir, 'openspec'), { recursive: true });

    const model = await new ModelBuilder().build([root]);
    const built = model.roots[0];
    assert.ok(built);
    assert.deepEqual(built.changes, []);
    assert.deepEqual(built.progress, { completed: 0, total: 0, percent: 0 });
    assert.equal(built.problems.length, 1);
  });
});

test('several roots are built in the order they were given', async () => {
  await withFixture(async (dir) => {
    const first = path.join(dir, 'one');
    const second = path.join(dir, 'two');
    await writeChange(first, 'alpha', { 'tasks.md': taskFile(1, 2) });
    await writeChange(second, 'beta', { 'tasks.md': taskFile(4, 4) });

    const model = await new ModelBuilder().build([rootFor(first), rootFor(second)]);
    assert.deepEqual(
      model.roots.map((built) => built.root.path),
      [first, second],
    );
    assert.deepEqual(model.roots[1]?.progress, { completed: 4, total: 4, percent: 100 });
  });
});

test('a rebuild with nothing changed reads no tasks.md from disk', async () => {
  await withFixture(async (dir, root) => {
    for (const id of ['alpha', 'beta', 'gamma']) {
      await writeChange(dir, id, {
        '.openspec.yaml': 'created: 2026-02-13\n',
        'tasks.md': taskFile(1, 3),
      });
    }
    const cache = new CountingCache();
    const builder = new ModelBuilder({ cache });

    await builder.build([root]);
    assert.equal(cache.reads.filter((file) => file.endsWith('tasks.md')).length, 3);

    cache.reads.length = 0;
    const again = await builder.build([root]);
    assert.deepEqual(cache.reads, []);
    assert.deepEqual(again.roots[0]?.progress, { completed: 3, total: 9, percent: 33 });
  });
});

test('a modified tasks.md is the only file read again', async () => {
  await withFixture(async (dir, root) => {
    for (const id of ['alpha', 'beta', 'gamma']) {
      await writeChange(dir, id, {
        '.openspec.yaml': 'created: 2026-02-13\n',
        'tasks.md': taskFile(1, 3),
      });
    }
    const cache = new CountingCache();
    const builder = new ModelBuilder({ cache });
    await builder.build([root]);

    const touched = path.join(dir, 'openspec', 'changes', 'beta', 'tasks.md');
    await fs.writeFile(touched, taskFile(3, 3), 'utf8');
    const later = new Date(Date.now() + 2000);
    await fs.utimes(touched, later, later);

    cache.reads.length = 0;
    const model = await builder.build([root]);

    assert.deepEqual(cache.reads, [touched]);
    const beta = model.roots[0]?.changes.find((change) => change.id === 'beta');
    assert.deepEqual(beta?.taskFile?.progress, { completed: 3, total: 3, percent: 100 });
    assert.deepEqual(model.roots[0]?.progress, { completed: 5, total: 9, percent: 56 });
  });
});

test('invalidate with no argument makes the next build read everything again', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'alpha', {
      '.openspec.yaml': 'created: 2026-02-13\n',
      'tasks.md': taskFile(1, 3),
    });
    const cache = new CountingCache();
    const builder = new ModelBuilder({ cache });
    await builder.build([root]);

    cache.reads.length = 0;
    builder.invalidate();
    await builder.build([root]);
    assert.equal(cache.reads.length, 2, 'the task file and its metadata are both re-read');

    cache.reads.length = 0;
    builder.invalidate(path.join(dir, 'openspec', 'changes', 'alpha', 'tasks.md'));
    await builder.build([root]);
    assert.deepEqual(cache.reads, [path.join(dir, 'openspec', 'changes', 'alpha', 'tasks.md')]);
  });
});

test('a cancelled build rejects', async () => {
  await withFixture(async (dir, root) => {
    await writeChange(dir, 'alpha', { 'tasks.md': taskFile(1, 3) });
    await assert.rejects(() => new ModelBuilder().build([root], AbortSignal.abort()));
  });
});

test('a warm rebuild of 33 changes stays under 250 ms', async () => {
  await withFixture(async (dir, root) => {
    await Promise.all(
      Array.from({ length: 33 }, (_, index) =>
        writeChange(dir, `change-${String(index).padStart(2, '0')}`, {
          '.openspec.yaml': 'schema: openspec-change@1\ncreated: 2026-02-13\n',
          'proposal.md': '# Why\n',
          'tasks.md': taskFile(index % 20, 20),
        }),
      ),
    );

    const builder = new ModelBuilder();
    const cold = await builder.build([root]);
    assert.equal(cold.roots[0]?.changes.length, 33);

    const durations: number[] = [];
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      await builder.build([root]);
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    const median = durations[1] ?? Number.POSITIVE_INFINITY;
    assert.ok(median < 250, `warm rebuild took ${median.toFixed(1)} ms`);
  });
});
