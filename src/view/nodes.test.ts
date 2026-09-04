import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import type {
  Change,
  ChangeDocuments,
  FilterMode,
  LedgerModel,
  LedgerNode,
  OpenSpecRoot,
  ParsedTaskFile,
  Progress,
  RootModel,
  Task,
  TaskSection,
  TaskState,
  TreeOptions,
} from '../model/types.ts';
import { FILTER_MODES } from '../model/types.ts';
import { flattenTasks, leafTasks, makeProgress, sumProgress } from '../model/keys.ts';
import {
  buildTree,
  changeDescription,
  changeTooltip,
  countByStatus,
  countReadyToArchive,
  filterChanges,
  filterLabel,
  nodeIdFor,
  sortChanges,
} from './nodes.ts';

// ---------------------------------------------------------------------------
// Fixtures - plain objects satisfying the model, never the filesystem
// ---------------------------------------------------------------------------

const MARKERS: Record<TaskState, string> = { pending: ' ', complete: 'x', 'in-progress': '-' };

function makeTask(
  number: string | undefined,
  label: string,
  state: TaskState,
  line: number,
  children: Task[] = [],
  indent = 0,
): Task {
  const prefix = number ? `${number} ` : '';
  return {
    number,
    label,
    state,
    line,
    raw: `${' '.repeat(indent)}- [${MARKERS[state]}] ${prefix}${label}`,
    indent,
    children,
  };
}

