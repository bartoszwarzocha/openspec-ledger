import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { setLogSink } from '../util/log.ts';
import { DEFAULT_EXCLUDED_DIRS, searchFilesystem } from './search.ts';

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'osl-search-'));
  // The temp directory is reached through a symlink on some platforms, and the
  // walk reports real paths.
  return fs.realpath(dir);
}

async function writeFile(target: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
}

/** An `openspec` root laid out the way the OpenSpec CLI lays one out. */
async function makeRoot(
  base: string,
  relative: string,
  options: { config?: string | false } = {},
): Promise<string> {
  const openspecPath = path.join(base, relative, 'openspec');
  await writeFile(
    path.join(openspecPath, 'changes', 'add-a-thing', 'tasks.md'),
    '- [ ] 1.1 Do the thing\n',
  );
  if (options.config !== false) {
    await writeFile(path.join(openspecPath, 'config.yaml'), options.config ?? 'schema: spec-driven\n');
  }
  return openspecPath;
}

async function withFixture(run: (base: string) => Promise<void>): Promise<void> {
  const base = await makeFixture();
  try {
    await run(base);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

const NINE_REPOS = [
  'data-service',
  'indexer',
  'lookup-service',
  'auth-gateway',
  'admin-ui',
  'reporting',
  'ingest',
  'scheduler',
  'notifier',
];

test('nine roots nested three deep in sibling repositories are all found', async () => {
  await withFixture(async (base) => {
    const expected: string[] = [];
    for (const repo of NINE_REPOS) {
      expected.push(await makeRoot(base, path.join('work', 'platform', repo)));
    }

    const found = await searchFilesystem([base]);

    assert.equal(found.length, 9);
    assert.deepEqual(
      found.map((candidate) => candidate.openspecPath).sort(),
      expected.sort(),
    );
    assert.ok(found.every((candidate) => candidate.hasConfig));
  });
});

test('a root at the search root itself is found', async () => {
  await withFixture(async (base) => {
    const openspecPath = await makeRoot(base, '.');

    const found = await searchFilesystem([base]);

    assert.deepEqual(found, [{ openspecPath, hasConfig: true }]);
  });
});

test('a root with changes but no config.yaml is accepted and marked', async () => {
  await withFixture(async (base) => {
    const openspecPath = await makeRoot(base, 'planning', { config: false });

    const found = await searchFilesystem([base]);

    assert.deepEqual(found, [{ openspecPath, hasConfig: false }]);
  });
});

test('an openspec directory with neither config.yaml nor changes is not a root', async () => {
  await withFixture(async (base) => {
    await fs.mkdir(path.join(base, 'repo', 'openspec', 'specs'), { recursive: true });

    assert.deepEqual(await searchFilesystem([base]), []);
  });
});

test('node_modules is never traversed', async () => {
  await withFixture(async (base) => {
    await makeRoot(base, path.join('node_modules', 'some-package'));
    const real = await makeRoot(base, 'app');

    const found = await searchFilesystem([base]);

    assert.deepEqual(found.map((candidate) => candidate.openspecPath), [real]);
  });
});

test('every default excluded directory is skipped', async () => {
  await withFixture(async (base) => {
    for (const dir of DEFAULT_EXCLUDED_DIRS) {
      await makeRoot(base, path.join(dir, 'nested'));
    }

    assert.deepEqual(await searchFilesystem([base]), []);
  });
});

test('excludedDirs replaces the default list rather than extending it', async () => {
  await withFixture(async (base) => {
    const inModules = await makeRoot(base, path.join('node_modules', 'some-package'));
    await makeRoot(base, 'skipme');

    const found = await searchFilesystem([base], { excludedDirs: ['skipme'] });

    assert.deepEqual(found.map((candidate) => candidate.openspecPath), [inModules]);
  });
});

test('a directory the user pointed at is searched even when its name is excluded', async () => {
  await withFixture(async (base) => {
    const openspecPath = await makeRoot(base, path.join('build', 'staged'));

    const found = await searchFilesystem([path.join(base, 'build')]);

    assert.deepEqual(found.map((candidate) => candidate.openspecPath), [openspecPath]);
  });
});

test('the walk stops at the first openspec directory', async () => {
  await withFixture(async (base) => {
    const outer = await makeRoot(base, 'repo');
    await makeRoot(path.join(outer, 'changes', 'add-a-thing'), 'fixture');

    const found = await searchFilesystem([base]);

    assert.deepEqual(found.map((candidate) => candidate.openspecPath), [outer]);
  });
});

test('maxDepth bounds the walk', async () => {
  await withFixture(async (base) => {
    await makeRoot(base, path.join('one', 'two', 'three'));

    assert.deepEqual(await searchFilesystem([base], { maxDepth: 3 }), []);
    assert.equal((await searchFilesystem([base], { maxDepth: 4 })).length, 1);
  });
});

test('a root far below a directory the user pointed at is still found', async () => {
  await withFixture(async (base) => {
    const deep = path.join('l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10');
    const openspecPath = await makeRoot(base, deep);

    const found = await searchFilesystem([base]);

    assert.deepEqual(found.map((candidate) => candidate.openspecPath), [openspecPath]);
  });
});

test('the walk logs what the depth cap left unsearched', async () => {
  await withFixture(async (base) => {
    await makeRoot(base, path.join('one', 'two', 'three'));
    const lines: string[] = [];

    setLogSink((_level, line) => lines.push(line));
    try {
      await searchFilesystem([base], { maxDepth: 1 });
      const complete = lines.length;
      await searchFilesystem([base], { maxDepth: 32 });
      assert.equal(lines.length, complete, 'a walk that finished should report nothing');
    } finally {
      setLogSink(undefined);
    }

    const truncation = lines.filter((line) => line.includes('Search stopped at depth 1'));
    assert.equal(truncation.length, 1);
    assert.ok(truncation[0]?.includes(path.join(base, 'one', 'two')), truncation[0]);
  });
});

test('overlapping start directories report each root once', async () => {
  await withFixture(async (base) => {
    const openspecPath = await makeRoot(base, path.join('outer', 'inner'));

    const found = await searchFilesystem([base, path.join(base, 'outer'), base]);

    assert.deepEqual(found.map((candidate) => candidate.openspecPath), [openspecPath]);
  });
});

test('an aborted signal ends the walk without throwing', async () => {
  await withFixture(async (base) => {
    await makeRoot(base, 'app');
    const controller = new AbortController();
    controller.abort();

    assert.deepEqual(await searchFilesystem([base], { signal: controller.signal }), []);
  });
});

test('a directory that does not exist yields no candidates and no error', async () => {
  await withFixture(async (base) => {
    const found = await searchFilesystem([path.join(base, 'nowhere')]);

    assert.deepEqual(found, []);
  });
});

test('a file passed as a start directory is ignored', async () => {
  await withFixture(async (base) => {
    const file = path.join(base, 'notes.md');
    await writeFile(file, 'text\n');

    assert.deepEqual(await searchFilesystem([file]), []);
  });
});

test('results are ordered by path so the caller sees a stable list', async () => {
  await withFixture(async (base) => {
    await makeRoot(base, 'zebra');
    await makeRoot(base, 'alpha');
    await makeRoot(base, 'mango');

    const found = await searchFilesystem([base]);
    const names = found.map((candidate) => path.basename(path.dirname(candidate.openspecPath)));

    assert.deepEqual(names, ['alpha', 'mango', 'zebra']);
  });
});
