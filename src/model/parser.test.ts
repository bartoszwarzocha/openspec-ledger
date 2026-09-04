import { test } from 'node:test';
import assert from 'node:assert/strict';

import { markerFor, parseTasks, stateFromMarker, toggleMarker } from './parser.ts';
import type { Task, TaskSection } from './types.ts';

/** Fixtures are written as line arrays so the asserted line numbers are readable. */
function file(...lines: string[]): string {
  return lines.join('\n');
}

function onlySection(content: string): TaskSection {
  const parsed = parseTasks(content);
  assert.equal(parsed.sections.length, 1, 'expected exactly one section');
  const section = parsed.sections[0];
  assert.ok(section);
  return section;
}

function labels(tasks: readonly Task[]): string[] {
  return tasks.map((task) => task.label);
}

test('a flat numbered list under a heading becomes one section of four tasks', () => {
  const content = file(
    '# Implementation Tasks',
    '',
    '## 1. Provider Module',
    '',
    '- [x] 1.1 Add the LookupProvider trait',
    '- [x] 1.2 Implement the SQLite backend',
    '- [x] 1.3 Register the provider with the registry',
    '- [x] 1.4 Cover the provider with tests',
  );

  const parsed = parseTasks(content);

  // `# Implementation Tasks` groups nothing, so it contributes no section.
  assert.equal(parsed.sections.length, 1);
  const section = parsed.sections[0];
  assert.ok(section);
  assert.equal(section.title, '1. Provider Module');
  assert.equal(section.depth, 2);
  assert.equal(section.line, 3);

  assert.equal(section.tasks.length, 4);
  assert.deepEqual(
    section.tasks.map((task) => task.number),
    ['1.1', '1.2', '1.3', '1.4'],
  );
  assert.deepEqual(labels(section.tasks), [
    'Add the LookupProvider trait',
    'Implement the SQLite backend',
    'Register the provider with the registry',
    'Cover the provider with tests',
  ]);
  assert.ok(section.tasks.every((task) => task.state === 'complete'));
  assert.deepEqual(parsed.progress, { completed: 4, total: 4, percent: 100 });
});

test('a deeper indent makes a task a child of the one above it', () => {
  const section = onlySection(
    file(
      '## 1. Nesting',
      '- [ ] 1.1 Parent task',
      '  - [x] 1.1.1 First child',
      '  - [ ] 1.1.2 Second child',
      '- [ ] 1.2 Sibling of the parent',
    ),
  );

  assert.equal(section.tasks.length, 2);
  const parent = section.tasks[0];
  const sibling = section.tasks[1];
  assert.ok(parent && sibling);
  assert.equal(parent.children.length, 2);
  assert.deepEqual(labels(parent.children), ['First child', 'Second child']);
  assert.equal(sibling.children.length, 0);
  assert.equal(parent.indent, 0);
  assert.equal(parent.children[0]?.indent, 2);
});

test('a dedent attaches to the nearest shallower ancestor, not to the file root', () => {
  const section = onlySection(
    file(
      '## 1. Deep',
      '- [ ] Alpha',
      '    - [ ] Beta',
      '        - [ ] Gamma',
      '    - [ ] Delta',
      '- [ ] Epsilon',
    ),
  );

  assert.deepEqual(labels(section.tasks), ['Alpha', 'Epsilon']);
  const alpha = section.tasks[0];
  assert.ok(alpha);
  assert.deepEqual(labels(alpha.children), ['Beta', 'Delta']);
  assert.deepEqual(labels(alpha.children[0]?.children ?? []), ['Gamma']);
});

test('all four markers are recognised, in both spellings and with either bullet', () => {
  const section = onlySection(
    file(
      '## 1. Markers',
      '- [ ] Pending',
      '- [x] Complete lower case',
      '- [X] Complete upper case',
      '- [-] In progress with a dash',
      '* [~] In progress with a tilde',
    ),
  );

  assert.deepEqual(
    section.tasks.map((task) => task.state),
    ['pending', 'complete', 'complete', 'in-progress', 'in-progress'],
  );
});

