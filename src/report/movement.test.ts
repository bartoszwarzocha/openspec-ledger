import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMovementReport, renderMovementReport } from './movement.ts';
import type { MovementReportInput } from './movement.ts';
import { emptyProgress, makeProgress, sumProgress } from '../model/keys.ts';
import type {
  Change,
  ChangeHistory,
  LedgerModel,
  Movement,
  RootModel,
  Stall,
} from '../model/types.ts';

const TODAY = '2026-09-04';

type Derivation = NonNullable<MovementReportInput['derive']>;

function decomposed(id: string, completed: number, total: number): Change {
  return {
    id,
    path: `/work/alpha/openspec/changes/${id}`,
    rootPath: '/work/alpha',
    documents: { proposal: true, design: false, tasks: true, specs: false },
    createdInferred: false,
    tasksPath: `/work/alpha/openspec/changes/${id}/tasks.md`,
    taskFile: {
      sections: [],
      progress: makeProgress(completed, total),
      all: [],
      leaves: [],
    },
    undecomposed: false,
    problems: [],
  };
}

function undecomposed(id: string): Change {
  return {
    id,
    path: `/work/alpha/openspec/changes/${id}`,
    rootPath: '/work/alpha',
    documents: { proposal: true, design: false, tasks: false, specs: false },
    createdInferred: false,
    undecomposed: true,
    problems: [],
  };
}

function root(label: string, changes: Change[], rootPath = '/work/alpha'): RootModel {
  return {
    root: {
      path: rootPath,
      openspecPath: `${rootPath}/openspec`,
      label,
      hasConfig: true,
      fromSettings: false,
    },
    changes: changes.map((change) => ({ ...change, rootPath })),
    progress: sumProgress(
      changes
        .filter((change) => !change.undecomposed)
        .map((change) => change.taskFile?.progress ?? emptyProgress()),
    ),
    problems: [],
  };
}

function model(...roots: RootModel[]): LedgerModel {
  return { roots, builtAt: new Date('2026-09-04T09:00:00Z') };
}

/** A derivation driven by fixtures, so the report is tested apart from the history store. */
function derivation(
  movements: Record<string, Movement>,
  stalls: Record<string, Stall> = {},
): Derivation {
  return {
    movementSince: (_history, _since, change) =>
      movements[change.id] ?? { completedSince: 0, newInPeriod: false },
    stallOf: (_history, change, _today) => stalls[change.id],
  };
}

function moved(completedSince: number, startCompleted: number, startTotal: number): Movement {
  return { completedSince, startCompleted, startTotal, lastAdvanced: TODAY, newInPeriod: false };
}

function still(startCompleted: number, startTotal: number, lastAdvanced?: string): Movement {
  return { completedSince: 0, startCompleted, startTotal, lastAdvanced, newInPeriod: false };
}

function report(input: Partial<MovementReportInput> & Pick<MovementReportInput, 'model'>) {
  return buildMovementReport({
    days: 7,
    today: TODAY,
    historyFor: () => undefined,
    ...input,
  });
}

test('the period runs back from today by the requested number of days', () => {
  const result = report({
    model: model(root('alpha', [])),
    derive: derivation({}),
  });
  assert.equal(result.since, '2026-08-28');
  assert.equal(result.generatedFor, TODAY);
  assert.equal(result.days, 7);
});

test('a period of zero days is clamped rather than reported as an empty week', () => {
  const result = report({ model: model(), days: 0, derive: derivation({}) });
  assert.equal(result.days, 1);
  assert.equal(result.since, '2026-09-03');
});

test('a change that advanced is listed as moved with its start, now and count', () => {
  const result = report({
    model: model(root('alpha', [decomposed('route-reads-through-data-service', 61, 63)])),
    derive: derivation({ 'route-reads-through-data-service': moved(6, 55, 63) }, {}),
  });

  assert.equal(result.didNotMove.length, 0);
  assert.equal(result.moved.length, 1);
  const row = result.moved[0];
  assert.ok(row);
  assert.equal(row.changeId, 'route-reads-through-data-service');
  assert.equal(row.rootLabel, 'alpha');
  assert.equal(row.rootPath, '/work/alpha');
  assert.equal(row.startCompleted, 55);
  assert.equal(row.startTotal, 63);
  assert.equal(row.nowCompleted, 61);
  assert.equal(row.nowTotal, 63);
  assert.equal(row.completedInPeriod, 6);
  assert.equal(row.newInPeriod, false);
  assert.equal(row.complete, false);
});

