/**
 * The one webview in the extension (design.md D3): the change detail panel.
 *
 * Its content is tabular and graphical - a progress curve, a session ledger, an
 * evidence table - and has no natural tree representation. Everything else
 * stays native.
 *
 * Two rules govern what is rendered here. Nothing from a transcript beyond
 * derived totals, timestamps and file paths ever reaches the page: no prompt
 * and no response text, which the privacy requirement states as a guarantee.
 * And every derived judgement is phrased as something to look at, never as a
 * claim that a task was not done.
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

import { changeKey, toDateKey } from '../model/keys.ts';
import type {
  Change,
  ChangeClaudeEvidence,
  ChangeGitEvidence,
  EvidenceState,
  ProgressSnapshot,
  SessionSummary,
  Stall,
  TaskEvidence,
} from '../model/types.ts';
import { log } from '../util/log.ts';
import { historyCaption, sparkGeometry, sparkPoints } from './sparkline.ts';

export interface ChangeDetailContent {
  change: Change;
  rootLabel: string;
  snapshots: readonly ProgressSnapshot[];
  stall?: Stall;
  lastAdvanced?: string;
  gitEvidence?: ChangeGitEvidence;
  claudeEvidence?: ChangeClaudeEvidence;
  onDismiss?: (taskKey: string) => void;
}

const VIEW_TYPE = 'openspecLedger.changeDetail';

interface PanelEntry {
  panel: vscode.WebviewPanel;
  /** Replaced on every `show`, so the dismiss handler is never a stale one. */
  content: ChangeDetailContent;
  listeners: vscode.Disposable[];
}

const panels = new Map<string, PanelEntry>();
let cleanupRegisteredFor: vscode.ExtensionContext | undefined;

export class ChangeDetailPanel {
  /** One panel per change, so two changes can be read side by side. */
  static show(context: vscode.ExtensionContext, content: ChangeDetailContent): void {
    registerCleanup(context);

    const key = changeKey(content.change.rootPath, content.change.id);
    const existing = panels.get(key);
    if (existing) {
      existing.content = content;
      existing.panel.title = content.change.id;
      existing.panel.webview.html = renderHtml(content, createNonce());
      existing.panel.reveal(existing.panel.viewColumn, false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      content.change.id,
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        // The page is self-contained, so nothing may be loaded from disk.
        localResourceRoots: [],
      },
    );

    const entry: PanelEntry = { panel, content, listeners: [] };
    panels.set(key, entry);

    entry.listeners.push(
      panel.webview.onDidReceiveMessage((message: unknown) => {
        handleMessage(entry, message);
      }),
      panel.onDidDispose(() => {
        panels.delete(key);
        for (const listener of entry.listeners.splice(0, entry.listeners.length)) {
          listener.dispose();
        }
      }),
    );

    panel.webview.html = renderHtml(content, createNonce());
  }

  static dispose(): void {
    for (const entry of [...panels.values()]) {
      entry.panel.dispose();
    }
    panels.clear();
  }
}

/** Registered once per activation: a reload must not leave a panel behind. */
function registerCleanup(context: vscode.ExtensionContext): void {
  if (cleanupRegisteredFor === context) {
    return;
  }
  cleanupRegisteredFor = context;
  context.subscriptions.push(new vscode.Disposable(() => ChangeDetailPanel.dispose()));
}

