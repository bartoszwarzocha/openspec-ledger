/**
 * Handoff prompt construction.
 *
 * Pure string work - no `vscode`, no I/O - so every scenario in
 * `specs/agent-handoff` is testable without an extension host. The delivery
 * side lives in `terminal.ts`.
 *
 * ## Placeholders
 *
 * A template may use `{change}`, `{number}`, `{task}`, `{tasksPath}`, `{line}`,
 * `{proposal}` and `{root}`; the section template additionally uses `{section}`
 * and `{tasks}`. Anything else in braces is left exactly as written, because a
 * prompt may legitimately contain braces the user meant the agent to read.
 *
 * A placeholder with no value substitutes to the empty string. Two kinds of
 * damage follow from that, and they need different repairs:
 *
 * - An unnumbered task leaves a hole mid-sentence. The sentence still reads
 *   once the surrounding whitespace and punctuation are tidied, so the hole is
 *   simply closed up.
 * - A change with no `proposal.md` would leave "Read for the intent behind the
 *   change" - a clause pointing at nothing. Sentences are therefore dropped
 *   whole for the placeholders in `CLAUSAL`: a sentence whose only job is to
 *   name something absent is worse than no sentence.
 */

import type { SectionPromptInput, TaskPromptInput } from '../model/types.ts';

/**
 * The built-in task prompt.
 *
 * `Task {number}: {task}` is deliberate: with no number the tidy pass drops the
 * space before the colon, leaving `Task: <label>`, which still reads.
 */
export const DEFAULT_TASK_TEMPLATE =
  'Work on the OpenSpec change {change}. ' +
  'Task {number}: {task}. ' +
  'It is on line {line} of {tasksPath}. ' +
  'Read {proposal} for the intent behind the change. ' +
  'Implement only this task; when it is complete, tick its checkbox on line {line} ' +
  'of {tasksPath} and change nothing else in that file.';

export const DEFAULT_SECTION_TEMPLATE =
  'Work on the OpenSpec change {change}. ' +
  'The section is {section}. ' +
  'The tasks still open, in file order: {tasks}. ' +
  'They are in {tasksPath}. ' +
  'Read {proposal} for the intent behind the change. ' +
  'Work through them in order; tick each checkbox as its task is completed ' +
  'and change nothing else in that file.';

/** Placeholders whose sentence is meaningless without them, so it is dropped whole. */
const CLAUSAL = new Set(['proposal', 'root', 'section', 'tasks']);

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** Marks a sentence for removal. Cannot occur in a task label or in a path. */
const PRUNE = '\u0000';

export function buildTaskPrompt(input: TaskPromptInput): string {
  const template =
    input.template && input.template.trim().length > 0 ? input.template : DEFAULT_TASK_TEMPLATE;

  return render(template, {
    change: input.changeId,
    number: input.number,
    task: input.label,
    tasksPath: input.tasksPath,
    line: String(input.line),
    proposal: input.proposalPath,
    root: rootOf(input.tasksPath),
  });
}

export function buildSectionPrompt(input: SectionPromptInput): string {
  // `input.tasks` is already the incomplete set in file order (see
  // SectionPromptInput), so nothing complete can reach the prompt.
  const list = input.tasks
    .map((task) => `${task.number ? `${task.number} ` : ''}${task.label} (line ${task.line})`)
    .join('; ');

  return render(DEFAULT_SECTION_TEMPLATE, {
    change: input.changeId,
    section: input.sectionTitle,
    tasks: list,
    tasksPath: input.tasksPath,
    proposal: input.proposalPath,
    root: rootOf(input.tasksPath),
  });
}

function render(template: string, values: Readonly<Record<string, string | undefined>>): string {
  return tidy(dropMarkedSentences(fill(template, values)));
}

/**
 * One pass, so a value that itself contains braces is never re-scanned: a task
 * label is sent to the agent exactly as the author wrote it.
 */
function fill(template: string, values: Readonly<Record<string, string | undefined>>): string {
  return template.replace(PLACEHOLDER, (whole: string, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      return whole;
    }
    // Stripping the sentinel from the value keeps it unforgeable: no task label
    // can talk the renderer into dropping the sentence that carries it.
    const value = (values[key] ?? '').split(PRUNE).join('');
    if (value.length > 0) {
      return value;
    }
    return CLAUSAL.has(key) ? PRUNE : '';
  });
}

/** Split on sentence ends, keeping each terminator with the sentence it closes. */
function dropMarkedSentences(text: string): string {
  if (!text.includes(PRUNE)) {
    return text;
  }
  const kept = text
    .split(/(?<=[.!?])(?=\s)/)
    .filter((sentence) => !sentence.includes(PRUNE))
    .join('');

  // A template written as one sentence - or as a bare line of fields - has
  // nothing to drop but itself, so there the hole is closed in place instead.
  return kept.trim().length > 0 ? kept : text.split(PRUNE).join('');
}

/**
 * Close the holes an empty placeholder left, and flatten the result to one line.
 *
 * The single line is not cosmetic: `Terminal.sendText` writes the string as if
 * typed, so an embedded newline would submit the prompt before the user has
 * read it - or run its first line as a shell command (design.md D12).
 */
function tidy(text: string): string {
  return text
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+([,.;:!?)\]])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The workspace-relative directory owning the change, derived from the tasks
 * path because the frozen prompt inputs carry no root of their own. Empty when
 * the root is the workspace folder itself, which drops any `{root}` sentence.
 */
function rootOf(tasksPath: string): string {
  const at = tasksPath.replace(/\\/g, '/').indexOf('/openspec/');
  return at > 0 ? tasksPath.slice(0, at) : '';
}
