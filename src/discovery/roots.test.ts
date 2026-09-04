import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { setLogSink } from '../util/log.ts';
import { RootCache } from './cache.ts';
import { discoverRoots, readRootConfig, type DiscoveryInput } from './roots.ts';
import { searchFilesystem, type RootCandidate } from './search.ts';

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'osl-roots-'));
  // The temp directory is reached through a symlink on some platforms, and
  // discovery reports real paths.
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

/** Stands in for the editor's index, which the unit tests have no host for. */
function searcherOver(...folders: string[]): (signal?: AbortSignal) => Promise<RootCandidate[]> {
  return (signal) => searchFilesystem(folders, { signal });
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

test('roots nested in sibling repositories are all found and labelled by their path', async () => {
  await withFixture(async (base) => {
    for (const repo of NINE_REPOS) {
      await makeRoot(base, path.join('work', 'platform', repo));
    }

    const roots = await discoverRoots({
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: searcherOver(base),
    });

    assert.equal(roots.length, 9);
    assert.deepEqual(
      roots.map((root) => root.label).sort(),
      NINE_REPOS.map((repo) => `work/platform/${repo}`).sort(),
    );
    for (const root of roots) {
      assert.equal(root.path, path.dirname(root.openspecPath));
      assert.ok(path.isAbsolute(root.path));
      assert.equal(root.workspaceFolder, base);
      assert.equal(root.fromSettings, false);
      assert.equal(root.hasConfig, true);
      assert.equal(root.schema, 'spec-driven');
    }
  });
});

test('a root at the workspace folder root is labelled with the folder name', async () => {
  await withFixture(async (base) => {
    const openspecPath = await makeRoot(base, '.');

    const roots = await discoverRoots({
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: searcherOver(base),
    });

    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.openspecPath, openspecPath);
    assert.equal(roots[0]?.path, base);
    assert.equal(roots[0]?.label, path.basename(base));
  });
});

test('a root with changes but no config.yaml is kept and marked as having none', async () => {
  await withFixture(async (base) => {
    await makeRoot(base, 'planning', { config: false });

    const roots = await discoverRoots({
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: searcherOver(base),
    });

    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.hasConfig, false);
    assert.equal(roots[0]?.schema, undefined);
    assert.equal(roots[0]?.configError, undefined);
  });
});

test('node_modules is never traversed', async () => {
  await withFixture(async (base) => {
    await makeRoot(base, path.join('node_modules', 'some-package'));
    await makeRoot(base, 'app');

    const roots = await discoverRoots({
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: searcherOver(base),
    });

    assert.deepEqual(roots.map((root) => root.label), ['app']);
  });
});

test('an empty workspace yields an empty list rather than an error', async () => {
  const roots = await discoverRoots({ workspaceFolders: [], additionalRoots: [] });

  assert.deepEqual(roots, []);
});

test('a candidate that no longer holds a root on disk is dropped', async () => {
  await withFixture(async (base) => {
    const stale = path.join(base, 'removed', 'openspec');
    await fs.mkdir(path.join(base, 'removed', 'openspec', 'specs'), { recursive: true });
    const live = await makeRoot(base, 'app');

    const roots = await discoverRoots({
      workspaceFolders: [base],
      additionalRoots: [],
      // A search index can be stale, so it only proposes.
      searchWorkspace: async () => [
        { openspecPath: stale, hasConfig: true },
        { openspecPath: live, hasConfig: true },
      ],
    });

    assert.deepEqual(roots.map((root) => root.openspecPath), [live]);
  });
});

test('a configured root outside every workspace folder is included', async () => {
  await withFixture(async (base) => {
    const folder = path.join(base, 'workspace');
    await fs.mkdir(folder, { recursive: true });
    const outside = path.join(base, 'elsewhere', 'lookup-service');
    const openspecPath = await makeRoot(base, path.join('elsewhere', 'lookup-service'));

    const roots = await discoverRoots({
      workspaceFolders: [folder],
      additionalRoots: [outside],
      searchWorkspace: searcherOver(folder),
    });

    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.openspecPath, openspecPath);
    assert.equal(roots[0]?.label, 'lookup-service');
    assert.equal(roots[0]?.fromSettings, true);
    assert.equal(roots[0]?.workspaceFolder, undefined);
  });
});

