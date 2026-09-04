import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addExclusion, applyExclusions, isExcluded, removeExclusion } from './exclude.ts';
import { emptyProgress } from './keys.ts';
import type { Change, LedgerModel, OpenSpecRoot, RootModel } from './types.ts';

function rootOf(path: string, changeIds: readonly string[]): RootModel {
  const root: OpenSpecRoot = {
    path,
    openspecPath: `${path}/openspec`,
    label: path.split('/').pop() ?? path,
    hasConfig: true,
    fromSettings: false,
  };
  const changes: Change[] = changeIds.map((id) => ({
    id,
    path: `${path}/openspec/changes/${id}`,
    rootPath: path,
    documents: { proposal: true, design: false, tasks: false, specs: false },
    createdInferred: false,
    undecomposed: true,
    problems: [],
  }));
  return { root, changes, progress: emptyProgress(), problems: [] };
}

const model: LedgerModel = {
  roots: [rootOf('E:/work/alpha', ['one', 'two']), rootOf('E:/work/beta', ['three'])],
  builtAt: new Date(0),
};

test('a path is excluded by itself or by any directory above it', () => {
  assert.equal(isExcluded('E:/work/alpha', ['E:/work/alpha']), true);
  assert.equal(isExcluded('E:/work/alpha/openspec/changes/one', ['E:/work/alpha']), true);
  assert.equal(isExcluded('E:/work/alphabet', ['E:/work/alpha']), false);
  assert.equal(isExcluded('E:/work/alpha', []), false);
});

test('separators and blank entries do not decide the answer', () => {
  assert.equal(isExcluded('E:/work/alpha/openspec', ['E:\\work\\alpha']), true);
  assert.equal(isExcluded('E:/work/alpha', ['', '   ']), false);
});

test('hiding a root drops it and everything under it', () => {
  const filtered = applyExclusions(model, ['E:/work/alpha']);
  assert.deepEqual(
    filtered.roots.map((entry) => entry.root.path),
    ['E:/work/beta'],
  );
});

test('hiding one change leaves its root and its siblings', () => {
  const filtered = applyExclusions(model, ['E:/work/alpha/openspec/changes/one']);
  assert.equal(filtered.roots.length, 2);
  assert.deepEqual(filtered.roots[0]?.changes.map((change) => change.id), ['two']);
});

test('an empty exclusion list returns the model itself, not a copy', () => {
  assert.equal(applyExclusions(model, []), model);
});

test('the original model is never mutated', () => {
  applyExclusions(model, ['E:/work/alpha']);
  assert.equal(model.roots.length, 2);
  assert.equal(model.roots[0]?.changes.length, 2);
});

test('adding a root supersedes the changes already hidden inside it', () => {
  const before = ['E:/work/alpha/openspec/changes/one', 'E:/work/beta'];
  assert.deepEqual(addExclusion(before, 'E:/work/alpha'), ['E:/work/beta', 'E:/work/alpha']);
});

test('adding something already covered changes nothing', () => {
  const before = ['E:/work/alpha'];
  assert.deepEqual(addExclusion(before, 'E:/work/alpha/openspec/changes/one'), before);
});

test('removing takes the entry back off the list', () => {
  assert.deepEqual(removeExclusion(['E:/work/alpha', 'E:/work/beta'], 'E:/work/alpha'), [
    'E:/work/beta',
  ]);
});