test('a line reading `- [-] 3.2 Wire the registry` is in progress, not pending', () => {
  const section = onlySection(file('## 3. Registry', '- [-] 3.2 Wire the registry'));
  const task = section.tasks[0];
  assert.ok(task);
  assert.equal(task.state, 'in-progress');
  assert.equal(task.number, '3.2');
  assert.equal(task.label, 'Wire the registry');
});

test('prose, tables and fenced code between tasks are ignored without failing', () => {
  const content = file(
    '## 1. Setup',
    '',
    'This paragraph explains the section and mentions - [ ] inline, which is prose.',
    '',
    '| Task | Owner |',
    '| --- | --- |',
    '| 1.1 | nobody |',
    '',
    '- [x] 1.1 A task that is really there',
    '',
    'An example of the format we accept:',
    '',
    '```md',
    '- [ ] 9.9 A task inside a code fence',
    '## A heading inside a code fence',
    '```',
    '',
    '~~~',
    '- [x] 8.8 Another fenced imposter',
    '~~~',
    '',
    '- [ ] 1.2 The second real task',
  );

  const parsed = parseTasks(content);

  assert.equal(parsed.sections.length, 1);
  assert.deepEqual(labels(parsed.all), ['A task that is really there', 'The second real task']);
  assert.deepEqual(parsed.progress, { completed: 1, total: 2, percent: 50 });
  // Fences that close are ordinary markdown and are worth nothing to report.
  assert.equal(parsed.problems, undefined);
});

test('a fence that is never closed keeps the tasks below it and is reported', () => {
  const content = file(
    '## 1. Setup',
    '',
    '- [x] 1.1 The task that is done',
    '',
    'An example of the format we accept:',
    '```md',
    '',
    '- [ ] 1.2 The task that is not done',
    '- [ ] 1.3 The other task that is not done',
  );

  const parsed = parseTasks(content);

  assert.deepEqual(labels(parsed.all), [
    'The task that is done',
    'The task that is not done',
    'The other task that is not done',
  ]);
  assert.deepEqual(parsed.progress, { completed: 1, total: 3, percent: 33 });
  assert.equal(parsed.problems?.length, 1);
  assert.match(parsed.problems?.[0] ?? '', /line 6/);
});

test('a second fence left open is demoted in its turn, so no task is lost', () => {
  const parsed = parseTasks(
    file('```', '- [x] 1.1 The task that is done', '~~~', '- [ ] 1.2 The task that is not done'),
  );

  assert.deepEqual(labels(parsed.all), ['The task that is done', 'The task that is not done']);
  assert.deepEqual(parsed.progress, { completed: 1, total: 2, percent: 50 });
  assert.equal(parsed.problems?.length, 2);
  assert.match(parsed.problems?.[0] ?? '', /line 1/);
  assert.match(parsed.problems?.[1] ?? '', /line 3/);
});

test('a closing fence may be longer than the opening one, and must stand alone', () => {
  const parsed = parseTasks(
    file(
      '````',
      '- [ ] Hidden',
      '```',
      '- [ ] Still hidden: three backticks cannot close four',
      '````',
      '- [x] Visible again',
    ),
  );
  assert.deepEqual(labels(parsed.all), ['Visible again']);
});

test('tasks before the first heading land in an implicit section that sorts first', () => {
  const parsed = parseTasks(
    file(
      '- [x] Read the proposal',
      '- [ ] Decide on the approach',
      '',
      '## 1. Provider Module',
      '- [ ] 1.1 Write the provider',
    ),
  );

  assert.equal(parsed.sections.length, 2);
  const implicit = parsed.sections[0];
  assert.ok(implicit);
  assert.equal(implicit.title, undefined);
  assert.equal(implicit.depth, 0);
  assert.equal(implicit.line, 0);
  assert.deepEqual(labels(implicit.tasks), ['Read the proposal', 'Decide on the approach']);
  assert.equal(parsed.sections[1]?.title, '1. Provider Module');
});

