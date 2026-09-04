/**
 * What Claude Code did to one change, as far as the transcripts on this machine
 * record it: the bound sessions, their rollup, and the checked-without-code
 * signal.
 *
 * design.md D9: this signal is stronger than the git one because it does not
 * guess. It compares two facts already on disk - the day a task was first seen
 * complete, and what the sessions active that day actually wrote - and it is
 * still a signal to review, never a verdict. A session whose edits stayed
 * inside `openspec/` may well have been reviewing finished work.
 */

import type {
  Change,
  ChangeClaudeEvidence,
  ChangeHistory,
  CheckedWithoutCode,
  ClaudeEvidenceUnavailable,
  ClaudeRollup,
  SessionSummary,
  Task,
  TokenTotals,
} from '../model/types.ts';
import { isPathInside, pathKey, taskKey, toDateKey } from '../model/keys.ts';
import type { TranscriptIndex } from './transcripts.ts';

export interface ClaudeEvidenceInput {
  enabled: boolean;
  change: Change;
  history: ChangeHistory | undefined;
  index: TranscriptIndex;
  signal?: AbortSignal;
}

const REASON_TEXT: Record<ClaudeEvidenceUnavailable, string> = {
  disabled:
    'Claude Code evidence is off. Enable openspecLedger.claudeEvidence.enabled to read the transcripts on this machine.',
  'no-data-directory': 'No Claude Code history was found on this machine.',
  'no-sessions': 'No Claude Code transcript on this machine refers to this change.',
  'no-history':
    'No progress history covers this change yet, so completion dates could not be compared with session activity.',
};

/**
 * Evaluate one change against the transcript index.
 *
 * `available` says whether there is anything to show; `reason` says what is
 * missing. They are independent: a change can have sessions worth displaying
 * and still lack the history the checked-without-code signal needs.
 */
export async function evaluateClaudeEvidence(
  input: ClaudeEvidenceInput,
): Promise<ChangeClaudeEvidence> {
  const changeId = input.change.id;

  if (!input.enabled) {
    // The setting is off, so nothing is scanned and no transcript is opened.
    return unavailable(changeId, 'disabled');
  }

  const scan = await input.index.scan({ signal: input.signal });
  if (scan.unavailable === 'no-data-directory') {
    return unavailable(changeId, 'no-data-directory');
  }

  const bound = input.index.forChange(changeId);
  if (bound.length === 0) {
    // Absence of measurement. A rollup here would read as a measured zero.
    return unavailable(changeId, 'no-sessions');
  }

  // An agent writes far more than the repository it is working in: scratch
  // scripts under the temp directory, notes in its own data directory, files in
  // a sibling project it consulted. None of those is evidence that this change
  // was implemented, and counting them would let a session that only wrote a
  // throwaway script suppress the checked-without-code signal. Scope the edits
  // to the repository that owns the change.
  const sessions = bound.map((session) => scopeToRoot(session, input.change.rootPath));

  const evidence: ChangeClaudeEvidence = {
    changeId,
    available: true,
    sessions,
    rollup: rollUp(sessions),
    checkedWithoutCode: [],
  };

  if (!input.history || Object.keys(input.history.completions).length === 0) {
    evidence.reason = 'no-history';
    evidence.reasonText = REASON_TEXT['no-history'];
    return evidence;
  }

  evidence.checkedWithoutCode = findCheckedWithoutCode(
    input.change,
    input.history,
    sessions,
  );
  return evidence;
}

function unavailable(
  changeId: string,
  reason: ClaudeEvidenceUnavailable,
): ChangeClaudeEvidence {
  return {
    changeId,
    available: false,
    reason,
    reasonText: REASON_TEXT[reason],
    sessions: [],
    checkedWithoutCode: [],
  };
}

/**
 * Keep only the edits that landed inside the change's own repository.
 *
 * Tokens and cost are left alone: they were spent on this change whatever the
 * agent happened to touch. It is the file list that has to mean "work on this
 * code", because that is what the checked-without-code signal reads.
 */
function scopeToRoot(session: SessionSummary, rootPath: string): SessionSummary {
  const inside = session.editedFiles.filter((file) => isPathInside(file, rootPath));
  return inside.length === session.editedFiles.length
    ? session
    : { ...session, editedFiles: inside };
}

/**
 * The union across bound sessions. Built only when there is at least one, so
 * the caller can tell "nothing was measured" from "measured, and it was zero".
 */
function rollUp(sessions: readonly SessionSummary[]): ClaudeRollup {
  const tokens: TokenTotals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const editedFiles: string[] = [];
  const editedKeys = new Set<string>();
  const unpricedModels: string[] = [];
  let costUsd = 0;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;

  for (const session of sessions) {
    tokens.input += session.tokens.input;
    tokens.output += session.tokens.output;
    tokens.cacheWrite += session.tokens.cacheWrite;
    tokens.cacheRead += session.tokens.cacheRead;
    costUsd += session.costUsd;
    from = Math.min(from, session.firstActivity.getTime());
    to = Math.max(to, session.lastActivity.getTime());
    for (const file of session.editedFiles) {
      const key = pathKey(file);
      if (!editedKeys.has(key)) {
        editedKeys.add(key);
        editedFiles.push(file);
      }
    }
    for (const model of session.unpricedModels) {
      if (!unpricedModels.includes(model)) {
        unpricedModels.push(model);
      }
    }
  }

  editedFiles.sort((a, b) => a.localeCompare(b));

  return {
    sessions: sessions.length,
    from: new Date(from),
    to: new Date(to),
    tokens,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    editedFiles,
    unpricedModels,
  };
}

/**
 * A completed task whose completion day sits inside a bound session's span,
 * where no session active that day wrote anything outside `openspec/`.
 *
 * Only leaf tasks are examined: a parent is an aggregate of its children, and
 * reporting both would say the same thing twice. A task whose completion date
 * history does not know is passed over rather than reported on a guess.
 */
function findCheckedWithoutCode(
  change: Change,
  history: ChangeHistory,
  sessions: readonly SessionSummary[],
): CheckedWithoutCode[] {
  const leaves = change.taskFile?.leaves ?? [];
  if (leaves.length === 0) {
    return [];
  }

  const spans = sessions.map((session) => ({
    session,
    from: toDateKey(session.firstActivity),
    to: toDateKey(session.lastActivity),
  }));

  const signals: CheckedWithoutCode[] = [];
  for (const task of leaves) {
    if (task.state !== 'complete') {
      continue;
    }
    const key = taskKey(task.raw);
    const date = history.completions[key];
    if (!date) {
      continue;
    }
    // `YYYY-MM-DD` keys compare correctly as strings, which keeps the day
    // boundary in the user's own time zone.
    const active = spans.filter((span) => date >= span.from && date <= span.to);
    if (active.length === 0) {
      continue;
    }
    if (active.some((span) => span.session.editedFiles.length > 0)) {
      continue;
    }
    signals.push(describe(task, key, date, active.map((span) => span.session.sessionId)));
  }

  signals.sort((a, b) => (a.date === b.date ? a.line - b.line : a.date.localeCompare(b.date)));
  return signals;
}

function describe(
  task: Task,
  key: string,
  date: string,
  sessionIds: string[],
): CheckedWithoutCode {
  return {
    taskKey: key,
    label: task.number ? `${task.number} ${task.label}` : task.label,
    line: task.line,
    date,
    sessionIds,
  };
}