function makeSection(title: string | undefined, line: number, tasks: Task[]): TaskSection {
  return { title, depth: title === undefined ? 0 : 2, line, tasks };
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
  createdInferred?: boolean;
  documents?: Partial<ChangeDocuments>;
  problems?: string[];
  schema?: string;
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
    schema: overrides.schema,
    created: overrides.created,
    createdInferred: overrides.createdInferred ?? false,
    tasksPath: taskFile ? `${changePath}/tasks.md` : undefined,
    taskFile,
    undecomposed: taskFile === undefined,
    problems: overrides.problems ?? [],
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
    makeTask(`1.${i + 1}`, `Task ${i + 1}`, i < completed ? 'complete' : 'pending', i + 2),
  );
  return makeChange(id, rootPath, {
    ...overrides,
    taskFile: makeTaskFile([makeSection('1. Work', 1, tasks)]),
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

// ---------------------------------------------------------------------------
// Assertion helpers - `noUncheckedIndexedAccess` means indexing needs a guard
// ---------------------------------------------------------------------------

function at(nodes: readonly LedgerNode[], index: number): LedgerNode {
  const node = nodes[index];
  if (!node) {
    throw new Error(`expected a node at index ${index}, found ${nodes.length} nodes`);
  }
  return node;
}

function labels(nodes: readonly LedgerNode[]): string[] {
  return nodes.map((node) => node.label);
}

function collect(nodes: readonly LedgerNode[], kind: LedgerNode['kind']): LedgerNode[] {
  const found: LedgerNode[] = [];
  const walk = (list: readonly LedgerNode[]): void => {
    for (const node of list) {
      if (node.kind === kind) {
        found.push(node);
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test('fourteen roots render fourteen collapsible root nodes labelled by their path', () => {
  const roots = Array.from({ length: 14 }, (_, i) =>
    makeRootModel(`work/platform/repo-${i}`, `/work/repo-${i}`, [
      changeWithTasks(`change-${i}`, `/work/repo-${i}`, 1, 2),
    ]),
  );
  const nodes = buildTree(makeModel(roots), makeOptions());

  assert.equal(nodes.length, 14);
  assert.ok(nodes.every((node) => node.kind === 'root'));
  assert.ok(nodes.every((node) => node.collapsible === 'collapsed'));
  assert.equal(at(nodes, 0).label, 'work/platform/repo-0');
  assert.equal(at(nodes, 13).label, 'work/platform/repo-13');
  assert.equal(collect(nodes, 'change').length, 14);
});

test('a single root collapses the root level away', () => {
  const root = makeRootModel('.', '/work/solo', [
    changeWithTasks('alpha', '/work/solo', 1, 2),
    changeWithTasks('bravo', '/work/solo', 2, 2),
  ]);
  const nodes = buildTree(makeModel([root]), makeOptions());

  assert.deepEqual(
    nodes.map((node) => node.kind),
    ['change', 'change'],
  );
  assert.deepEqual(labels(nodes), ['alpha', 'bravo']);
  assert.equal(collect(nodes, 'root').length, 0);
});

test('a task with two children is collapsible and contains both', () => {
  const child1 = makeTask('1.1.1', 'First half', 'complete', 3, [], 2);
  const child2 = makeTask('1.1.2', 'Second half', 'pending', 4, [], 2);
  const parent = makeTask('1.1', 'Do the thing', 'pending', 2, [child1, child2]);
  const change = makeChange('nested', '/work/solo', {
    taskFile: makeTaskFile([makeSection('1. Work', 1, [parent])]),
  });
  const nodes = buildTree(makeModel([makeRootModel('.', '/work/solo', [change])]), makeOptions());

  const section = at(at(nodes, 0).children, 0);
  const parentNode = at(section.children, 0);
  assert.equal(parentNode.label, '1.1 Do the thing');
  assert.equal(parentNode.collapsible, 'collapsed');
  assert.deepEqual(labels(parentNode.children), ['1.1.1 First half', '1.1.2 Second half']);
  // Only leaves count, so the parent is not part of the section badge.
  assert.equal(section.description, '1/2  1 left');
});

test('the tree nests root, change, section and task in that order', () => {
  const model = makeModel([
    makeRootModel('a', '/work/a', [changeWithTasks('one', '/work/a', 1, 2)]),
    makeRootModel('b', '/work/b', [changeWithTasks('two', '/work/b', 1, 2)]),
  ]);
  const nodes = buildTree(model, makeOptions());

  const root = at(nodes, 0);
  const change = at(root.children, 0);
  const section = at(change.children, 0);
  const task = at(section.children, 0);
  assert.deepEqual(
    [root.kind, change.kind, section.kind, task.kind],
    ['root', 'change', 'section', 'task'],
  );
  assert.equal(section.sectionIndex, 0);
  assert.equal(task.line, 2);
  assert.equal(task.filePath, '/work/a/openspec/changes/one/tasks.md');
});

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

test('a change with 61 of 63 tasks complete shows 61/63 and 97%', () => {
  const change = changeWithTasks('route-reads-through-data-service', '/work/solo', 61, 63);
  assert.equal(changeDescription(change), '61/63  97%');

  const nodes = buildTree(makeModel([makeRootModel('.', '/work/solo', [change])]), makeOptions());
  assert.equal(at(nodes, 0).description, '61/63  97%');
});

test('an undecomposed change shows "not decomposed" and no percentage', () => {
  const change = makeChange('spec-consistency-fixes', '/work/solo');
  assert.equal(changeDescription(change), 'not decomposed');

  const nodes = buildTree(makeModel([makeRootModel('.', '/work/solo', [change])]), makeOptions());
  const node = at(nodes, 0);
  assert.equal(node.description, 'not decomposed');
  assert.ok(!node.description?.includes('%'));
  assert.equal(node.contextValue, 'change-undecomposed');
  assert.equal(node.collapsible, 'none');
  assert.deepEqual(node.children, []);
});

test('a change at 100 percent carries a distinct icon from one below 100', () => {
  const root = makeRootModel('.', '/work/solo', [
    changeWithTasks('done', '/work/solo', 3, 3),
    changeWithTasks('going', '/work/solo', 2, 3),
    makeChange('idea', '/work/solo'),
  ]);
  const nodes = buildTree(makeModel([root]), makeOptions());
  const done = at(nodes, 0);
  const going = at(nodes, 1);
  const idea = at(nodes, 2);

  assert.equal(done.iconId, 'pass-filled');
  assert.equal(done.iconColor, 'testing.iconPassed');
  assert.equal(done.contextValue, 'change-complete');
  assert.notEqual(going.iconId, done.iconId);
  assert.equal(going.contextValue, 'change');
  assert.notEqual(idea.iconId, done.iconId);
  assert.notEqual(idea.iconId, going.iconId);
});

test('a section shows the count pair for its own leaf tasks only', () => {
  const change = makeChange('two-sections', '/work/solo', {
    taskFile: makeTaskFile([
      makeSection('1. First', 1, [
        makeTask('1.1', 'a', 'complete', 2),
        makeTask('1.2', 'b', 'complete', 3),
      ]),
      makeSection('2. Second', 4, [
        makeTask('2.1', 'c', 'complete', 5),
        makeTask('2.2', 'd', 'pending', 6),
        makeTask('2.3', 'e', 'in-progress', 7),
      ]),
    ]),
  });
  const nodes = buildTree(makeModel([makeRootModel('.', '/work/solo', [change])]), makeOptions());
  const sections = at(nodes, 0).children;

  assert.deepEqual(labels(sections), ['1. First', '2. Second']);
  assert.equal(at(sections, 0).description, '2/2');
  assert.equal(at(sections, 0).contextValue, 'section');
  assert.equal(at(sections, 1).description, '1/3  2 left');
  assert.equal(at(sections, 1).contextValue, 'section-incomplete');
  assert.equal(at(sections, 1).line, 4);

  // A finished section says so without being opened; an unfinished one is marked
  // as merely unfinished, not as a problem.
  assert.equal(at(sections, 0).iconId, 'pass-filled');
  assert.equal(at(sections, 0).iconColor, 'testing.iconPassed');
  assert.equal(at(sections, 1).iconId, 'list-unordered');
  assert.equal(at(sections, 1).iconColor, undefined);
});

test('nothing unfolds itself: a change opens onto collapsed sections', () => {
  // Expanding a change used to unfold every section and every nested task at
  // once, which on a 145-task change buries whatever the reader clicked for.
  const change = makeChange('deep', '/work/solo', {
    taskFile: makeTaskFile([
      makeSection('1. First', 1, [
        { ...makeTask('1.1', 'parent', 'pending', 2), children: [makeTask('1.1.1', 'child', 'pending', 3)] },
      ]),
    ]),
  });
  const nodes = buildTree(makeModel([makeRootModel('.', '/work/solo', [change])]), makeOptions());
  const section = at(at(nodes, 0).children, 0);

  assert.equal(section.collapsible, 'collapsed');
  assert.equal(at(section.children, 0).collapsible, 'collapsed');
});

test('the implicit section is labelled and reveals no heading line', () => {
  const change = makeChange('implicit', '/work/solo', {
    taskFile: makeTaskFile([makeSection(undefined, 0, [makeTask(undefined, 'Loose task', 'pending', 1)])]),
  });
  const nodes = buildTree(makeModel([makeRootModel('.', '/work/solo', [change])]), makeOptions());
  const section = at(at(nodes, 0).children, 0);

  assert.equal(section.label, 'Tasks');
  assert.equal(section.line, undefined);
  assert.equal(at(section.children, 0).label, 'Loose task');
});

// ---------------------------------------------------------------------------
// Task presentation
// ---------------------------------------------------------------------------

test('task icons, context values and checkboxes follow the task state', () => {
  const change = makeChange('states', '/work/solo', {
    taskFile: makeTaskFile([
      makeSection('1. Work', 1, [
        makeTask('1.1', 'Done', 'complete', 2),
        makeTask('1.2', 'Doing', 'in-progress', 3),
        makeTask('1.3', 'Todo', 'pending', 4),
      ]),
    ]),
  });
  const nodes = buildTree(makeModel([makeRootModel('.', '/work/solo', [change])]), makeOptions());
  const tasks = at(at(nodes, 0).children, 0).children;

  const complete = at(tasks, 0);
  assert.equal(complete.iconId, 'pass-filled');
  assert.equal(complete.iconColor, 'testing.iconPassed');
  assert.equal(complete.contextValue, 'task-complete');
  assert.equal(complete.checkbox, 'checked');

  const inProgress = at(tasks, 1);
  assert.notEqual(inProgress.iconId, complete.iconId);
  assert.equal(inProgress.contextValue, 'task-inprogress');
  assert.equal(inProgress.checkbox, 'unchecked');

  const pending = at(tasks, 2);
  assert.equal(pending.iconId, 'circle-outline');
  assert.equal(pending.iconColor, undefined, 'a pending task uses the default foreground');
  assert.notEqual(pending.iconId, inProgress.iconId);
  assert.equal(pending.contextValue, 'task-pending');
  assert.equal(pending.checkbox, 'unchecked');

  for (const kind of ['root', 'change', 'section', 'message'] as const) {
    for (const node of collect(nodes, kind)) {
      assert.equal(node.checkbox, undefined, `${kind} nodes carry no checkbox`);
    }
  }
});

test('a change node opens its proposal, its design, or its own directory', () => {
  const rootPath = '/work/solo';
  const withProposal = makeChange('has-proposal', rootPath);
  const withDesign = makeChange('has-design', rootPath, {
    documents: { proposal: false, design: true },
  });
  const bare = makeChange('bare', rootPath, { documents: { proposal: false, design: false } });
  const nodes = buildTree(
    makeModel([makeRootModel('.', rootPath, [bare, withDesign, withProposal])]),
    makeOptions(),
  );

  assert.equal(at(nodes, 0).filePath, bare.path);
  assert.equal(at(nodes, 1).filePath, path.join(withDesign.path, 'design.md'));
  assert.equal(at(nodes, 2).filePath, path.join(withProposal.path, 'proposal.md'));
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

const SORT_ROOT = '/work/sorted';

function sortFixture(): Change[] {
  return [
    // 2 remaining, 33%
    changeWithTasks('alpha', SORT_ROOT, 1, 3, { created: new Date(2026, 0, 1) }),
    // 1 remaining, 67%
    changeWithTasks('bravo', SORT_ROOT, 2, 3, { created: new Date(2026, 2, 1) }),
    // 14 remaining, 0%
    changeWithTasks('charlie', SORT_ROOT, 0, 14, { created: new Date(2026, 1, 1) }),
  ];
}

function sortedIds(changes: readonly Change[], options: Partial<TreeOptions> = {}): string[] {
  const merged = makeOptions(options);
  return sortChanges(changes, {
    sortMode: merged.sortMode,
    stalls: merged.stalls,
    rootPath: SORT_ROOT,
  }).map((change) => change.id);
}

test('nearest-done orders 2, 1 and 14 remaining as 1, 2, 14', () => {
  assert.deepEqual(sortedIds(sortFixture(), { sortMode: 'nearest-done' }), [
    'bravo',
    'alpha',
    'charlie',
  ]);
});

test('name sorts alphabetically and progress sorts by percentage descending', () => {
  const changes = sortFixture();
  assert.deepEqual(sortedIds(changes, { sortMode: 'name' }), ['alpha', 'bravo', 'charlie']);
  assert.deepEqual(sortedIds(changes, { sortMode: 'progress' }), ['bravo', 'alpha', 'charlie']);
});

test('stalled sorts by days descending, a change with no figure last', () => {
  const stalls = {
    [`${SORT_ROOT}::alpha`]: { days: 52, fromCreation: false },
    [`${SORT_ROOT}::bravo`]: { days: 3, fromCreation: true },
  };
  assert.deepEqual(sortedIds(sortFixture(), { sortMode: 'stalled', stalls }), [
    'alpha',
    'bravo',
    'charlie',
  ]);
});

test('created sorts by creation date descending, an undated change last', () => {
  const changes = [...sortFixture(), changeWithTasks('delta', SORT_ROOT, 0, 1)];
  assert.deepEqual(sortedIds(changes, { sortMode: 'created' }), [
    'bravo',
    'charlie',
    'alpha',
    'delta',
  ]);
});

test('undecomposed changes sort last in every mode except name', () => {
  const changes = [makeChange('aardvark', SORT_ROOT), ...sortFixture()];
  for (const mode of ['progress', 'nearest-done', 'stalled', 'created'] as const) {
    const ids = sortedIds(changes, { sortMode: mode });
    assert.equal(ids.at(-1), 'aardvark', `${mode} puts the undecomposed change last`);
  }
  assert.deepEqual(sortedIds(changes, { sortMode: 'name' }), [
    'aardvark',
    'alpha',
    'bravo',
    'charlie',
  ]);
});

test('ties break by change id, and the input array is not mutated', () => {
  const changes = [
    changeWithTasks('zulu', SORT_ROOT, 1, 2),
    changeWithTasks('mike', SORT_ROOT, 1, 2),
    changeWithTasks('alpha', SORT_ROOT, 1, 2),
  ];
  const before = changes.map((change) => change.id);
  assert.deepEqual(sortedIds(changes, { sortMode: 'progress' }), ['alpha', 'mike', 'zulu']);
  assert.deepEqual(
    changes.map((change) => change.id),
    before,
  );
});

test('the tree honours the sort mode inside every root', () => {
  const root = makeRootModel('.', SORT_ROOT, sortFixture());
  const nodes = buildTree(makeModel([root]), makeOptions({ sortMode: 'nearest-done' }));
  assert.deepEqual(labels(nodes), ['bravo', 'alpha', 'charlie']);
});

// ---------------------------------------------------------------------------
// Ready to archive
// ---------------------------------------------------------------------------

/** `total` changes of which the first `complete` are at 100 percent. */
function mixedRoot(label: string, rootPath: string, total: number, complete: number): RootModel {
  const changes = Array.from({ length: total }, (_, i) =>
    changeWithTasks(`${label}-change-${String(i).padStart(2, '0')}`, rootPath, i < complete ? 4 : 1, 4),
  );
  return makeRootModel(label, rootPath, changes);
}

function readyFixture(): LedgerModel {
  return makeModel([
    mixedRoot('one', '/work/one', 11, 4),
    mixedRoot('two', '/work/two', 12, 3),
    mixedRoot('three', '/work/three', 10, 3),
  ]);
}

test('ten of 33 changes are ready to archive and the filter shows exactly those ten', () => {
  const model = readyFixture();
  assert.equal(countReadyToArchive(model), 10);
  assert.equal(collect(buildTree(model, makeOptions()), 'change').length, 33);

  const filtered = collect(buildTree(model, makeOptions({ filter: 'ready-to-archive' })), 'change');
  assert.equal(filtered.length, 10);
  assert.ok(filtered.every((node) => node.contextValue === 'change-complete'));
  assert.ok(filtered.every((node) => node.description?.endsWith('100%')));
});

test('an undecomposed change is never counted as ready to archive', () => {
  const model = makeModel([
    makeRootModel('.', '/work/solo', [
      makeChange('idea', '/work/solo'),
      changeWithTasks('empty', '/work/solo', 0, 0),
      changeWithTasks('done', '/work/solo', 2, 2),
    ]),
  ]);
  assert.equal(countReadyToArchive(model), 1);
});

test('a root left with nothing by the filter says so rather than showing an empty list', () => {
  const model = makeModel([
    makeRootModel('one', '/work/one', [changeWithTasks('going', '/work/one', 1, 2)]),
    makeRootModel('two', '/work/two', [changeWithTasks('done', '/work/two', 2, 2)]),
  ]);
  const nodes = buildTree(model, makeOptions({ filter: 'ready-to-archive' }));

  const first = at(nodes, 0);
  assert.equal(at(first.children, 0).kind, 'message');
  assert.equal(at(first.children, 0).label, 'No change here is ready to archive.');
  assert.equal(first.description, '0 of 1 ready');
  assert.equal(at(at(nodes, 1).children, 0).kind, 'change');
});

// ---------------------------------------------------------------------------
// Status at a glance
//
// The whole point of the extension is that the reader sees the state without
// expanding anything, so these are about what a collapsed row says.
// ---------------------------------------------------------------------------

/** Stall figures keyed the way `TreeOptions` keys them. */
function stallsOf(rootPath: string, days: Record<string, number>): TreeOptions['stalls'] {
  const out: TreeOptions['stalls'] = {};
  for (const [id, value] of Object.entries(days)) {
    out[`${rootPath}::${id}`] = { days: value, fromCreation: false };
  }
  return out;
}

test('a change past the stale threshold trades its checklist for a warning', () => {
  const root = '/work/slipping';
  const model = makeModel([
    makeRootModel('.', root, [
      changeWithTasks('moving', root, 1, 4),
      changeWithTasks('parked', root, 1, 4),
    ]),
  ]);
  const nodes = buildTree(
    model,
    makeOptions({ stalls: stallsOf(root, { moving: 2, parked: 61 }) }),
  );

  const moving = at(nodes, 0);
  const parked = at(nodes, 1);
  assert.deepEqual(labels(nodes), ['moving', 'parked']);
  assert.equal(moving.iconId, 'checklist');
  assert.equal(moving.iconColor, undefined, 'an advancing change uses the default foreground');
  assert.equal(parked.iconId, 'warning');
  assert.equal(parked.iconColor, 'list.warningForeground');
  // The warning is a signal to review, not a different kind of thing, so every
  // menu bound to an ordinary change still applies.
  assert.equal(parked.contextValue, 'change');
});

test('a stale threshold of zero switches the warning off entirely', () => {
  const root = '/work/off';
  const model = makeModel([
    makeRootModel('.', root, [changeWithTasks('ancient', root, 1, 4)]),
    makeRootModel('other', '/work/other', []),
  ]);
  const stalls = stallsOf(root, { ancient: 9999 });

  const warned = buildTree(model, makeOptions({ stalls }));
  assert.equal(at(at(warned, 0).children, 0).iconId, 'warning');
  assert.equal(at(warned, 0).iconId, 'warning');

  const off = buildTree(model, makeOptions({ stalls, staleAfterDays: 0 }));
  assert.equal(at(at(off, 0).children, 0).iconId, 'checklist');
  assert.equal(at(off, 0).iconId, 'checklist');
  assert.equal(at(off, 0).description, '1 change · 25%');
});

test('a root is green only when every change under it is complete', () => {
  const nodes = buildTree(
    makeModel([
      makeRootModel('done', '/work/done', [
        changeWithTasks('a', '/work/done', 2, 2),
        changeWithTasks('b', '/work/done', 3, 3),
      ]),
      makeRootModel('mixed', '/work/mixed', [
        changeWithTasks('a', '/work/mixed', 2, 2),
        changeWithTasks('b', '/work/mixed', 1, 3),
      ]),
    ]),
    makeOptions(),
  );

  const done = at(nodes, 0);
  assert.equal(done.iconId, 'pass-filled');
  assert.equal(done.iconColor, 'testing.iconPassed');
  assert.equal(done.description, '2 changes · 2 done · 100%');

  const mixed = at(nodes, 1);
  assert.equal(mixed.iconId, 'checklist');
  assert.equal(mixed.iconColor, undefined);
  // One change of the two is finished, so the root is not green yet.
  assert.equal(mixed.description, '2 changes · 1 done · 60%');
});

test('one stale change puts the warning on the whole root', () => {
  const root = '/work/one-stale';
  const nodes = buildTree(
    makeModel([
      makeRootModel('quiet', '/work/quiet', [changeWithTasks('going', '/work/quiet', 1, 2)]),
      makeRootModel('slipping', root, [
        changeWithTasks('done', root, 2, 2),
        changeWithTasks('parked', root, 1, 4),
      ]),
    ]),
    makeOptions({ stalls: stallsOf(root, { parked: 45 }) }),
  );

  assert.equal(at(nodes, 0).iconId, 'checklist');
  const slipping = at(nodes, 1);
  assert.equal(slipping.iconId, 'warning');
  assert.equal(slipping.iconColor, 'list.warningForeground');
  assert.equal(slipping.description, '2 changes · 1 done · 1 stale · 50%');
  assert.ok(slipping.tooltip?.includes('1 not advancing'));
});

test('a root badge drops the counts that are zero and keeps the ones that are not', () => {
  const nodes = buildTree(
    makeModel([
      makeRootModel('ideas', '/work/ideas', [
        makeChange('one', '/work/ideas'),
        makeChange('two', '/work/ideas'),
      ]),
      makeRootModel('busy', '/work/busy', [changeWithTasks('going', '/work/busy', 1, 4)]),
    ]),
    makeOptions(),
  );

  const ideas = at(nodes, 0);
  // Nothing was ever broken down here, so there is no denominator to show.
  assert.equal(ideas.iconId, 'lightbulb');
  assert.equal(ideas.description, '2 changes');

  const busy = at(nodes, 1);
  assert.equal(busy.description, '1 change · 25%');
  assert.ok(!busy.description?.includes('0 '), 'a zero count is dropped, not printed');
});

test('a proposal nobody broke down does not keep its root out of the green', () => {
  const root = '/work/mostly-done';
  const nodes = buildTree(
    makeModel([
      makeRootModel('mostly', root, [
        changeWithTasks('a', root, 2, 2),
        makeChange('idea', root),
      ]),
      makeRootModel('other', '/work/other', []),
    ]),
    makeOptions(),
  );
  assert.equal(at(nodes, 0).iconId, 'pass-filled');
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const FILTER_ROOT = '/work/filters';

/** One change of every state the filters ask about. */
function filterChangesFixture(): Change[] {
  return [
    changeWithTasks('done', FILTER_ROOT, 3, 3),
    changeWithTasks('empty', FILTER_ROOT, 0, 0),
    changeWithTasks('going', FILTER_ROOT, 1, 3),
    makeChange('idea', FILTER_ROOT),
    changeWithTasks('parked', FILTER_ROOT, 2, 5),
  ];
}

const FILTER_STALLS = stallsOf(FILTER_ROOT, { parked: 90 });

/** What each filter is supposed to keep, in alphabetical order. */
const FILTER_EXPECTATIONS: Record<FilterMode, string[]> = {
  all: ['done', 'empty', 'going', 'idea', 'parked'],
  'ready-to-archive': ['done'],
  stale: ['parked'],
  // `empty` has a `tasks.md` with no lines in it, which is neither complete nor
  // stale nor undecomposed, so it counts as in progress.
  active: ['empty', 'going'],
  undecomposed: ['idea'],
  // Neither an untouched `tasks.md` with no lines nor a proposal without one has
  // an open task in it.
  unfinished: ['going', 'parked'],
};

test('each filter keeps exactly the changes it names', () => {
  for (const filter of FILTER_MODES) {
    const kept = filterChanges(
      filterChangesFixture(),
      makeOptions({ filter, stalls: FILTER_STALLS }),
    );
    assert.deepEqual(
      kept.map((change) => change.id),
      FILTER_EXPECTATIONS[filter],
      `the ${filter} filter keeps the right changes`,
    );
  }
});

test('the tree shows exactly what the filter kept', () => {
  const model = makeModel([makeRootModel('.', FILTER_ROOT, filterChangesFixture())]);
  for (const filter of FILTER_MODES) {
    const nodes = buildTree(model, makeOptions({ filter, stalls: FILTER_STALLS }));
    assert.deepEqual(
      labels(collect(nodes, 'change')),
      FILTER_EXPECTATIONS[filter],
      `the tree under the ${filter} filter`,
    );
  }
});

test('the stale filter moves with the threshold and empties at zero', () => {
  const keep = (staleAfterDays: number): string[] =>
    filterChanges(
      filterChangesFixture(),
      makeOptions({ filter: 'stale', stalls: FILTER_STALLS, staleAfterDays }),
    ).map((change) => change.id);

  assert.deepEqual(keep(90), ['parked']);
  assert.deepEqual(keep(91), []);
  assert.deepEqual(keep(0), [], 'zero switches the stale state off, so nothing is stale');
});

test('a filter that empties a root says which filter did it', () => {
  const model = makeModel([
    makeRootModel('one', '/work/one', [changeWithTasks('going', '/work/one', 1, 2)]),
    makeRootModel('two', '/work/two', [changeWithTasks('going', '/work/two', 1, 2)]),
  ]);
  const expected: Array<[FilterMode, string, string]> = [
    ['ready-to-archive', 'No change here is ready to archive.', '0 of 1 ready'],
    ['stale', 'No change here is stale.', '0 of 1 stale'],
    ['undecomposed', 'No change here is undecomposed.', '0 of 1 not decomposed'],
  ];

  for (const [filter, label, description] of expected) {
    const root = at(buildTree(model, makeOptions({ filter })), 0);
    const message = at(root.children, 0);
    assert.equal(message.kind, 'message', `${filter} yields a message, not an empty list`);
    assert.equal(message.label, label);
    assert.ok(
      message.tooltip?.includes(filterLabel('all')),
      'the message says how to get the other changes back',
    );
    assert.equal(root.description, description);
  }
});

test('every filter mode has a distinct label for the view title', () => {
  const all = FILTER_MODES.map(filterLabel);
  assert.equal(new Set(all).size, FILTER_MODES.length);
  assert.ok(all.every((label) => label.length > 0 && label === label.trim()));
  assert.equal(filterLabel('all'), 'All changes');
  assert.equal(filterLabel('ready-to-archive'), 'Ready to archive');
});

test('countByStatus counts every change across every root', () => {
  const model = makeModel([
    makeRootModel('.', FILTER_ROOT, filterChangesFixture()),
    makeRootModel('other', '/work/other', [changeWithTasks('done', '/work/other', 1, 1)]),
  ]);
  const counts = countByStatus(model, makeOptions({ stalls: FILTER_STALLS }));

  assert.deepEqual(counts, {
    status: 'stale',
    complete: 2,
    stale: 1,
    active: 2,
    undecomposed: 1,
  });
  assert.equal(countReadyToArchive(model), counts.complete);
});

test('the ready-to-archive count ignores how long the work has sat', () => {
  const root = '/work/ancient';
  const model = makeModel([makeRootModel('.', root, [changeWithTasks('done', root, 4, 4)])]);
  const counts = countByStatus(model, makeOptions({ stalls: stallsOf(root, { done: 4000 }) }));

  // Finished work is never stale; what it waits for is archiving, not attention.
  assert.equal(counts.complete, 1);
  assert.equal(counts.stale, 0);
  assert.equal(countReadyToArchive(model), 1);
});

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

test('a root whose changes directory is empty gets a child saying so', () => {
  const model = makeModel([
    makeRootModel('empty', '/work/empty', []),
    makeRootModel('busy', '/work/busy', [changeWithTasks('going', '/work/busy', 1, 2)]),
  ]);
  const nodes = buildTree(model, makeOptions());
  const child = at(at(nodes, 0).children, 0);

  assert.equal(child.kind, 'message');
  assert.equal(child.label, 'This root holds no active changes.');
  assert.equal(child.collapsible, 'none');
  assert.equal(at(nodes, 0).description, '0 changes');
});

test('a lone empty root puts its message at the top level', () => {
  const nodes = buildTree(makeModel([makeRootModel('solo', '/work/solo', [])]), makeOptions());
  assert.equal(nodes.length, 1);
  assert.equal(at(nodes, 0).kind, 'message');
  assert.equal(at(nodes, 0).label, 'This root holds no active changes.');
});

test('a tasks.md with no task lines is 0/0, not undecomposed, and explains itself', () => {
  const change = makeChange('empty-tasks', '/work/solo', { taskFile: makeTaskFile([]) });
  assert.equal(changeDescription(change), '0/0  0%');

  const nodes = buildTree(makeModel([makeRootModel('.', '/work/solo', [change])]), makeOptions());
  const node = at(nodes, 0);
  assert.equal(node.contextValue, 'change');
  assert.equal(at(node.children, 0).kind, 'message');
});

test('no roots leaves the tree empty for the welcome content, unless discovery is running', () => {
  const empty = makeModel([]);
  assert.deepEqual(buildTree(empty, makeOptions()), []);

  const loading = buildTree(empty, makeOptions({ loading: true }));
  assert.equal(loading.length, 1);
  assert.equal(at(loading, 0).kind, 'message');
});

// ---------------------------------------------------------------------------
// Identity and tooltips
// ---------------------------------------------------------------------------

test('node ids are stable across rebuilds and unique within one tree', () => {
  const build = (): LedgerNode[] => {
    const change = makeChange('stable', '/work/solo', {
      taskFile: makeTaskFile([
        makeSection('1. Work', 1, [
          makeTask('1.1', 'Same text', 'pending', 2),
          // A duplicate label must still yield a distinct id.
          makeTask('1.1', 'Same text', 'pending', 3),
        ]),
      ]),
    });
    return buildTree(makeModel([makeRootModel('.', '/work/solo', [change])]), makeOptions());
  };

  const ids = (nodes: readonly LedgerNode[]): string[] => {
    const out: string[] = [];
    const walk = (list: readonly LedgerNode[]): void => {
      for (const node of list) {
        out.push(node.id);
        walk(node.children);
      }
    };
    walk(nodes);
    return out;
  };

  const first = ids(build());
  assert.deepEqual(first, ids(build()));
  assert.equal(new Set(first).size, first.length);
});

test('a task id survives the tick that completes it', () => {
  const pending = makeTask('1.1', 'Wire the registry', 'pending', 7);
  const complete = makeTask('1.1', 'Wire the registry', 'complete', 9);
  const idOf = (task: Task): string => {
    const change = makeChange('ticking', '/work/solo', {
      taskFile: makeTaskFile([makeSection('1. Work', 1, [task])]),
    });
    const nodes = buildTree(makeModel([makeRootModel('.', '/work/solo', [change])]), makeOptions());
    return at(at(at(nodes, 0).children, 0).children, 0).id;
  };
  assert.equal(idOf(pending), idOf(complete));
});

test('nodeIdFor is deterministic and separator-insensitive', () => {
  assert.equal(nodeIdFor('root', 'C:\\work\\repo'), 'root::C:/work/repo');
  assert.equal(nodeIdFor('change', '/work/repo', 'alpha'), 'change::/work/repo::alpha');
  assert.equal(nodeIdFor('section', '/work/repo', 'alpha', 2), 'section::/work/repo::alpha::2');
});

test('the change tooltip reports counts, dates and stall without accusing anyone', () => {
  const change = changeWithTasks('route-reads-through-data-service', '/work/solo', 61, 63, {
    created: new Date(2026, 1, 13),
    documents: { proposal: true, design: true },
    schema: '1.0',
  });
  const tooltip = changeTooltip(change, { days: 52, fromCreation: false }, '2026-07-14');

  assert.ok(tooltip.includes('`route-reads-through-data-service`'));
  assert.ok(tooltip.includes('61 of 63 tasks complete (97%)'));
  assert.ok(tooltip.includes('Created 2026-02-13'));
  assert.ok(tooltip.includes('Last advanced 2026-07-14'));
  assert.ok(tooltip.includes('Stalled 52 days'));
  assert.ok(tooltip.includes('proposal.md'));
  assert.ok(!tooltip.includes('(inferred'));
});

test('the tooltip of an undecomposed change names the missing file, not a failure', () => {
  const change = makeChange('idea', '/work/solo', {
    created: new Date(2026, 0, 5),
    createdInferred: true,
    problems: ['`.openspec.yaml` could not be parsed'],
  });
  const tooltip = changeTooltip(change, { days: 9, fromCreation: true }, undefined);

  assert.ok(tooltip.includes('has not been decomposed into tasks yet'));
  assert.ok(!tooltip.includes('%'));
  assert.ok(tooltip.includes('Created 2026-01-05 (inferred from file dates)'));
  assert.ok(tooltip.includes('Stalled 9 days, measured from creation'));
  assert.ok(tooltip.includes('- `.openspec.yaml` could not be parsed'));
});

test('a one-day stall reads in the singular', () => {
  const change = changeWithTasks('yesterday', '/work/solo', 1, 2);
  assert.ok(changeTooltip(change, { days: 1, fromCreation: false }, undefined).includes('Stalled 1 day'));
});
