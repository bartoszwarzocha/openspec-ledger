import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays,
  changeKey,
  daysBetween,
  fromDateKey,
  isComplete,
  isPathInside,
  makeProgress,
  normalizePath,
  pathsEqual,
  sumProgress,
  taskKey,
  toDateKey,
} from './keys.ts';

test('taskKey survives the tick that completes a task', () => {
  const pending = '- [ ] 1.1 Initialise the repository';
  const complete = '- [x] 1.1 Initialise the repository';
  assert.equal(taskKey(pending), taskKey(complete));
  assert.equal(taskKey(pending), '1.1 Initialise the repository');
});

test('taskKey ignores re-indentation and marker style', () => {
  assert.equal(taskKey('  - [ ] 2.1 Do a thing'), taskKey('* [X] 2.1 Do  a   thing'));
});

test('taskKey falls back to the raw line when it is not a task', () => {
  assert.equal(taskKey('## 1. Section'), '## 1. Section');
});

test('progress reserves 100 percent for genuinely complete work', () => {
  assert.deepEqual(makeProgress(109, 110), { completed: 109, total: 110, percent: 99 });
  assert.deepEqual(makeProgress(32, 32), { completed: 32, total: 32, percent: 100 });
  assert.deepEqual(makeProgress(0, 0), { completed: 0, total: 0, percent: 0 });
  assert.equal(makeProgress(61, 63).percent, 97);
});

test('isComplete is false for an empty task list', () => {
  assert.equal(isComplete(makeProgress(0, 0)), false);
  assert.equal(isComplete(makeProgress(3, 3)), true);
  assert.equal(isComplete(undefined), false);
});

test('sumProgress aggregates and re-derives the percentage', () => {
  const total = sumProgress([makeProgress(1, 2), makeProgress(3, 4)]);
  assert.deepEqual(total, { completed: 4, total: 6, percent: 67 });
});

test('calendar days round-trip and subtract', () => {
  const key = toDateKey(new Date(2026, 6, 14));
  assert.equal(key, '2026-07-14');
  assert.equal(toDateKey(fromDateKey(key)), key);
  assert.equal(daysBetween('2026-07-14', '2026-09-04'), 52);
  assert.equal(daysBetween('2026-09-04', '2026-07-14'), -52);
  assert.equal(addDays('2026-08-21', -7), '2026-08-14');
});

test('daysBetween is unaffected by a daylight-saving boundary', () => {
  // Central European summer time ends on the last Sunday of October.
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2);
});

test('paths compare case-insensitively on Windows and macOS', () => {
  assert.equal(normalizePath('E:\\AI\\openspec-ledger\\'), 'E:/AI/openspec-ledger');
  const insensitive = process.platform === 'win32' || process.platform === 'darwin';
  assert.equal(pathsEqual('E:/AI/Foo', 'e:/ai/foo'), insensitive);
  assert.equal(isPathInside('E:/AI/Foo/bar/baz.ts', 'E:/AI/Foo'), true);
  assert.equal(isPathInside('E:/AI/Foobar', 'E:/AI/Foo'), false);
  assert.equal(isPathInside('E:/AI/Foo', 'E:/AI/Foo'), true);
});

test('changeKey separates root from change', () => {
  assert.equal(changeKey('E:/a', 'add-x'), 'E:/a::add-x');
});
