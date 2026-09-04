import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Task, TaskState } from '../model/types.ts';
import { buildSectionPrompt, buildTaskPrompt } from './prompt.ts';

const TASKS_PATH = 'openspec/changes/add-lookup-provider/tasks.md';
const PROPOSAL_PATH = 'openspec/changes/add-lookup-provider/proposal.md';

/** Every prompt must survive being typed into a terminal as one line. */
function assertSingleParagraph(prompt: string): void {
  assert.equal(prompt.includes('\n'), false, 'a prompt must not contain a newline');
  assert.equal(prompt, prompt.trim(), 'a prompt must not be padded with whitespace');
  assert.equal(/\s\s/.test(prompt), false, 'a prompt must not contain a run of whitespace');
  assert.equal(/\{\w+\}/.test(prompt), false, 'no placeholder may survive substitution');
}

test('a numbered task names the change, number, label, path and line', () => {
  const prompt = buildTaskPrompt({
    changeId: 'add-lookup-provider',
    number: '4.3',
    label: 'Wire the provider into the lookup service',
    tasksPath: TASKS_PATH,
    line: 47,
    proposalPath: PROPOSAL_PATH,
  });

  assert.match(prompt, /add-lookup-provider/);
  assert.match(prompt, /4\.3/);
  assert.match(prompt, /Wire the provider into the lookup service/);
  assert.ok(prompt.includes(TASKS_PATH));
  assert.match(prompt, /line 47/);
  assertSingleParagraph(prompt);
});

test('the prompt asks for the checkbox to be ticked on completion', () => {
  const prompt = buildTaskPrompt({
    changeId: 'add-lookup-provider',
    number: '4.3',
    label: 'Wire the provider',
    tasksPath: TASKS_PATH,
    line: 47,
  });

  assert.match(prompt, /tick its checkbox/i);
});

test('an unnumbered task omits the number and stays complete', () => {
  const prompt = buildTaskPrompt({
    changeId: 'add-lookup-provider',
    label: 'Wire the provider into the lookup service',
    tasksPath: TASKS_PATH,
    line: 47,
    proposalPath: PROPOSAL_PATH,
  });

  assert.match(prompt, /add-lookup-provider/);
  assert.match(prompt, /Wire the provider into the lookup service/);
  assert.ok(prompt.includes(TASKS_PATH));
  assert.match(prompt, /line 47/);
  // The hole the missing number left is closed up, colon and all.
  assert.match(prompt, /Task: Wire the provider/);
  assert.equal(/ :/.test(prompt), false, 'no orphaned punctuation where the number was');
  assertSingleParagraph(prompt);
});

test('a change with no proposal leaves no dangling reference to one', () => {
  const prompt = buildTaskPrompt({
    changeId: 'add-lookup-provider',
    number: '4.3',
    label: 'Wire the provider',
    tasksPath: TASKS_PATH,
    line: 47,
  });

  assert.equal(/proposal/i.test(prompt), false, 'the proposal sentence is dropped whole');
  assert.equal(/\bRead\b/.test(prompt), false, 'nothing is left telling the agent to read nothing');
  assert.match(prompt, /add-lookup-provider/);
  assert.match(prompt, /Wire the provider/);
  assertSingleParagraph(prompt);
});

test('a custom template is used with its placeholders substituted', () => {
  const prompt = buildTaskPrompt({
    changeId: 'add-lookup-provider',
    number: '4.3',
    label: 'Wire the provider',
    tasksPath: TASKS_PATH,
    line: 47,
    proposalPath: PROPOSAL_PATH,
    template: '[{change}|{number}|{task}|{tasksPath}|{line}|{proposal}|{root}]',
  });

  assert.equal(
    prompt,
    `[add-lookup-provider|4.3|Wire the provider|${TASKS_PATH}|47|${PROPOSAL_PATH}|]`,
  );
});