test('a configured path that does not exist is reported and the other roots still load', async () => {
  await withFixture(async (base) => {
    await makeRoot(base, 'app');
    const missing = path.join(base, 'not-here');
    const reported: string[] = [];

    const roots = await discoverRoots({
      workspaceFolders: [base],
      additionalRoots: [missing, missing, '   '],
      searchWorkspace: searcherOver(base),
      onMissingRoot: (target) => reported.push(target),
    });

    assert.deepEqual(reported, [missing]);
    assert.deepEqual(roots.map((root) => root.label), ['app']);
  });
});

test('a missing configured path reaches the user once, through the callback alone', async () => {
  await withFixture(async (base) => {
    const missing = path.join(base, 'not-here');
    const reported: string[] = [];
    const logged: string[] = [];

    setLogSink((_level, line) => logged.push(line));
    try {
      await discoverRoots({
        workspaceFolders: [base],
        additionalRoots: [missing],
        onMissingRoot: (target) => reported.push(target),
      });
    } finally {
      setLogSink(undefined);
    }

    assert.deepEqual(reported, [missing]);
    assert.deepEqual(
      logged.filter((line) => line.includes(missing)),
      [],
    );
  });
});

test('a missing configured path is logged when no callback is taking it', async () => {
  await withFixture(async (base) => {
    const missing = path.join(base, 'not-here');
    const logged: string[] = [];

    setLogSink((_level, line) => logged.push(line));
    try {
      await discoverRoots({ workspaceFolders: [base], additionalRoots: [missing] });
    } finally {
      setLogSink(undefined);
    }

    assert.equal(logged.filter((line) => line.includes(missing)).length, 1);
  });
});

test('a root found in both the workspace and the setting is not from the setting', async () => {
  await withFixture(async (base) => {
    const openspecPath = await makeRoot(base, 'app');

    const roots = await discoverRoots({
      workspaceFolders: [base],
      additionalRoots: [path.join(base, 'app')],
      searchWorkspace: searcherOver(base),
    });

    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.openspecPath, openspecPath);
    assert.equal(roots[0]?.fromSettings, false);
  });
});

test('a malformed config.yaml keeps its root and records the failure', async () => {
  await withFixture(async (base) => {
    await makeRoot(base, 'app', { config: '{ "schema": "spec-driven" }\n' });

    const roots = await discoverRoots({
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: searcherOver(base),
    });

    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.label, 'app');
    assert.equal(roots[0]?.hasConfig, true);
    assert.equal(roots[0]?.schema, undefined);
    assert.match(roots[0]?.configError ?? '', /config\.yaml could not be read as YAML/);
  });
});

test('roots are ordered by label, then by path', async () => {
  await withFixture(async (base) => {
    await makeRoot(base, path.join('b-folder', 'shared'));
    await makeRoot(base, path.join('a-folder', 'shared'));
    await makeRoot(base, 'alpha');

    const roots = await discoverRoots({
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: searcherOver(base),
    });

    assert.deepEqual(roots.map((root) => root.label), [
      'a-folder/shared',
      'alpha',
      'b-folder/shared',
    ]);
  });
});

test('the innermost open folder wins when workspace folders are nested', async () => {
  await withFixture(async (base) => {
    const inner = path.join(base, 'outer', 'inner');
    await makeRoot(base, path.join('outer', 'inner', 'app'));

    const roots = await discoverRoots({
      workspaceFolders: [base, inner],
      additionalRoots: [],
      searchWorkspace: searcherOver(base),
    });

    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.workspaceFolder, inner);
    assert.equal(roots[0]?.label, 'app');
  });
});

test('readRootConfig reports the schema, and reports nothing when there is no file', async () => {
  await withFixture(async (base) => {
    const withConfig = await makeRoot(base, 'a', { config: 'schema: spec-driven\nversion: 2\n' });
    const withoutConfig = await makeRoot(base, 'b', { config: false });

    assert.deepEqual(await readRootConfig(withConfig), { hasConfig: true, schema: 'spec-driven' });
    assert.deepEqual(await readRootConfig(withoutConfig), { hasConfig: false });
  });
});

