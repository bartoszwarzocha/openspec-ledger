import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeProgress } from './keys.ts';
import { DEFAULT_STALE_AFTER_DAYS, rootStatusOf, statusOf } from './status.ts';
import type { Change, ChangeStatus, ParsedTaskFile, Stall } from './types.ts';

function changeOf(completed: number, total: number, undecomposed = false): Change {
  const taskFile: ParsedTaskFile = {
    sections: [],
    progress: makeProgress(completed, total),
    all: [],
    leaves: [],
  };
  return {
    id: 'a-change',
    path: 'E:/repo/openspec/changes/a-change',
    rootPath: 'E:/repo',
    documents: { proposal: true, design: false, tasks: !undecomposed, specs: false },
    createdInferred: false,
    undecomposed,
    problems: [],
    ...(undecomposed ? {} : { taskFile, tasksPath: 'E:/repo/openspec/changes/a-change/tasks.md' }),
  };
}

const stalled = (days: number): Stall => ({ days, fromCreation: false });

test('a change with no tasks.md is undecomposed whatever else is true of it', () => {
  assert.equal(statusOf(changeOf(0, 0, true), stalled(500)), 'undecomposed');
});

test('finished work is never stale, however long it has sat', () => {
  // What a complete change waits for is archiving, not attention.
  assert.equal(statusOf(changeOf(32, 32), stalled(400)), 'complete');
});

test('a change past the threshold is stale, one short of it is not', () => {
  assert.equal(statusOf(changeOf(61, 63), stalled(30)), 'stale');
  assert.equal(statusOf(changeOf(61, 63), stalled(29)), 'active');
  assert.equal(DEFAULT_STALE_AFTER_DAYS, 30);
});

test('the threshold is movable and zero switches the warning off', () => {
  assert.equal(statusOf(changeOf(61, 63), stalled(45), 60), 'active');
  assert.equal(statusOf(changeOf(61, 63), stalled(9), 7), 'stale');
  assert.equal(statusOf(changeOf(61, 63), stalled(9999), 0), 'active');
});

test('a change with no stall figure is active, not stale', () => {
  assert.equal(statusOf(changeOf(1, 10), undefined), 'active');
});

test('a root is green only when every decomposed change under it is complete', () => {
  const all: ChangeStatus[] = ['complete', 'complete', 'complete'];
  assert.equal(rootStatusOf(all).status, 'complete');
  assert.equal(rootStatusOf(['complete', 'active']).status, 'active');
});

test('one stale change puts the warning on the whole root', () => {
  const summary = rootStatusOf(['complete', 'active', 'stale', 'undecomposed']);
  assert.equal(summary.status, 'stale');
  assert.deepEqual(
    { complete: summary.complete, stale: summary.stale, active: summary.active, undecomposed: summary.undecomposed },
    { complete: 1, stale: 1, active: 1, undecomposed: 1 },
  );
});

test('undecomposed changes do not make a root green on their own', () => {
  // Nothing has been finished there, so the tick would be a lie.
  assert.equal(rootStatusOf(['complete', 'undecomposed']).status, 'complete');
  assert.equal(rootStatusOf(['undecomposed', 'undecomposed']).status, 'undecomposed');
});

test('an empty root is active rather than complete', () => {
  const summary = rootStatusOf([]);
  assert.equal(summary.status, 'active');
  assert.equal(summary.complete, 0);
});