test('a change that did not advance is listed under did not move, with its stall', () => {
  const result = report({
    model: model(root('alpha', [decomposed('add-lookup-provider', 61, 63)])),
    derive: derivation(
      { 'add-lookup-provider': still(61, 63, '2026-07-14') },
      { 'add-lookup-provider': { days: 52, fromCreation: false } },
    ),
  });

  assert.equal(result.moved.length, 0);
  const row = result.didNotMove[0];
  assert.ok(row);
  assert.equal(row.changeId, 'add-lookup-provider');
  assert.equal(row.completedInPeriod, 0);
  assert.deepEqual(row.stall, { days: 52, fromCreation: false });
});

test('a change created inside the period starts at zero and is marked new', () => {
  const result = report({
    model: model(root('alpha', [decomposed('add-ledger-report', 3, 12)])),
    derive: derivation({
      'add-ledger-report': { completedSince: 3, newInPeriod: true, lastAdvanced: TODAY },
    }),
  });

  const row = result.moved[0];
  assert.ok(row);
  assert.equal(row.newInPeriod, true);
  assert.equal(row.startCompleted, 0);
  assert.equal(row.startTotal, 0);
  assert.equal(row.completedInPeriod, 3);
});

test('an undecomposed change is named separately and appears in neither list', () => {
  const result = report({
    model: model(
      root('alpha', [decomposed('has-tasks', 1, 4), undecomposed('never-decomposed')]),
    ),
    derive: derivation({ 'has-tasks': moved(1, 0, 4) }),
  });

  assert.deepEqual(result.undecomposed, [{ rootLabel: 'alpha', changeId: 'never-decomposed' }]);
  const listed = [...result.moved, ...result.didNotMove].map((row) => row.changeId);
  assert.deepEqual(listed, ['has-tasks']);
});

test('a change at 100 percent is never reported as stalled', () => {
  const result = report({
    model: model(root('alpha', [decomposed('finished', 32, 32)])),
    // A derivation that answers with a stall regardless: the report must still
    // refuse to call a finished change stalled.
    derive: derivation({ finished: still(32, 32, '2026-06-06') }, {
      finished: { days: 90, fromCreation: false },
    }),
  });

  const row = result.didNotMove[0];
  assert.ok(row);
  assert.equal(row.complete, true);
  assert.equal(row.stall, undefined);
  assert.match(renderMovementReport(result), /\| complete\b/);
});

test('did-not-move rows are ordered by days stalled, longest first', () => {
  const result = report({
    model: model(
      root('alpha', [
        decomposed('recent', 1, 9),
        decomposed('ancient', 2, 9),
        decomposed('unmeasured', 3, 9),
        decomposed('middling', 4, 9),
      ]),
    ),
    derive: derivation(
      {},
      {
        recent: { days: 1, fromCreation: false },
        ancient: { days: 90, fromCreation: true },
        middling: { days: 12, fromCreation: false },
      },
    ),
  });

  assert.deepEqual(
    result.didNotMove.map((row) => row.changeId),
    ['ancient', 'middling', 'recent', 'unmeasured'],
  );
});

test('moved rows are ordered by tasks completed, most first', () => {
  const result = report({
    model: model(root('alpha', [decomposed('few', 2, 9), decomposed('many', 7, 9)])),
    derive: derivation({ few: moved(2, 0, 9), many: moved(7, 0, 9) }),
  });

  assert.deepEqual(result.moved.map((row) => row.changeId), ['many', 'few']);
});

test('history is looked up once per decomposed change, by root path and id', () => {
  const asked: string[] = [];
  report({
    model: model(root('alpha', [decomposed('one', 1, 2), undecomposed('two')])),
    historyFor: (rootPath, changeId) => {
      asked.push(`${rootPath}::${changeId}`);
      return undefined;
    },
    derive: derivation({}),
  });

  assert.deepEqual(asked, ['/work/alpha::one']);
});