test('a task records its one-based line and the verbatim text of that line', () => {
  const filler = Array.from({ length: 46 }, (_, index) => `Prose line ${index + 1}.`);
  const raw = '  - [x] 5.1 The task that sits on line 47';
  const parsed = parseTasks(file(...filler, raw));

  const task = parsed.all[0];
  assert.ok(task);
  assert.equal(task.line, 47);
  assert.equal(task.raw, raw);
});

test('a carriage return is not kept in the recorded line', () => {
  const parsed = parseTasks('## 1. Windows\r\n- [x] 1.1 Written on Windows\r\n');
  const task = parsed.all[0];
  assert.ok(task);
  assert.equal(task.raw, '- [x] 1.1 Written on Windows');
  assert.equal(task.label, 'Written on Windows');
});

test('a task whose label is only prose keeps its whole text and has no number', () => {
  const section = onlySection(file('## 2. Prose', '- [ ] Wire the registry and move on'));
  const task = section.tasks[0];
  assert.ok(task);
  assert.equal(task.number, undefined);
  assert.equal(task.label, 'Wire the registry and move on');
});

test('only N.M and N.M.K prefixes are stripped', () => {
  const section = onlySection(
    file(
      '## 1. Numbers',
      '- [ ] 1.2 Two parts',
      '- [ ] 1.2.3 Three parts',
      '- [ ] 1.2.3.4 Four parts stay in the label',
      '- [ ] 12 Not a dotted number',
      '- [ ] 1.2',
    ),
  );

  assert.deepEqual(
    section.tasks.map((task) => task.number),
    ['1.2', '1.2.3', undefined, undefined, undefined],
  );
  assert.deepEqual(labels(section.tasks), [
    'Two parts',
    'Three parts',
    '1.2.3.4 Four parts stay in the label',
    '12 Not a dotted number',
    '1.2',
  ]);
});

test('a tab counts as the configured tab width when nesting is worked out', () => {
  const content = file('- [ ] Parent', '  - [ ] Two spaces', '\t- [ ] One tab');

  const wide = parseTasks(content, { tabWidth: 4 }).sections[0]?.tasks[0];
  assert.ok(wide);
  assert.deepEqual(labels(wide.children), ['Two spaces']);
  assert.deepEqual(labels(wide.children[0]?.children ?? []), ['One tab']);

  const narrow = parseTasks(content, { tabWidth: 2 }).sections[0]?.tasks[0];
  assert.ok(narrow);
  assert.deepEqual(labels(narrow.children), ['Two spaces', 'One tab']);
});

test('an empty file parses to no sections and no progress', () => {
  const parsed = parseTasks('');
  assert.deepEqual(parsed.sections, []);
  assert.deepEqual(parsed.all, []);
  assert.deepEqual(parsed.progress, { completed: 0, total: 0, percent: 0 });
});

// ---------------------------------------------------------------------------
// Progress arithmetic
// ---------------------------------------------------------------------------

test('a file whose leaf tasks are all complete reads 100 percent', () => {
  const lines = ['## 1. Everything'];
  for (let i = 1; i <= 32; i++) {
    lines.push(`- [x] 1.${i} Finished task ${i}`);
  }
  assert.deepEqual(parseTasks(file(...lines)).progress, {
    completed: 32,
    total: 32,
    percent: 100,
  });
});

test('109 of 110 leaf tasks reads 99 percent, not 100', () => {
  const lines = ['## 1. Nearly'];
  for (let i = 1; i <= 110; i++) {
    lines.push(`- [${i === 110 ? ' ' : 'x'}] 1.${i} Task ${i}`);
  }
  assert.deepEqual(parseTasks(file(...lines)).progress, {
    completed: 109,
    total: 110,
    percent: 99,
  });
});

test('a complete parent with three complete children totals three, not four', () => {
  const parsed = parseTasks(
    file(
      '## 1. Parents',
      '- [x] 1.1 The parent',
      '  - [x] 1.1.1 First',
      '  - [x] 1.1.2 Second',
      '  - [x] 1.1.3 Third',
    ),
  );

  assert.equal(parsed.all.length, 4);
  assert.equal(parsed.leaves.length, 3);
  assert.deepEqual(parsed.progress, { completed: 3, total: 3, percent: 100 });
});