test('readRootConfig reports an unterminated quote without losing the root', async () => {
  await withFixture(async (base) => {
    const openspecPath = await makeRoot(base, 'a', { config: 'schema: "spec-driven\n' });

    const config = await readRootConfig(openspecPath);

    assert.equal(config.hasConfig, true);
    assert.equal(config.schema, undefined);
    assert.match(config.configError ?? '', /unterminated quoted value/);
  });
});

test('an ignored top-level block in config.yaml is not a parse failure', async () => {
  await withFixture(async (base) => {
    const openspecPath = await makeRoot(base, 'a', {
      config: 'schema: spec-driven\nrules:\n  - be terse\n  - cite the spec\n',
    });

    assert.deepEqual(await readRootConfig(openspecPath), {
      hasConfig: true,
      schema: 'spec-driven',
    });
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

test('the cache holds its list until it is invalidated', async () => {
  await withFixture(async (base) => {
    await makeRoot(base, 'app');
    let searches = 0;
    const input: DiscoveryInput = {
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: (signal) => {
        searches++;
        return searchFilesystem([base], { signal });
      },
    };
    const cache = new RootCache();

    assert.equal(cache.current, undefined);
    const first = await cache.get(input);
    assert.equal(cache.current, first);

    // A file edit inside a known root must not cost a second walk.
    await cache.get(input);
    assert.equal(searches, 1);

    cache.invalidate();
    assert.equal(cache.current, undefined);
    await makeRoot(base, 'second');
    const after = await cache.get(input);

    assert.equal(searches, 2);
    assert.deepEqual(after.map((root) => root.label), ['app', 'second']);
  });
});

test('a second get while one is in flight joins it rather than starting a second walk', async () => {
  await withFixture(async (base) => {
    await makeRoot(base, 'app');
    let searches = 0;
    const input: DiscoveryInput = {
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: async (signal) => {
        searches++;
        return searchFilesystem([base], { signal });
      },
    };
    const cache = new RootCache();

    const [a, b] = await Promise.all([cache.get(input), cache.get(input)]);

    assert.equal(searches, 1);
    assert.equal(a, b);
  });
});

test('a cancelled discovery is not cached', async () => {
  await withFixture(async (base) => {
    await makeRoot(base, 'app');
    const cache = new RootCache();
    const input: DiscoveryInput = {
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: (signal) => searchFilesystem([base], { signal }),
    };

    const pending = cache.get(input);
    cache.cancel();
    await pending;

    assert.equal(cache.current, undefined);

    const roots = await cache.get(input);
    assert.deepEqual(roots.map((root) => root.label), ['app']);
    assert.equal(cache.current, roots);
  });
});

// ---------------------------------------------------------------------------
// Performance (design.md D13)
// ---------------------------------------------------------------------------

/** Fourteen roots across nine repositories, with the noise a real tree carries. */
async function buildReferenceTree(base: string): Promise<void> {
  const repos = NINE_REPOS.map((repo) => path.join(base, 'work', 'platform', repo));
  await Promise.all(
    repos.map(async (repo, index) => {
      await makeRoot(repo, '.');
      // Five of the repositories carry a second root one level deeper.
      if (index < 5) {
        await makeRoot(repo, path.join('services', 'api'));
      }
      await Promise.all([
        fs.mkdir(path.join(repo, 'src', 'main', 'java'), { recursive: true }),
        fs.mkdir(path.join(repo, 'target', 'debug', 'deps'), { recursive: true }),
        ...Array.from({ length: 20 }, (_, package_) =>
          fs.mkdir(path.join(repo, 'node_modules', `pkg-${package_}`, 'lib'), { recursive: true }),
        ),
      ]);
    }),
  );
}

test('fourteen roots across nine repositories are discovered in under a second', async () => {
  await withFixture(async (base) => {
    await buildReferenceTree(base);

    const started = Date.now();
    const roots = await discoverRoots({
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: searcherOver(base),
    });
    const elapsed = Date.now() - started;

    assert.equal(roots.length, 14);
    assert.ok(elapsed < 1000, `discovery took ${elapsed} ms`);
  });
});