function handleMessage(entry: PanelEntry, message: unknown): void {
  if (typeof message !== 'object' || message === null) {
    return;
  }
  const payload = message as { type?: unknown; taskKey?: unknown };
  if (payload.type !== 'dismiss' || typeof payload.taskKey !== 'string') {
    return;
  }
  log.info(`dismissed a no-trace signal in ${entry.content.change.id}`);
  entry.content.onDismiss?.(payload.taskKey);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function createNonce(): string {
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

/**
 * Escapes text for element content and for quoted attribute values alike.
 *
 * Everything interpolated into this page comes from the user's repositories -
 * task text, file paths, model ids - so nothing is interpolated raw.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

export function formatCount(value: number): string {
  return Number.isFinite(value) ? NUMBER_FORMAT.format(Math.round(value)) : '-';
}

/** Four decimals below a dollar: a session often costs cents, which two would hide. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

export function formatDateTime(date: Date | undefined): string {
  if (!date || Number.isNaN(date.getTime())) {
    return 'unknown';
  }
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${toDateKey(date)} ${hours}:${minutes}`;
}

export type EvidenceCounts = Record<EvidenceState, number>;

export function evidenceCounts(results: readonly TaskEvidence[]): EvidenceCounts {
  const counts: EvidenceCounts = {
    corroborated: 0,
    'no-references': 0,
    'no-trace': 0,
    'unknown-date': 0,
  };
  for (const result of results) {
    counts[result.state] += 1;
  }
  return counts;
}

/**
 * The two facts `unknown-date` covers, told apart.
 *
 * A task the history does not date and a task whose search did not finish need
 * different things from the user, so the panel must not report the second one
 * as missing history.
 */
export interface UnsearchedTasks {
  /** Completed tasks with no recorded date to search back from. */
  undated: number;
  /** Completed tasks whose search did not finish. */
  unfinished: number;
  /** Why those searches did not finish, distinct and in first-seen order. */
  reasons: string[];
}

export function unsearchedTasks(results: readonly TaskEvidence[]): UnsearchedTasks {
  const reasons: string[] = [];
  let undated = 0;
  let unfinished = 0;

  for (const result of results) {
    if (result.state !== 'unknown-date') {
      continue;
    }
    const reason = searchIncompleteReason(result);
    if (reason === undefined) {
      undated += 1;
      continue;
    }
    unfinished += 1;
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
  }

  return { undated, unfinished, reasons };
}

/** Blank is treated as absent: an empty sentence would render as a stray line. */
function searchIncompleteReason(result: TaskEvidence): string | undefined {
  const reason = result.searchIncomplete;
  return reason !== undefined && reason.trim().length > 0 ? reason : undefined;
}

/**
 * The window a result was searched over, as the commands beneath it read it.
 *
 * The search has no upper end - `--since` and nothing else - so a commit later
 * than the tick counts too. A closed range would describe a different search
 * from the one that was run.
 */
export function searchWindowText(result: TaskEvidence): string {
  if (result.windowFrom === undefined) {
    return result.completedOn === undefined ? 'unknown' : `ticked ${result.completedOn}`;
  }
  return result.completedOn === undefined
    ? `commits since ${result.windowFrom}`
    : `commits since ${result.windowFrom}, for a task ticked ${result.completedOn}`;
}

/** A layer's own sentence wins; this only covers a reason that arrived without one. */
export function unavailableSentence(
  reason: string | undefined,
  reasonText: string | undefined,
): string {
  if (reasonText && reasonText.trim().length > 0) {
    return reasonText;
  }
  switch (reason) {
    case 'disabled':
      return 'This layer is turned off in settings, so nothing was read.';
    case 'git-missing':
      return 'git was not found on PATH, so no commit history could be read.';
    case 'not-a-repository':
      return 'This root is not inside a git repository.';
    case 'planning-only':
      return 'This repository holds no tracked files outside openspec/, so the code it describes lives in another repository.';
    case 'no-history':
      return 'No progress history covers this change yet, so no completion date is known for its tasks.';
    case 'no-data-directory':
      return 'No Claude Code history was found on this machine.';
    case 'no-sessions':
      return 'No session on this machine referenced this change.';
    default:
      return 'This layer is unavailable.';
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ESTIMATE_NOTE =
  'Tokens and cost are computed on this machine from the transcript. They are estimates, not billed figures.';

const PRIVACY_NOTE =
  'Only totals, timestamps and file paths are read into this panel. No prompt or response text is shown.';

/**
 * Room on the left for the percentage scale and underneath for the dates: the
 * axis is the point of this chart, so it gets the space rather than the curve.
 */
const SPARK_BOX = {
  width: 720,
  height: 168,
  paddingLeft: 34,
  paddingRight: 14,
  paddingTop: 14,
  paddingBottom: 30,
};
/** Past this many snapshots the dots merge into the line, so they are dropped. */
const MAX_DOTS = 90;

export function renderHtml(content: ChangeDetailContent, nonce: string): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(content.change.id)}</title>
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>
${renderHeader(content)}
${renderHistory(content)}
${renderGitEvidence(content.gitEvidence)}
${renderClaudeEvidence(content.claudeEvidence)}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

function renderHeader(content: ChangeDetailContent): string {
  const { change } = content;
  const progress = change.taskFile?.progress;
  const progressText = change.undecomposed
    ? 'not decomposed'
    : progress
      ? `${progress.completed}/${progress.total} &middot; ${progress.percent}%`
      : 'no tasks read';

  const created = change.created
    ? `${escapeHtml(toDateKey(change.created))}${
        change.createdInferred ? ' <span class="muted">(inferred)</span>' : ''
      }`
    : '<span class="muted">unknown</span>';

  const stall = content.stall
    ? `${content.stall.days} day${content.stall.days === 1 ? '' : 's'}${
        content.stall.fromCreation ? ' <span class="muted">since it was created</span>' : ''
      }`
    : '<span class="muted">&ndash;</span>';

  const documents = (
    [
      ['proposal.md', change.documents.proposal],
      ['design.md', change.documents.design],
      ['tasks.md', change.documents.tasks],
      ['specs/', change.documents.specs],
    ] as const
  )
    .map(
      ([label, present]) =>
        `<span class="chip ${present ? 'present' : 'absent'}">${escapeHtml(label)}</span>`,
    )
    .join('');

  const problems =
    change.problems.length > 0
      ? `<div class="problems"><h3>Noted while reading this change</h3><ul>${change.problems
          .map((problem) => `<li>${escapeHtml(problem)}</li>`)
          .join('')}</ul></div>`
      : '';

  const lastAdvanced = content.lastAdvanced
    ? escapeHtml(content.lastAdvanced)
    : '<span class="muted">no recorded advance</span>';

  return `<header>
<h1>${escapeHtml(change.id)}</h1>
<p class="subtitle">${escapeHtml(content.rootLabel)} &middot; <span class="path">${escapeHtml(
    change.path,
  )}</span></p>
<div class="cards">
<div class="card"><span class="card-label">Progress</span><span class="card-value">${progressText}</span></div>
<div class="card"><span class="card-label">Created</span><span class="card-value">${created}</span></div>
<div class="card"><span class="card-label">Last advanced</span><span class="card-value">${lastAdvanced}</span></div>
<div class="card"><span class="card-label">Still</span><span class="card-value">${stall}</span></div>
</div>
<div class="chips">${documents}</div>
${problems}
</header>`;
}

function renderHistory(content: ChangeDetailContent): string {
  const points = sparkPoints(content.snapshots);
  const geometry = sparkGeometry(points, SPARK_BOX);

  if (!geometry) {
    return `<section>
<h2>Progress over time</h2>
<p class="empty">No snapshot has been recorded for this change yet. History is reconstructed from the commits that touched <code>tasks.md</code>, so a change outside a git repository starts collecting from the first day it is seen.</p>
</section>`;
  }

  const { first, last } = geometry;
  const baseline = SPARK_BOX.height - SPARK_BOX.paddingBottom;
  const rightEdge = SPARK_BOX.width - SPARK_BOX.paddingRight;

  // Horizontal guides at 0, 50 and 100 per cent, each labelled, so a reader can
  // put a value on the curve without hovering it.
  const guides = geometry.guides
    .map(
      (guide) =>
        `<line class="guide" x1="${SPARK_BOX.paddingLeft}" y1="${guide.y}" x2="${rightEdge}" y2="${guide.y}"></line>` +
        `<text class="scale" x="${SPARK_BOX.paddingLeft - 6}" y="${guide.y + 3}" text-anchor="end">${guide.percent}%</text>`
    )
    .join('');

  // The dated axis. Without it the chart shows dynamics and not the course,
  // which is the one thing this extension exists to make visible.
  const ticks = geometry.ticks
    .map(
      (tick) =>
        `<line class="tick" x1="${tick.x}" y1="${baseline}" x2="${tick.x}" y2="${baseline + 4}"></line>` +
        `<text class="tick-label" x="${tick.x}" y="${baseline + 16}" text-anchor="middle">${escapeHtml(
          tick.label
        )}</text>`
    )
    .join('');

  const dots =
    geometry.dots.length <= MAX_DOTS
      ? geometry.dots
          .map(
            (dot) =>
              `<circle class="dot ${dot.point.source}" cx="${dot.x}" cy="${dot.y}" r="3"><title>${escapeHtml(
                `${dot.point.date} - ${dot.point.completed}/${dot.point.total} (${dot.point.percent}%), ${dot.point.source}`
              )}</title></circle>`
          )
          .join('')
      : '';

  const gap = geometry.spanDays === 0 ? '' : ` The horizontal axis is time, so a flat stretch is a period in which nothing was ticked.`;

  return `<section>
<h2>Progress over time</h2>
<svg class="spark" viewBox="0 0 ${SPARK_BOX.width} ${SPARK_BOX.height}" role="img" aria-label="${escapeHtml(
    `Completion from ${first.percent} percent on ${first.date} to ${last.percent} percent on ${last.date}, over ${geometry.spanDays} days`
  )}">
${guides}
<path class="area" d="${geometry.area}"></path>
<path class="line" d="${geometry.line}"></path>
${dots}
<line class="axis" x1="${SPARK_BOX.paddingLeft}" y1="${baseline}" x2="${rightEdge}" y2="${baseline}"></line>
${ticks}
</svg>
<p class="caption">${escapeHtml(historyCaption(points, geometry.spanDays))}${gap}</p>
</section>`;
}

function renderGitEvidence(evidence: ChangeGitEvidence | undefined): string {
  if (!evidence) {
    return `<section>
<h2>Git evidence</h2>
<p class="empty">Git evidence is off. Turn on <code>openspecLedger.gitEvidence.enabled</code> to look for a commit that corroborates each completed task.</p>
</section>`;
  }

  if (!evidence.available) {
    return `<section>
<h2>Git evidence</h2>
<p class="empty">${escapeHtml(unavailableSentence(evidence.reason, evidence.reasonText))}</p>
</section>`;
  }

  const counts = evidenceCounts(evidence.results);
  const unsearched = unsearchedTasks(evidence.results);
  const unfinished =
    unsearched.unfinished > 0 ? `, ${unsearched.unfinished} whose search did not finish` : '';
  const reasons =
    unsearched.reasons.length > 0
      ? `<p class="caption">${escapeHtml(unsearched.reasons.join(' '))}</p>`
      : '';
  const summary =
    `<p class="caption">${escapeHtml(
      `${evidence.results.length} completed task${evidence.results.length === 1 ? '' : 's'} examined: ` +
        `${counts.corroborated} corroborated, ${counts['no-references']} naming nothing to search for, ` +
        `${counts['no-trace']} with no trace found, ${unsearched.undated} with no known completion date${unfinished}.`,
    )}</p>` + reasons;

  if (evidence.noTrace.length === 0) {
    // A search that did not finish leaves tasks unaccounted for, so the empty
    // state claims only what was actually looked at.
    const nothing =
      unsearched.unfinished > 0
        ? 'Nothing to review among the tasks that were searched.'
        : 'Nothing to review: every completed task either matched a commit or named nothing to search for.';
    return `<section>
<h2>Git evidence</h2>
${summary}
<p class="empty">${escapeHtml(nothing)}</p>
</section>`;
  }

  return `<section>
<h2>No trace found <span class="badge">${evidence.noTrace.length}</span></h2>
${summary}
<p class="lede">These completed tasks name files or symbols that no commit in the window touched. Read it as a prompt to look, not as a finding: a refactor renames things, work can land in a file the task never names, and squashed history loses the window. Dismiss a result once you have judged it.</p>
<div class="results">${evidence.noTrace.map(renderNoTrace).join('')}</div>
</section>`;
}

function renderNoTrace(result: TaskEvidence): string {
  const references = [
    ...result.references.paths.map((value) => ({ value, kind: 'path' })),
    ...result.references.symbols.map((value) => ({ value, kind: 'symbol' })),
  ];
  const window = searchWindowText(result);

  const referenceList =
    references.length > 0
      ? references
          .map(
            (reference) =>
              `<code class="ref ${reference.kind}">${escapeHtml(reference.value)}</code>`,
          )
          .join(' ')
      : '<span class="muted">none</span>';

  const commands =
    result.commands.length > 0
      ? `<pre>${result.commands.map((command) => escapeHtml(command)).join('\n')}</pre>`
      : '<span class="muted">none</span>';

  return `<article class="result" data-result>
<div class="result-head">
<span class="result-label">${escapeHtml(result.label)}</span>
<span class="muted">line ${result.line}</span>
<button class="dismiss" data-dismiss="${escapeHtml(
    result.taskKey,
  )}" title="Do not surface this task again unless its line text changes">Dismiss</button>
</div>
<dl>
<dt>References searched</dt><dd>${referenceList}</dd>
<dt>Window</dt><dd>${escapeHtml(window)}</dd>
<dt>Commands run</dt><dd>${commands}</dd>
</dl>
</article>`;
}

function renderClaudeEvidence(evidence: ChangeClaudeEvidence | undefined): string {
  if (!evidence) {
    return `<section>
<h2>Claude Code sessions</h2>
<p class="empty">Claude Code evidence is off. Turn on <code>openspecLedger.claudeEvidence.enabled</code> to see which sessions worked on this change. ${escapeHtml(
      PRIVACY_NOTE,
    )}</p>
</section>`;
  }

  if (!evidence.available) {
    return `<section>
<h2>Claude Code sessions</h2>
<p class="empty">${escapeHtml(unavailableSentence(evidence.reason, evidence.reasonText))}</p>
</section>`;
  }

  const rollup = evidence.rollup;
  if (evidence.sessions.length === 0 || !rollup) {
    return `<section>
<h2>Claude Code sessions</h2>
<p class="empty">No session on this machine referenced this change. That is an absence of measurement rather than a measured zero.</p>
</section>`;
  }

  const unpriced =
    rollup.unpricedModels.length > 0
      ? `<p class="caption">Matched no price entry, so contributing nothing to the estimate: ${rollup.unpricedModels
          .map((model) => `<code>${escapeHtml(model)}</code>`)
          .join(', ')}.</p>`
      : '';

  const files =
    rollup.editedFiles.length > 0
      ? `<details><summary>${rollup.editedFiles.length} file${
          rollup.editedFiles.length === 1 ? '' : 's'
        } edited outside openspec/</summary><ul class="files">${rollup.editedFiles
          .map((file) => `<li><code>${escapeHtml(file)}</code></li>`)
          .join('')}</ul></details>`
      : '<p class="caption">No file outside <code>openspec/</code> was recorded as edited by these sessions.</p>';

  return `<section>
<h2>Claude Code sessions <span class="badge">${rollup.sessions}</span></h2>
<p class="caption">${escapeHtml(
    `${formatDateTime(rollup.from)} to ${formatDateTime(rollup.to)}.`,
  )} <span class="estimate">ESTIMATE</span> ${escapeHtml(ESTIMATE_NOTE)}</p>
<div class="cards">
<div class="card"><span class="card-label">Input tokens</span><span class="card-value">${formatCount(
    rollup.tokens.input,
  )}</span></div>
<div class="card"><span class="card-label">Output tokens</span><span class="card-value">${formatCount(
    rollup.tokens.output,
  )}</span></div>
<div class="card"><span class="card-label">Cache write / read</span><span class="card-value">${formatCount(
    rollup.tokens.cacheWrite,
  )} / ${formatCount(rollup.tokens.cacheRead)}</span></div>
<div class="card"><span class="card-label">Cost <span class="estimate">EST</span></span><span class="card-value">${escapeHtml(
    formatUsd(rollup.costUsd),
  )}</span></div>
</div>
${unpriced}
${renderSessionTable(evidence.sessions)}
${files}
${renderCheckedWithoutCode(evidence)}
<p class="privacy">${escapeHtml(PRIVACY_NOTE)}</p>
</section>`;
}

function renderSessionTable(sessions: readonly SessionSummary[]): string {
  const rows = sessions
    .map((session) => {
      const models =
        session.models.length > 0
          ? session.models.map((model) => `<code>${escapeHtml(model)}</code>`).join('<br>')
          : '<span class="muted">unknown</span>';
      const cwd = session.cwd ? `<div class="muted path">${escapeHtml(session.cwd)}</div>` : '';
      return `<tr>
<td><code title="${escapeHtml(session.transcriptPath)}">${escapeHtml(
        session.sessionId.slice(0, 8),
      )}</code>${cwd}</td>
<td>${escapeHtml(formatDateTime(session.firstActivity))}</td>
<td>${escapeHtml(formatDateTime(session.lastActivity))}</td>
<td>${models}</td>
<td class="num">${formatCount(session.messageCount)}</td>
<td class="num">${formatCount(session.tokens.input)}</td>
<td class="num">${formatCount(session.tokens.output)}</td>
<td class="num">${formatCount(session.tokens.cacheWrite)} / ${formatCount(
        session.tokens.cacheRead,
      )}</td>
<td class="num">${escapeHtml(formatUsd(session.costUsd))}</td>
<td class="num">${editedFilesCell(session.editedFiles)}</td>
</tr>`;
    })
    .join('');

  return `<div class="table-scroll"><table>
<thead><tr>
<th>Session</th><th>First</th><th>Last</th><th>Models</th>
<th class="num">Msgs</th><th class="num">In</th><th class="num">Out</th>
<th class="num">Cache w/r</th><th class="num">Cost <span class="estimate">EST</span></th>
<th class="num">Files</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

function renderCheckedWithoutCode(evidence: ChangeClaudeEvidence): string {
  if (evidence.checkedWithoutCode.length === 0) {
    return '';
  }
  const rows = evidence.checkedWithoutCode
    .map((item) => {
      const sessions =
        item.sessionIds.length > 0
          ? item.sessionIds.map((id) => `<code>${escapeHtml(id.slice(0, 8))}</code>`).join(' ')
          : '<span class="muted">none</span>';
      return `<tr>
<td>${escapeHtml(item.label)}</td>
<td class="num">${item.line}</td>
<td>${escapeHtml(item.date)}</td>
<td>${sessions}</td>
</tr>`;
    })
    .join('');

  return `<h3>Ticked on a day with no source edit <span class="badge">${evidence.checkedWithoutCode.length}</span></h3>
<p class="lede">On the dates below, the sessions bound to this change recorded no edit outside <code>openspec/</code>. Work done outside Claude Code, or in a session that never named this change, leaves no record here - this is a place to look, not a conclusion.</p>
<div class="table-scroll"><table>
<thead><tr><th>Task</th><th class="num">Line</th><th>Completed</th><th>Sessions considered</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

/**
 * Every colour is an editor theme variable, with a literal only as the fallback
 * for a theme that does not define the chart palette, so the panel reads the
 * same as the editor around it in light, dark and high-contrast themes.
 */
const STYLES = `
:root { color-scheme: light dark; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0;
  padding: 0 20px 40px;
  line-height: 1.5;
}
h1 { font-size: 1.5em; font-weight: 600; margin: 20px 0 2px; }
h2 { font-size: 1.1em; font-weight: 600; margin: 0 0 8px; }
h3 { font-size: 1em; font-weight: 600; margin: 20px 0 4px; }
p { margin: 6px 0; }
section { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); }
code, pre { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; }
pre { margin: 4px 0 0; padding: 8px 10px; overflow-x: auto; white-space: pre; border-radius: 3px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12)); }
.subtitle { margin: 0 0 12px; color: var(--vscode-descriptionForeground); }
.path { word-break: break-all; }
.muted, .caption, .lede, .empty { color: var(--vscode-descriptionForeground); }
.lede, .empty { max-width: 78ch; }
.privacy { margin-top: 16px; font-size: 0.92em; color: var(--vscode-descriptionForeground); }
.cards { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
.card { display: flex; flex-direction: column; gap: 2px; min-width: 130px; padding: 8px 12px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 4px; }
.card-label { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
.card-value { font-size: 1.15em; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { padding: 1px 8px; border-radius: 10px; font-size: 0.85em; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); }
.chip.present { color: var(--vscode-charts-green, var(--vscode-foreground)); }
.chip.absent { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
.badge { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: 9px; font-size: 0.8em; text-align: center; vertical-align: middle; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.estimate { display: inline-block; padding: 0 5px; border-radius: 3px; font-size: 0.72em; letter-spacing: 0.06em; border: 1px solid var(--vscode-charts-orange, var(--vscode-descriptionForeground)); color: var(--vscode-charts-orange, var(--vscode-descriptionForeground)); }
.spark { display: block; width: 100%; max-width: 720px; height: auto; margin: 8px 0 4px; }
.spark .axis { stroke: var(--vscode-panel-border); stroke-width: 1; }
.spark .guide { stroke: var(--vscode-panel-border); stroke-width: 1; opacity: 0.45; }
.spark .tick { stroke: var(--vscode-panel-border); stroke-width: 1; }
.spark .tick-label,
.spark .scale {
  fill: var(--vscode-descriptionForeground);
  font-size: 10px;
  font-family: var(--vscode-font-family);
}
.spark .line { fill: none; stroke: var(--vscode-charts-blue, #3794ff); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.spark .area { fill: var(--vscode-charts-blue, #3794ff); fill-opacity: 0.12; stroke: none; }
.spark .dot { fill: var(--vscode-charts-blue, #3794ff); stroke: var(--vscode-editor-background); stroke-width: 1; }
.spark .dot.backfilled { fill: var(--vscode-editor-background); stroke: var(--vscode-charts-blue, #3794ff); }
.results { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
.result { padding: 10px 12px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-left: 3px solid var(--vscode-charts-orange, var(--vscode-editorWarning-foreground)); border-radius: 4px; }
.result-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; }
.result-label { font-weight: 600; }
.result dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 8px 0 0; }
.result dt { font-size: 0.9em; color: var(--vscode-descriptionForeground); }
.result dd { margin: 0; min-width: 0; }
.ref { padding: 1px 5px; border-radius: 3px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12)); }
.ref.symbol { border-bottom: 1px dotted var(--vscode-descriptionForeground); }
.dismiss { margin-left: auto; padding: 2px 10px; font-family: inherit; font-size: 0.9em; cursor: pointer; border: none; border-radius: 2px; color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground)); background: var(--vscode-button-secondaryBackground, var(--vscode-button-background)); }
.dismiss:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
.dismiss:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.table-scroll { overflow-x: auto; margin-top: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 0.95em; }
th, td { padding: 4px 10px 4px 0; text-align: left; vertical-align: top; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); }
th { font-weight: 600; white-space: nowrap; color: var(--vscode-descriptionForeground); }
td.num, th.num { text-align: right; white-space: nowrap; }
tbody tr:hover { background: var(--vscode-list-hoverBackground); }
.files { margin: 4px 0 0; padding-left: 18px; }
.files li { word-break: break-all; }
details summary { margin-top: 10px; cursor: pointer; color: var(--vscode-descriptionForeground); }
.problems { margin-top: 10px; }
.problems ul { margin: 4px 0 0; padding-left: 18px; color: var(--vscode-descriptionForeground); }
`;

/** Delegated so the markup carries no inline handler, which the policy forbids. */
const SCRIPT = `
const api = acquireVsCodeApi();
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) { return; }
  const button = target.closest('button[data-dismiss]');
  if (!button) { return; }
  api.postMessage({ type: 'dismiss', taskKey: button.getAttribute('data-dismiss') });
  const card = button.closest('[data-result]');
  if (card) { card.hidden = true; }
});
`;

/**
 * The files one session edited, behind a disclosure.
 *
 * The spec asks for the SET, not a count: which files a session touched is the
 * whole substance of the provenance layer, and a bare number cannot be checked
 * against anything. The list is collapsed because a long session edits dozens.
 */
export function editedFilesCell(files: readonly string[]): string {
  if (files.length === 0) {
    return '0';
  }
  const items = files
    .map((file) => `<li><code>${escapeHtml(file)}</code></li>`)
    .join('');
  return `<details><summary>${files.length}</summary><ul class="files">${items}</ul></details>`;
}
