import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import type {
  Change,
  ChangeDocuments,
  LedgerModel,
  OpenSpecRoot,
  ParsedTaskFile,
  Progress,
  RootModel,
  Stall,
  Task,
  TaskSection,
  TaskState,
  TreeOptions,
} from '../model/types.ts';
import { changeKey, flattenTasks, leafTasks, makeProgress, sumProgress } from '../model/keys.ts';
import { buildOverview, noteFor } from './overview.ts';

// ---------------------------------------------------------------------------
// Fixtures - plain objects satisfying the model, never the filesystem
// ---------------------------------------------------------------------------

const MARKERS: Record<TaskState, string> = { pending: ' ', complete: 'x', 'in-progress': '-' };

const ROOT_A = '/w/alpha';
const ROOT_B = '/w/beta';

function makeTask(label: string, state: TaskState, line: number): Task {
  return {
    label,
    state,
    line,
    raw: `- [${MARKERS[state]}] ${label}`,
    indent: 0,
    children: [],
  };
}

function makeTaskFile(sections: TaskSection[]): ParsedTaskFile {
  const top = sections.flatMap((section) => section.tasks);
  const leaves = leafTasks(top);
  const completed = leaves.filter((task) => task.state === 'complete').length;
  return {
    sections,
    progress: makeProgress(completed, leaves.length),
    all: flattenTasks(top),
    leaves,
  };
}

interface ChangeOverrides {
  taskFile?: ParsedTaskFile;
  created?: Date;
  documents?: Partial<ChangeDocuments>;
}

function makeChange(id: string, rootPath: string, overrides: ChangeOverrides = {}): Change {
  const changePath = `${rootPath}/openspec/changes/${id}`;
  const taskFile = overrides.taskFile;
  return {
    id,
    path: changePath,
    rootPath,
    documents: {
      proposal: true,
      design: false,
      tasks: taskFile !== undefined,
      specs: false,
      ...overrides.documents,
    },
    created: overrides.created,
    createdInferred: false,
    tasksPath: taskFile ? `${changePath}/tasks.md` : undefined,
    taskFile,
    undecomposed: taskFile === undefined,
    problems: [],
  };
}

/** One section of `total` flat leaf tasks, the first `completed` of them ticked. */
function changeWithTasks(
  id: string,
  rootPath: string,
  completed: number,
  total: number,
  overrides: ChangeOverrides = {},
): Change {
  const tasks = Array.from({ length: total }, (_, i) =>
    makeTask(`Task ${i + 1}`, i < completed ? 'complete' : 'pending', i + 2),
  );
  return makeChange(id, rootPath, {
    ...overrides,
    taskFile: makeTaskFile([{ title: 'Work', depth: 2, line: 1, tasks }]),
  });
}

function makeRoot(label: string, rootPath: string): OpenSpecRoot {
  return {
    path: rootPath,
    openspecPath: `${rootPath}/openspec`,
    label,
    hasConfig: true,
    fromSettings: false,
  };
}

function makeRootModel(label: string, rootPath: string, changes: Change[]): RootModel {
  const parts: Progress[] = [];
  for (const change of changes) {
    if (change.taskFile) {
      parts.push(change.taskFile.progress);
    }
  }
  return { root: makeRoot(label, rootPath), changes, progress: sumProgress(parts), problems: [] };
}

function makeModel(roots: RootModel[]): LedgerModel {
  return { roots, builtAt: new Date(2026, 8, 4) };
}

function makeOptions(overrides: Partial<TreeOptions> = {}): TreeOptions {
  return {
    sortMode: 'name',
    filter: 'all',
    stalls: {},
    lastAdvanced: {},
    ...overrides,
  };
}

function stall(days: number, fromCreation = false): Stall {
  return { days, fromCreation };
}

