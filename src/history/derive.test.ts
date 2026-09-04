import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Change, ChangeHistory, ParsedTaskFile, ProgressSnapshot } from '../model/types.ts';
import { makeProgress } from '../model/keys.ts';
import { lastAdvanced, movementSince, stallOf } from './derive.ts';

const TODAY = '2026-09-04';

function taskFileOf(completed: number, total: number): ParsedTaskFile {
  // Derivation reads only the progress figure, so the task lists stay empty.
  return { sections: [], progress: makeProgress(completed, total), all: [], leaves: [] };
}

function changeOf(options: {
  completed?: number;
  total?: number;
  created?: string;
  undecomposed?: boolean;
}): Change {
  const change: Change = {
    id: 'route-reads-through-data-service',
    path: '/repo/openspec/changes/route-reads-through-data-service',
    rootPath: '/repo',
    documents: { proposal: true, design: true, tasks: !options.undecomposed, specs: true },
    createdInferred: false,
    undecomposed: options.undecomposed ?? false,
    problems: [],
  };
  if (!options.undecomposed) {
    change.tasksPath = `${change.path}/tasks.md`;
    change.taskFile = taskFileOf(options.completed ?? 0, options.total ?? 0);
  }
  if (options.created) {
    const [year, month, day] = options.created.split('-').map(Number);
    change.created = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  }
  return change;
}

function historyOf(entries: ReadonlyArray<[string, number, number]>): ChangeHistory {
  const snapshots: ProgressSnapshot[] = entries.map(([date, completed, total]) => ({
    date,
    completed,
    total,
    source: 'backfilled',
  }));
  return { changeId: 'route-reads-through-data-service', snapshots, completions: {} };
}

test('movement counts the tasks completed since a date', () => {
  const history = historyOf([
    ['2026-08-21', 52, 63],
    ['2026-08-28', 55, 63],
    ['2026-09-02', 58, 63],
  ]);
  const movement = movementSince(history, '2026-08-28', changeOf({ completed: 61, total: 63 }));

  assert.equal(movement.completedSince, 6);
  assert.equal(movement.startCompleted, 55);
  assert.equal(movement.startTotal, 63);
  assert.equal(movement.newInPeriod, false);
  assert.equal(movement.lastAdvanced, '2026-09-02');
});

test('movement measures against the live figure, not the last snapshot', () => {
  const history = historyOf([['2026-08-28', 55, 63]]);
  const movement = movementSince(history, '2026-08-28', changeOf({ completed: 57, total: 63 }));
  assert.equal(movement.completedSince, 2);
});

test('a count that fell is reported as no movement', () => {
  const history = historyOf([['2026-08-28', 55, 63]]);
  const movement = movementSince(history, '2026-08-28', changeOf({ completed: 54, total: 63 }));
  assert.equal(movement.completedSince, 0);
  assert.equal(movement.startCompleted, 55);
});

test('a change created inside the period starts from zero and is marked new', () => {
  const history = historyOf([['2026-09-02', 2, 12]]);
  const change = changeOf({ completed: 3, total: 12, created: '2026-09-01' });
  const movement = movementSince(history, '2026-08-28', change);

  assert.equal(movement.newInPeriod, true);
  assert.equal(movement.startCompleted, 0);
  assert.equal(movement.startTotal, 12);
  assert.equal(movement.completedSince, 3);
});

test('history that does not reach back reports no starting figure', () => {
  const history = historyOf([
    ['2026-09-02', 4, 12],
    ['2026-09-03', 5, 12],
  ]);
  const change = changeOf({ completed: 6, total: 12, created: '2026-05-01' });
  const movement = movementSince(history, '2026-08-28', change);

  assert.equal(movement.startCompleted, undefined);
  assert.equal(movement.startTotal, undefined);
  assert.equal(movement.newInPeriod, false);
  // What can honestly be said is the movement since the record begins.
  assert.equal(movement.completedSince, 2);
});

test('a change with no history at all reports no movement', () => {
  const movement = movementSince(undefined, '2026-08-28', changeOf({ completed: 61, total: 63 }));
  assert.deepEqual(movement, { completedSince: 0, newInPeriod: false });
});

test('last advanced is the date of the last rise in the completed count', () => {
  const history = historyOf([
    ['2026-07-01', 40, 63],
    ['2026-07-14', 61, 63],
    ['2026-08-20', 61, 63],
    ['2026-09-04', 61, 63],
  ]);
  assert.equal(lastAdvanced(history), '2026-07-14');
});

test('a change that never advanced has no last-advanced date', () => {
  assert.equal(lastAdvanced(historyOf([['2026-07-01', 0, 12], ['2026-08-01', 0, 12]])), undefined);
  // One snapshot is where the record begins, not an advance within it.
  assert.equal(lastAdvanced(historyOf([['2026-07-01', 7, 12]])), undefined);
  assert.equal(lastAdvanced(undefined), undefined);
});

test('snapshots out of order are still read forwards', () => {
  const history = historyOf([
    ['2026-08-01', 5, 12],
    ['2026-07-01', 1, 12],
    ['2026-07-20', 3, 12],
  ]);
  assert.equal(lastAdvanced(history), '2026-08-01');
});

test('a stall is the whole days since the change last advanced', () => {
  const history = historyOf([
    ['2026-07-01', 40, 63],
    ['2026-07-14', 61, 63],
  ]);
  assert.deepEqual(stallOf(history, changeOf({ completed: 61, total: 63 }), TODAY), {
    days: 52,
    fromCreation: false,
  });
});

test('a change that advanced yesterday has been still for one day', () => {
  const history = historyOf([
    ['2026-09-02', 60, 63],
    ['2026-09-03', 61, 63],
  ]);
  assert.deepEqual(stallOf(history, changeOf({ completed: 61, total: 63 }), TODAY), {
    days: 1,
    fromCreation: false,
  });
});

test('a change at 100 percent is never stalled', () => {
  const history = historyOf([
    ['2026-06-01', 40, 63],
    ['2026-06-06', 63, 63],
  ]);
  assert.equal(stallOf(history, changeOf({ completed: 63, total: 63 }), TODAY), undefined);
});

test('a stall is measured from creation when nothing ever advanced', () => {
  const history = historyOf([
    ['2026-07-14', 0, 63],
    ['2026-08-30', 0, 63],
  ]);
  const change = changeOf({ completed: 0, total: 63, created: '2026-07-14' });
  assert.deepEqual(stallOf(history, change, TODAY), { days: 52, fromCreation: true });
  // The same holds with no record at all, which is the state on a first run
  // outside a git repository.
  assert.deepEqual(stallOf(undefined, change, TODAY), { days: 52, fromCreation: true });
});

test('nothing is measured without a date to measure from', () => {
  assert.equal(stallOf(undefined, changeOf({ completed: 1, total: 63 }), TODAY), undefined);
});

test('an undecomposed change is never stalled', () => {
  const change = changeOf({ undecomposed: true, created: '2026-01-01' });
  assert.equal(stallOf(undefined, change, TODAY), undefined);
});

test('an empty task list is not treated as complete', () => {
  const change = changeOf({ completed: 0, total: 0, created: '2026-08-28' });
  assert.deepEqual(stallOf(undefined, change, TODAY), { days: 7, fromCreation: true });
});
