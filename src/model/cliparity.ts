/**
 * What `openspec list` would say about the same task file.
 *
 * The CLI and this extension count differently, and both are defensible, so the
 * honest thing is to show the reader both figures where they disagree rather
 * than to publish one number and bury the difference in documentation. A user
 * who sees `8/12` here and `8/11` in their terminal and is left to work out why
 * stops trusting whichever they checked second.
 *
 * The rule below was not read off documentation - it was measured against
 * `openspec` 1.2.0 with `openspec list --json` on 2026-09-04:
 *
 *   - [x] / - [ ] / - [X]   counted
 *   - [-] / - [~]           IGNORED, in the numerator and the denominator alike
 *   nested children         IGNORED; only top-level task lines are counted
 *
 * Probe: five flat lines of which two were in progress reported 2 of 3. Two
 * parents with three children between them reported 1 of 2. Four real changes
 * in the reference environment matched the rule exactly.
 *
 * The extension counts LEAF tasks instead, and counts in-progress work towards
 * the total, because a parent is an aggregate of its children (design.md D4) and
 * a task somebody has started is not a task nobody has touched. Neither figure
 * is wrong; they answer different questions.
 */

import { makeProgress } from './keys.ts';
import type { ParsedTaskFile, Progress, TaskSection } from './types.ts';

/** Top-level tasks of every section, in file order. */
function topLevelTasks(sections: readonly TaskSection[]): Array<{ complete: boolean; counted: boolean }> {
  const out: Array<{ complete: boolean; counted: boolean }> = [];
  for (const section of sections) {
    for (const task of section.tasks) {
      out.push({
        complete: task.state === 'complete',
        counted: task.state !== 'in-progress',
      });
    }
  }
  return out;
}

/** The figure `openspec list` prints for this file. */
export function openspecListProgress(file: ParsedTaskFile): Progress {
  const counted = topLevelTasks(file.sections).filter((task) => task.counted);
  return makeProgress(counted.filter((task) => task.complete).length, counted.length);
}

export interface CountingDifference {
  ours: Progress;
  cli: Progress;
  /** One sentence naming the reason, for a tooltip or a panel line. */
  reason: string;
}

/**
 * Undefined when the two agree, which is the common case: a flat task list with
 * no in-progress markers counts identically either way, and saying so anyway
 * would be noise on every change in the tree.
 */
export function countingDifference(file: ParsedTaskFile | undefined): CountingDifference | undefined {
  if (!file) {
    return undefined;
  }
  const ours = file.progress;
  const cli = openspecListProgress(file);
  if (ours.completed === cli.completed && ours.total === cli.total) {
    return undefined;
  }

  const nested = file.all.length > file.leaves.length;
  const inProgress = file.all.filter((task) => task.state === 'in-progress').length;

  const reasons: string[] = [];
  if (nested) {
    reasons.push('it counts only top-level tasks, while this counts the nested ones that carry the work');
  }
  if (inProgress > 0) {
    reasons.push(
      `it drops ${inProgress} in-progress task${inProgress === 1 ? '' : 's'}, while this counts started work towards the total`,
    );
  }
  if (reasons.length === 0) {
    reasons.push('it applies a different counting rule');
  }

  return {
    ours,
    cli,
    reason: `\`openspec list\` reports ${cli.completed}/${cli.total} because ${reasons.join(', and ')}.`,
  };
}