test('an in-progress task counts towards the total but not the completed count', () => {
  const parsed = parseTasks(
    file('## 1. Mixed', '- [x] 1.1 Done', '- [-] 1.2 Under way', '- [ ] 1.3 Not started'),
  );
  assert.deepEqual(parsed.progress, { completed: 1, total: 3, percent: 33 });
});

test('`all` lists parents and children in file order, `leaves` only the countable ones', () => {
  const parsed = parseTasks(
    file('## 1. Order', '- [ ] A', '  - [ ] A1', '  - [ ] A2', '- [ ] B'),
  );
  assert.deepEqual(labels(parsed.all), ['A', 'A1', 'A2', 'B']);
  assert.deepEqual(labels(parsed.leaves), ['A1', 'A2', 'B']);
});

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

test('markerFor and stateFromMarker round-trip every state', () => {
  for (const state of ['pending', 'complete', 'in-progress'] as const) {
    assert.equal(stateFromMarker(markerFor(state)), state);
  }
  assert.equal(markerFor('pending'), ' ');
  assert.equal(markerFor('complete'), 'x');
  assert.equal(markerFor('in-progress'), '-');
  assert.equal(stateFromMarker('X'), 'complete');
  assert.equal(stateFromMarker('~'), 'in-progress');
  assert.equal(stateFromMarker('?'), 'pending');
});

test('toggleMarker rewrites the marker and leaves the rest of the line alone', () => {
  assert.equal(toggleMarker('  - [ ] 1.1 Do it', 'complete'), '  - [x] 1.1 Do it');
  assert.equal(toggleMarker('* [X] Done already', 'pending'), '* [ ] Done already');
  assert.equal(toggleMarker('\t- [~] Under way', 'in-progress'), '\t- [-] Under way');
  assert.equal(toggleMarker('- [x]   Padded   text  ', 'pending'), '- [ ]   Padded   text  ');
});

test('toggleMarker returns undefined for a line that is not a task', () => {
  assert.equal(toggleMarker('## 1. Provider Module', 'complete'), undefined);
  assert.equal(toggleMarker('- not a checkbox', 'complete'), undefined);
  assert.equal(toggleMarker('', 'complete'), undefined);
});

test('a toggled line still parses as the state it was toggled to', () => {
  const raw = '  - [ ] 2.4 Extract the references';
  const toggled = toggleMarker(raw, 'complete');
  assert.ok(toggled);
  const task = parseTasks(toggled).all[0];
  assert.equal(task?.state, 'complete');
  assert.equal(task?.number, '2.4');
});

// ---------------------------------------------------------------------------
// Budget (design.md D13): one 145-task file under 10 ms
// ---------------------------------------------------------------------------

function generateTaskFile(count: number): string {
  const lines: string[] = ['# Implementation Tasks', ''];
  let made = 0;
  let section = 1;
  while (made < count) {
    lines.push(`## ${section}. Section ${section} of the generated plan`, '');
    for (let index = 1; index <= 10 && made < count; index++) {
      made++;
      const marker = made % 3 === 0 ? 'x' : made % 3 === 1 ? ' ' : '-';
      lines.push(
        `- [${marker}] ${section}.${index} Implement \`module/${section}/${index}.rs\` and call setUp()`,
      );
      if (index % 4 === 0 && made < count) {
        made++;
        lines.push(`  - [x] ${section}.${index}.1 A nested sub-task carrying a few more words`);
      }
    }
    lines.push('', 'Prose between sections, which the parser has to step over.', '');
    section++;
  }
  return lines.join('\n');
}

test('a 145-task file parses in under 10 ms', () => {
  const content = generateTaskFile(145);
  assert.equal(parseTasks(content).all.length, 145);

  for (let i = 0; i < 5; i++) {
    parseTasks(content);
  }

  const runs = 20;
  const durations: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    parseTasks(content);
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  const median = durations[Math.floor(runs / 2)] ?? Number.POSITIVE_INFINITY;
  assert.ok(median < 10, `median parse took ${median.toFixed(3)} ms`);
});