/** The mixed fixture the filter and totals tests share. */
function mixedModel(): LedgerModel {
  return makeModel([
    makeRootModel('alpha', ROOT_A, [
      changeWithTasks('add-cache', ROOT_A, 3, 3),
      changeWithTasks('add-parser', ROOT_A, 1, 4),
      changeWithTasks('old-idea', ROOT_A, 2, 9),
      makeChange('sketch-api', ROOT_A),
    ]),
    makeRootModel('beta', ROOT_B, [changeWithTasks('drop-legacy', ROOT_B, 0, 2)]),
  ]);
}

/** `old-idea` is the only change past the threshold in `mixedModel`. */
function mixedStalls(): TreeOptions['stalls'] {
  return {
    [changeKey(ROOT_A, 'old-idea')]: stall(83),
    [changeKey(ROOT_A, 'add-parser')]: stall(4),
    [changeKey(ROOT_B, 'drop-legacy')]: stall(11),
  };
}

function ids(model: LedgerModel, options: TreeOptions): string[] {
  return buildOverview(model, options).rows.map((row) => row.changeId);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

test('one row per change, carrying its root and its numbers', () => {
  const overview = buildOverview(mixedModel(), makeOptions({ stalls: mixedStalls() }));

  assert.equal(overview.rows.length, 5);
  const first = overview.rows[0];
  assert.ok(first);
  assert.equal(first.changeId, 'add-cache');
  assert.equal(first.rootPath, ROOT_A);
  assert.equal(first.rootLabel, 'alpha');
  assert.equal(first.status, 'complete');
  assert.deepEqual(first.progress, { completed: 3, total: 3, percent: 100 });
  assert.equal(first.stall, undefined);

  const stalled = overview.rows.find((row) => row.changeId === 'old-idea');
  assert.ok(stalled);
  assert.equal(stalled.status, 'stale');
  assert.deepEqual(stalled.stall, stall(83));

  // Rows stay grouped by root, in discovery order.
  assert.deepEqual(
    overview.rows.map((row) => row.rootLabel),
    ['alpha', 'alpha', 'alpha', 'alpha', 'beta'],
  );
});

test('an undecomposed change carries no progress figure', () => {
  const overview = buildOverview(mixedModel(), makeOptions());
  const row = overview.rows.find((r) => r.changeId === 'sketch-api');

  assert.ok(row);
  assert.equal(row.status, 'undecomposed');
  assert.equal(row.progress, undefined);
  assert.equal(row.note, 'not decomposed');
});

test('the row opens what the tree opens: proposal, else design, else the directory', () => {
  const root = ROOT_A;
  const model = makeModel([
    makeRootModel('alpha', root, [
      changeWithTasks('has-proposal', root, 1, 2),
      changeWithTasks('has-design', root, 1, 2, {
        documents: { proposal: false, design: true },
      }),
      changeWithTasks('has-neither', root, 1, 2, {
        documents: { proposal: false, design: false },
      }),
    ]),
  ]);

  const paths = new Map(
    buildOverview(model, makeOptions()).rows.map((row) => [row.changeId, row.filePath]),
  );
  const dir = (id: string): string => `${root}/openspec/changes/${id}`;
  assert.equal(paths.get('has-proposal'), path.join(dir('has-proposal'), 'proposal.md'));
  assert.equal(paths.get('has-design'), path.join(dir('has-design'), 'design.md'));
  assert.equal(paths.get('has-neither'), dir('has-neither'));
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test('filter all keeps every change', () => {
  assert.deepEqual(ids(mixedModel(), makeOptions({ filter: 'all', stalls: mixedStalls() })), [
    'add-cache',
    'add-parser',
    'old-idea',
    'sketch-api',
    'drop-legacy',
  ]);
});

test('filter ready-to-archive keeps the changes the badge counts', () => {
  assert.deepEqual(
    ids(mixedModel(), makeOptions({ filter: 'ready-to-archive', stalls: mixedStalls() })),
    ['add-cache'],
  );
});

test('filter stale keeps only what is past the threshold', () => {
  assert.deepEqual(ids(mixedModel(), makeOptions({ filter: 'stale', stalls: mixedStalls() })), [
    'old-idea',
  ]);
});

test('filter stale is empty when the threshold is switched off', () => {
  assert.deepEqual(
    ids(
      mixedModel(),
      makeOptions({ filter: 'stale', stalls: mixedStalls(), staleAfterDays: 0 }),
    ),
    [],
  );
});

test('a lower threshold moves more changes into the stale filter', () => {
  assert.deepEqual(
    ids(
      mixedModel(),
      makeOptions({ filter: 'stale', stalls: mixedStalls(), staleAfterDays: 10 }),
    ),
    ['old-idea', 'drop-legacy'],
  );
});

test('filter undecomposed keeps the changes with no task list', () => {
  assert.deepEqual(
    ids(mixedModel(), makeOptions({ filter: 'undecomposed', stalls: mixedStalls() })),
    ['sketch-api'],
  );
});

test('filter unfinished keeps everything with a box still unticked', () => {
  assert.deepEqual(ids(mixedModel(), makeOptions({ filter: 'unfinished', stalls: mixedStalls() })), [
    'add-parser',
    'old-idea',
    'drop-legacy',
  ]);
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test('name orders alphabetically inside each root', () => {
  const model = makeModel([
    makeRootModel('alpha', ROOT_A, [
      changeWithTasks('zebra', ROOT_A, 1, 2),
      makeChange('acorn', ROOT_A),
      changeWithTasks('mango', ROOT_A, 1, 2),
    ]),
    makeRootModel('beta', ROOT_B, [changeWithTasks('apple', ROOT_B, 1, 2)]),
  ]);

  // The undecomposed change sorts by name like any other in this mode, and the
  // second root's change follows the first root's rather than merging into it.
  assert.deepEqual(ids(model, makeOptions({ sortMode: 'name' })), [
    'acorn',
    'mango',
    'zebra',
    'apple',
  ]);
});

test('progress orders by percentage, undecomposed last', () => {
  const model = makeModel([
    makeRootModel('alpha', ROOT_A, [
      changeWithTasks('quarter', ROOT_A, 1, 4),
      makeChange('idea', ROOT_A),
      changeWithTasks('done', ROOT_A, 2, 2),
      changeWithTasks('half', ROOT_A, 2, 4),
    ]),
  ]);

  assert.deepEqual(ids(model, makeOptions({ sortMode: 'progress' })), [
    'done',
    'half',
    'quarter',
    'idea',
  ]);
});

test('nearest-done orders by tasks remaining', () => {
  const model = makeModel([
    makeRootModel('alpha', ROOT_A, [
      changeWithTasks('two-left', ROOT_A, 0, 2),
      changeWithTasks('fourteen-left', ROOT_A, 0, 14),
      changeWithTasks('one-left', ROOT_A, 3, 4),
    ]),
  ]);

  assert.deepEqual(ids(model, makeOptions({ sortMode: 'nearest-done' })), [
    'one-left',
    'two-left',
    'fourteen-left',
  ]);
});

test('stalled orders by days since the change last advanced', () => {
  const model = makeModel([
    makeRootModel('alpha', ROOT_A, [
      changeWithTasks('fresh', ROOT_A, 1, 4),
      changeWithTasks('ancient', ROOT_A, 1, 4),
      changeWithTasks('middling', ROOT_A, 1, 4),
    ]),
  ]);
  const stalls = {
    [changeKey(ROOT_A, 'fresh')]: stall(1),
    [changeKey(ROOT_A, 'ancient')]: stall(120),
    [changeKey(ROOT_A, 'middling')]: stall(20),
  };

  assert.deepEqual(ids(model, makeOptions({ sortMode: 'stalled', stalls })), [
    'ancient',
    'middling',
    'fresh',
  ]);
});

test('created orders newest first', () => {
  const model = makeModel([
    makeRootModel('alpha', ROOT_A, [
      changeWithTasks('old', ROOT_A, 1, 4, { created: new Date(2026, 0, 5) }),
      changeWithTasks('new', ROOT_A, 1, 4, { created: new Date(2026, 7, 30) }),
      changeWithTasks('middle', ROOT_A, 1, 4, { created: new Date(2026, 3, 12) }),
    ]),
  ]);

  assert.deepEqual(ids(model, makeOptions({ sortMode: 'created' })), ['new', 'middle', 'old']);
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

test('a complete change is captioned as ready to archive', () => {
  assert.equal(noteFor('complete', makeProgress(4, 4), undefined, '2026-08-01'), 'ready to archive');
});

test('a stale change is captioned with its day count', () => {
  assert.equal(noteFor('stale', makeProgress(1, 4), stall(83), undefined), 'stalled 83 days');
  assert.equal(noteFor('stale', makeProgress(1, 4), stall(1), undefined), 'stalled 1 day');
});

test('an undecomposed change is captioned as not decomposed', () => {
  assert.equal(noteFor('undecomposed', undefined, undefined, undefined), 'not decomposed');
});

test('an active change is captioned with the date it last advanced', () => {
  assert.equal(
    noteFor('active', makeProgress(14, 15), stall(3), '2026-08-30'),
    'last advanced 2026-08-30',
  );
});

test('an active change with no recorded advance falls back to the remainder', () => {
  assert.equal(noteFor('active', makeProgress(12, 15), undefined, undefined), '3 tasks left');
  assert.equal(noteFor('active', makeProgress(14, 15), undefined, undefined), '1 task left');
});

test('a decomposed change with an empty task list says so', () => {
  assert.equal(noteFor('active', makeProgress(0, 0), undefined, '2026-08-30'), 'no tasks yet');
});

test('the note reaches the row it belongs to', () => {
  const model = mixedModel();
  const overview = buildOverview(
    model,
    makeOptions({
      stalls: mixedStalls(),
      lastAdvanced: { [changeKey(ROOT_A, 'add-parser')]: '2026-08-30' },
    }),
  );
  const notes = new Map(overview.rows.map((row) => [row.changeId, row.note]));

  assert.equal(notes.get('add-cache'), 'ready to archive');
  assert.equal(notes.get('add-parser'), 'last advanced 2026-08-30');
  assert.equal(notes.get('old-idea'), 'stalled 83 days');
  assert.equal(notes.get('sketch-api'), 'not decomposed');
  assert.equal(notes.get('drop-legacy'), '2 tasks left');
});

// ---------------------------------------------------------------------------
// Totals and empty states
// ---------------------------------------------------------------------------

test('totals count the rows on screen', () => {
  const overview = buildOverview(mixedModel(), makeOptions({ stalls: mixedStalls() }));

  assert.deepEqual(overview.totals, {
    status: 'stale',
    complete: 1,
    stale: 1,
    active: 2,
    undecomposed: 1,
  });
});

test('totals follow the filter rather than the model', () => {
  const overview = buildOverview(
    mixedModel(),
    makeOptions({ filter: 'ready-to-archive', stalls: mixedStalls() }),
  );

  assert.deepEqual(overview.totals, {
    status: 'complete',
    complete: 1,
    stale: 0,
    active: 0,
    undecomposed: 0,
  });
});

test('an empty model produces no rows and empty totals', () => {
  const overview = buildOverview(makeModel([]), makeOptions());

  assert.deepEqual(overview.rows, []);
  assert.deepEqual(overview.totals, {
    status: 'active',
    complete: 0,
    stale: 0,
    active: 0,
    undecomposed: 0,
  });
  assert.equal(overview.loading, undefined);
});

test('loading is carried through, so an empty list can say "not yet"', () => {
  const overview = buildOverview(makeModel([]), makeOptions({ loading: true }));

  assert.deepEqual(overview.rows, []);
  assert.equal(overview.loading, true);
});

test('a root with no changes contributes nothing', () => {
  const model = makeModel([
    makeRootModel('alpha', ROOT_A, []),
    makeRootModel('beta', ROOT_B, [changeWithTasks('only-one', ROOT_B, 1, 2)]),
  ]);

  assert.deepEqual(ids(model, makeOptions()), ['only-one']);
});