test('the rendered markdown carries both section headings and one row per change', () => {
  const result = report({
    model: model(
      root('alpha', [
        decomposed('moved-one', 6, 10),
        decomposed('moved-two', 4, 10),
        decomposed('still-one', 1, 10),
        undecomposed('never-decomposed'),
      ]),
    ),
    derive: derivation(
      { 'moved-one': moved(6, 0, 10), 'moved-two': moved(4, 0, 10) },
      { 'still-one': { days: 40, fromCreation: true } },
    ),
  });
  const markdown = renderMovementReport(result);

  assert.match(markdown, /^## Moved \(2\)$/m);
  assert.match(markdown, /^## Did not move \(1\)$/m);
  assert.match(markdown, /^## Not decomposed \(1\)$/m);

  const rows = dataRows(markdown);
  assert.equal(rows.length, 3);
  for (const id of ['moved-one', 'moved-two', 'still-one']) {
    assert.equal(rows.filter((row) => row.includes(id)).length, 1);
  }
  // The undecomposed change is named, but never as a row with a percentage.
  assert.ok(!rows.some((row) => row.includes('never-decomposed')));
  assert.match(markdown, /^- never-decomposed \(alpha\)$/m);
  // The stall measured from creation carries its marker and its explanation.
  assert.match(markdown, /40 days \*/);
  assert.match(markdown, /^An asterisk after a stall figure/m);
});

test('the header names the period and the roots covered, and new changes are marked', () => {
  const result = report({
    model: model(
      root('alpha', [decomposed('fresh', 2, 5)]),
      root('beta', [decomposed('older', 5, 5)], '/work/beta'),
    ),
    derive: derivation({
      fresh: { completedSince: 2, newInPeriod: true, lastAdvanced: TODAY },
      older: { completedSince: 0, newInPeriod: false },
    }),
  });
  const markdown = renderMovementReport(result);

  assert.match(markdown, /^# Movement report$/m);
  assert.match(markdown, /^Period 2026-08-28 to 2026-09-04 \(7 days\)\. Roots: alpha, beta\.$/m);
  assert.match(markdown, /fresh \(new\)/);
  // No snapshot reaches back for `older`, so its start is unknown and said to be.
  assert.match(
    markdown,
    /^A dash under Start means the recorded history does not reach back to 2026-08-28\.$/m,
  );
});

test('the columns are padded to a common width so the table reads as plain text', () => {
  const result = report({
    model: model(
      root('alpha', [decomposed('a-short-id', 1, 2), decomposed('an-appreciably-longer-id', 2, 2)]),
    ),
    derive: derivation({
      'a-short-id': moved(1, 0, 2),
      'an-appreciably-longer-id': moved(2, 0, 2),
    }),
  });
  const rows = dataRows(renderMovementReport(result));

  assert.equal(rows.length, 2);
  const widths = new Set(rows.map((row) => row.length));
  assert.equal(widths.size, 1, `rows are not the same width: ${rows.join('\n')}`);
});

test('an empty model still renders both sections and says nothing moved', () => {
  const markdown = renderMovementReport(report({ model: model(), derive: derivation({}) }));

  assert.match(markdown, /^## Moved \(0\)$/m);
  assert.match(markdown, /No change advanced in this period\./);
  assert.match(markdown, /^## Did not move \(0\)$/m);
  assert.match(markdown, /No roots covered\./);
  assert.equal(dataRows(markdown).length, 0);
});

test('with no derivation injected it reads the recorded history itself', () => {
  const history: ChangeHistory = {
    changeId: 'route-reads-through-data-service',
    snapshots: [
      { date: '2026-08-28', completed: 55, total: 63, source: 'backfilled' },
      { date: '2026-09-02', completed: 61, total: 63, source: 'observed' },
    ],
    completions: {},
  };
  const result = report({
    model: model(root('alpha', [decomposed('route-reads-through-data-service', 61, 63)])),
    historyFor: () => history,
  });

  const row = result.moved[0];
  assert.ok(row);
  assert.equal(row.startCompleted, 55);
  assert.equal(row.completedInPeriod, 6);
  assert.deepEqual(row.stall, { days: 2, fromCreation: false });
});

/** Table body lines: every pipe line that is neither a header nor a column rule. */
function dataRows(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .filter((line) => !line.includes('| Change ') && !/^[|\s-]+$/.test(line));
}