test('a custom template with no value for a placeholder keeps its shape', () => {
  const prompt = buildTaskPrompt({
    changeId: 'add-lookup-provider',
    label: 'Wire the provider',
    tasksPath: 'services/lookup/openspec/changes/add-lookup-provider/tasks.md',
    line: 47,
    template: 'Do {number} {task} now. The proposal is {proposal}. The root is {root}.',
  });

  // The number vanishes in place; the sentence that only pointed at the missing
  // proposal goes with it; the root is derived from the tasks path.
  assert.equal(prompt, 'Do Wire the provider now. The root is services/lookup.');
  assertSingleParagraph(prompt);
});

test('an unknown placeholder is left as the author wrote it', () => {
  const prompt = buildTaskPrompt({
    changeId: 'add-lookup-provider',
    number: '4.3',
    label: 'Wire the provider',
    tasksPath: TASKS_PATH,
    line: 47,
    template: 'Run {change} with {shellVar} intact',
  });

  assert.equal(prompt, 'Run add-lookup-provider with {shellVar} intact');
});

test('a label is carried verbatim, braces and all', () => {
  const prompt = buildTaskPrompt({
    changeId: 'add-lookup-provider',
    number: '4.3',
    label: 'Handle {change} placeholders in the export',
    tasksPath: TASKS_PATH,
    line: 47,
    template: '{task}',
  });

  assert.equal(prompt, 'Handle {change} placeholders in the export');
});

test('a label cannot forge the marker that drops a sentence', () => {
  const prompt = buildTaskPrompt({
    changeId: 'add-lookup-provider',
    number: '4.3',
    label: `Wire${String.fromCharCode(0)} the provider`,
    tasksPath: TASKS_PATH,
    line: 47,
    template: 'Task {number}: {task}.',
  });

  assert.equal(prompt, 'Task 4.3: Wire the provider.');
});

test('a section prompt lists exactly the incomplete tasks, in file order', () => {
  const section: Task[] = [
    task('5.1', 'Write the parser', 10, 'complete'),
    task('5.2', 'Write the reader', 11, 'complete'),
    task('5.3', 'Write the writer', 12, 'pending'),
    task('5.4', 'Write the cache', 13, 'complete'),
    task('5.5', 'Write the tests', 14, 'in-progress'),
  ];

  // The caller filters (see SectionPromptInput); this mirrors what it does.
  const incomplete = section.filter((entry) => entry.state !== 'complete');

  const prompt = buildSectionPrompt({
    changeId: 'add-lookup-provider',
    sectionTitle: '5. Storage',
    tasksPath: TASKS_PATH,
    proposalPath: PROPOSAL_PATH,
    tasks: incomplete.map((entry) => ({
      number: entry.number,
      label: entry.label,
      line: entry.line,
    })),
  });

  assert.match(prompt, /5\. Storage/);
  assert.match(prompt, /5\.3 Write the writer \(line 12\)/);
  assert.match(prompt, /5\.5 Write the tests \(line 14\)/);
  for (const gone of ['Write the parser', 'Write the reader', 'Write the cache']) {
    assert.equal(prompt.includes(gone), false, `${gone} is complete and must not be listed`);
  }
  assertSingleParagraph(prompt);
});

test('a section with no heading drops the sentence that would have named it', () => {
  const prompt = buildSectionPrompt({
    changeId: 'add-lookup-provider',
    tasksPath: TASKS_PATH,
    tasks: [{ label: 'Write the writer', line: 12 }],
  });

  assert.equal(/The section is/.test(prompt), false);
  assert.match(prompt, /Write the writer \(line 12\)/);
  assert.equal(/proposal/i.test(prompt), false);
  assertSingleParagraph(prompt);
});

function task(number: string, label: string, line: number, state: TaskState): Task {
  return {
    number,
    label,
    state,
    line,
    raw: `- [${state === 'complete' ? 'x' : ' '}] ${number} ${label}`,
    indent: 0,
    children: [],
  };
}
