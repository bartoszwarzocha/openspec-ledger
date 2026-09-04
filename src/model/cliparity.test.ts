import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countingDifference, openspecListProgress } from './cliparity.ts';
import { parseTasks } from './parser.ts';

/**
 * The expectations below are not guesses. Each was measured against
 * `openspec` 1.2.0 with `openspec list --json` on 2026-09-04, so if the CLI ever
 * changes its counting rule these tests are what will notice.
 */

test('the CLI drops both in-progress markers, from the total as well as the count', () => {
  // Probe: five flat lines -> openspec reported completedTasks 2, totalTasks 3.
  const file = parseTasks(
    ['# Tasks', '', '## 1. Probe', '', '- [x] 1.1 done', '- [ ] 1.2 pending', '- [-] 1.3 dash', '- [~] 1.4 tilde', '- [X] 1.5 capital'].join('\n'),
  );
  assert.deepEqual(
    { c: openspecListProgress(file).completed, t: openspecListProgress(file).total },
    { c: 2, t: 3 },
  );
  // Ours counts the started work towards the total.
  assert.deepEqual({ c: file.progress.completed, t: file.progress.total }, { c: 2, t: 5 });
});

test('the CLI counts top-level tasks only, ignoring the children that carry the work', () => {
  // Probe: two parents with three children -> openspec reported 1 of 2.
  const file = parseTasks(
    [
      '# Tasks',
      '',
      '## 1. Probe',
      '',
      '- [x] 1.1 parent complete',
      '  - [x] 1.1.1 child one',
      '  - [x] 1.1.2 child two',
      '- [ ] 1.2 parent pending',
      '  - [ ] 1.2.1 child three',
    ].join('\n'),
  );
  assert.deepEqual(
    { c: openspecListProgress(file).completed, t: openspecListProgress(file).total },
    { c: 1, t: 2 },
  );
  assert.deepEqual({ c: file.progress.completed, t: file.progress.total }, { c: 2, t: 3 });
});

test('a flat list with no in-progress markers counts the same either way', () => {
  const file = parseTasks(['## 1. Flat', '- [x] 1.1 a', '- [x] 1.2 b', '- [ ] 1.3 c'].join('\n'));
  assert.deepEqual(openspecListProgress(file), file.progress);
  assert.equal(countingDifference(file), undefined, 'nothing to explain, so nothing is shown');
});

test('a difference names the in-progress markers it is caused by', () => {
  const file = parseTasks(['## 1. Probe', '- [x] 1.1 a', '- [~] 1.2 b', '- [ ] 1.3 c'].join('\n'));
  const difference = countingDifference(file);
  assert.ok(difference);
  assert.deepEqual({ c: difference.cli.completed, t: difference.cli.total }, { c: 1, t: 2 });
  assert.deepEqual({ c: difference.ours.completed, t: difference.ours.total }, { c: 1, t: 3 });
  assert.match(difference.reason, /openspec list` reports 1\/2/);
  assert.match(difference.reason, /drops 1 in-progress task/);
});

test('a difference names nesting when that is the cause', () => {
  const file = parseTasks(
    ['## 1. Probe', '- [ ] 1.1 parent', '  - [x] 1.1.1 child', '  - [ ] 1.1.2 child'].join('\n'),
  );
  const difference = countingDifference(file);
  assert.ok(difference);
  assert.match(difference.reason, /only top-level tasks/);
  assert.doesNotMatch(difference.reason, /in-progress/);
});

test('an absent task file has no difference to report', () => {
  assert.equal(countingDifference(undefined), undefined);
});

test('the reference file that first showed the divergence still matches the CLI', () => {
  // openspec list said 8/11 for this change; the extension says 8/12.
  const lines = ['## 1. Tasks'];
  for (let index = 1; index <= 9; index++) {
    lines.push(`- [${index === 7 ? '~' : 'x'}] ${index}. task ${index}`);
  }
  for (const letter of ['A', 'B', 'C']) {
    lines.push(`- [ ] ${letter}. deploy step ${letter}`);
  }
  const file = parseTasks(lines.join('\n'));
  assert.deepEqual(
    { c: openspecListProgress(file).completed, t: openspecListProgress(file).total },
    { c: 8, t: 11 },
  );
  assert.deepEqual({ c: file.progress.completed, t: file.progress.total }, { c: 8, t: 12 });
});
