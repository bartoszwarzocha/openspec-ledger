/**
 * The overview view: `Overview` in, two lines of HTML per row out.
 *
 * Everything this file could get wrong is layout. Which changes appear, what
 * order they are in, what the caption says and which file a click opens are all
 * decided in `overview.ts`, which is pure and unit-tested; nothing here reads a
 * model or judges a status.
 *
 * The page is self-contained and locked down: no network, no local resources,
 * a nonce on the one stylesheet and the one script. Change ids and root labels
 * come off the user's filesystem, so nothing is interpolated raw.
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

import type { ChangeStatus, FilterMode, Overview, OverviewRow, RootStatus } from '../model/types.ts';
import { FILTER_MODES } from '../model/types.ts';

export interface OverviewSelection {
  rootPath: string;
  changeId: string;
}

/** A per-row action; only archiving exists today, and only on a finished change. */
export type OverviewAction =
  | ({ action: 'archive' } & OverviewSelection)
  /** Every completed change at once; it names no single one. */
  | { action: 'archive-all' };

export class OverviewViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'openspecLedger.overview';

  private readonly selected = new vscode.EventEmitter<OverviewSelection>();
  private readonly filtered = new vscode.EventEmitter<FilterMode>();
  private readonly acted = new vscode.EventEmitter<OverviewAction>();
  private readonly listeners: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private disposed = false;

  /** Until the controller says otherwise, an empty list means "not yet". */
  private overview: Overview = { rows: [], totals: emptyTotals(), filter: 'all', loading: true };

  readonly onDidSelect: vscode.Event<OverviewSelection> = this.selected.event;
  /** A tally entry was clicked; the header is the fastest route to a filter. */
  readonly onDidFilter: vscode.Event<FilterMode> = this.filtered.event;
  /** A row action was pressed, so the reader never has to leave this list. */
  readonly onDidAct: vscode.Event<OverviewAction> = this.acted.event;

  constructor(context: vscode.ExtensionContext) {
    // A reload must not leave the emitter alive behind a view that is gone.
    context.subscriptions.push(new vscode.Disposable(() => this.dispose()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // The page carries its own styles and icons, so nothing may be loaded
      // from disk either.
      localResourceRoots: [],
    };

    this.listeners.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        this.handleMessage(message);
      }),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.view = undefined;
        }
      }),
    );

    this.render();
  }

  setOverview(overview: Overview): void {
    this.overview = overview;
    this.render();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const listener of this.listeners.splice(0, this.listeners.length)) {
      listener.dispose();
    }
    this.selected.dispose();
    this.filtered.dispose();
    this.acted.dispose();
    this.view = undefined;
  }

  private render(): void {
    if (this.view && !this.disposed) {
      this.view.webview.html = renderHtml(this.overview, createNonce());
    }
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const payload = message as {
      type?: unknown;
      rootPath?: unknown;
      changeId?: unknown;
      filter?: unknown;
      action?: unknown;
    };

    if (payload.type === 'filter') {
      // Validated against the known set rather than trusted: the page is ours,
      // but a webview message is still input crossing a boundary.
      if (typeof payload.filter === 'string' && (FILTER_MODES as readonly string[]).includes(payload.filter)) {
        this.filtered.fire(payload.filter as FilterMode);
      }
      return;
    }

    if (payload.type === 'action') {
      if (payload.action === 'archive-all') {
        this.acted.fire({ action: 'archive-all' });
      } else if (
        payload.action === 'archive' &&
        typeof payload.rootPath === 'string' &&
        typeof payload.changeId === 'string'
      ) {
        this.acted.fire({ action: 'archive', rootPath: payload.rootPath, changeId: payload.changeId });
      }
      return;
    }

    if (
      payload.type !== 'select' ||
      typeof payload.rootPath !== 'string' ||
      typeof payload.changeId !== 'string'
    ) {
      return;
    }
    this.selected.fire({ rootPath: payload.rootPath, changeId: payload.changeId });
  }
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
 * Change ids, root labels and captions all originate in the user's
 * repositories, so every one of them goes through here on its way into the
 * page.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Four icons, drawn rather than borrowed.
 *
 * A webview has no codicon font, and an emoji would render as somebody else's
 * artwork at somebody else's size. Each shape carries `currentColor`, so the
 * row's status colour paints it without a second table of colours.
 */
const STATUS_ICONS: Record<ChangeStatus, string> = {
  complete:
    '<circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<path d="M5 8.3 7.1 10.4 11 5.9" fill="none" stroke="currentColor" stroke-width="1.6"' +
    ' stroke-linecap="round" stroke-linejoin="round"/>',
  stale:
    '<path d="M8 1.9 15 14.1H1Z" fill="none" stroke="currentColor" stroke-width="1.3"' +
    ' stroke-linejoin="round"/>' +
    '<path d="M8 6.2v3.6" fill="none" stroke="currentColor" stroke-width="1.5"' +
    ' stroke-linecap="round"/>' +
    '<circle cx="8" cy="12" r="0.85" fill="currentColor"/>',
  active:
    '<circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<circle cx="8" cy="8" r="2.8" fill="currentColor"/>',
  // Dashes, because the outline of the work is all that exists yet.
  undecomposed:
    '<circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"' +
    ' stroke-dasharray="2.1 2.4"/>',
};

/** The word each state answers to in the header tally. */
const STATUS_WORDS: Record<ChangeStatus, string> = {
  complete: 'complete',
  stale: 'stalled',
  active: 'in progress',
  undecomposed: 'not decomposed',
};

const TALLY_ORDER: readonly ChangeStatus[] = ['complete', 'stale', 'active', 'undecomposed'];

function emptyTotals(): RootStatus {
  return { status: 'active', complete: 0, stale: 0, active: 0, undecomposed: 0 };
}

/** A box with a lid, in the same hand as the status icons. */
const ARCHIVE_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<rect x="1.9" y="2.4" width="12.2" height="3" rx="0.7" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
  '<path d="M3.1 5.9v6.6c0 .6.5 1.1 1.1 1.1h7.6c.6 0 1.1-.5 1.1-1.1V5.9" fill="none"' +
  ' stroke="currentColor" stroke-width="1.3"/>' +
  '<path d="M6.4 8.6h3.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
  '</svg>';

function icon(status: ChangeStatus): string {
  return `<svg class="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">${STATUS_ICONS[status]}</svg>`;
}

/**
 * OpenSpec change ids run long - `2026-08-11-unique-field-validation`
 * is a real one - and the leading date is the least distinguishing part of it.
 * A sidebar is narrow, so the date moves to the quiet second line and the name
 * gets the whole of the first.
 */
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})[-_](.+)$/;

export function splitChangeId(changeId: string): { date?: string; name: string } {
  const match = DATE_PREFIX.exec(changeId);
  const date = match?.[1];
  const name = match?.[2];
  return date !== undefined && name !== undefined ? { date, name } : { name: changeId };
}

function renderRow(row: OverviewRow, showRoot: boolean): string {
  const counts = row.progress
    ? `${row.progress.completed}/${row.progress.total} &middot; ${row.progress.percent}%`
    : '&ndash;';
  const { date, name } = splitChangeId(row.changeId);

  // The figures read as one phrase - `8/12 · 67% · stalled 24 days` - because
  // that is one thought and splitting it across columns left the state of the
  // change floating away from the numbers it belongs to. Where the change lives
  // matters least of the three, so it goes last and dimmed.
  const stats = [counts, row.note].filter((part) => part.length > 0).join(' &middot; ');
  const trailing = [date, showRoot ? row.rootLabel : undefined].filter(
    (part): part is string => part !== undefined,
  );
  const context =
    trailing.length > 0 ? `<span class="context">${escapeHtml(trailing.join(' · '))}</span>` : '';
  const title = `${row.changeId} - ${row.rootLabel} - ${row.note}`;
  const where = `data-root="${escapeHtml(row.rootPath)}" data-change="${escapeHtml(row.changeId)}"`;

  // A finished change is the one row that has an obvious next step, and making
  // the reader leave this list to take it is what the filter was meant to save
  // them. The button rides on the row rather than living in a menu.
  const action =
    row.status === 'complete'
      ? `<button type="button" class="row-action" data-action="archive" ${where}` +
        ` title="${escapeHtml(`Archive ${row.changeId}`)}" aria-label="${escapeHtml(`Archive ${row.changeId}`)}">${ARCHIVE_ICON}</button>`
      : '';

  return `<div class="row ${row.status}">
<button type="button" class="row-main" ${where} title="${escapeHtml(title)}">
${icon(row.status)}
<span class="line1"><span class="change-id">${escapeHtml(name)}</span></span>
<span class="line2"><span class="stats">${stats}</span>${context}</span>
</button>${action}
</div>`;
}

/** Each tally entry answers a filter, which is what makes it worth clicking. */
const STATUS_FILTERS: Record<ChangeStatus, FilterMode> = {
  complete: 'ready-to-archive',
  stale: 'stale',
  active: 'active',
  undecomposed: 'undecomposed',
};

/**
 * The header tally, as buttons.
 *
 * A count you cannot act on is decoration: seeing "3 stalled" and then having to
 * find the filter menu to see which three is exactly the friction this view
 * exists to remove. Clicking the entry that is already active clears the filter,
 * so the same click both narrows and widens.
 */
function renderHeader(totals: RootStatus, active: FilterMode): string {
  const items = TALLY_ORDER.filter((status) => totals[status] > 0).map((status) => {
    const filter = STATUS_FILTERS[status];
    const on = filter === active;
    const label = escapeHtml(STATUS_WORDS[status]);
    const title = on ? `Showing only ${label} - click to show all` : `Show only ${label}`;
    return (
      `<button type="button" class="tally-item ${status}${on ? ' on' : ''}"` +
      ` data-filter="${on ? 'all' : filter}" title="${escapeHtml(title)}"` +
      ` aria-pressed="${on ? 'true' : 'false'}">` +
      `${icon(status)}<span class="count">${totals[status]}</span> ${label}</button>`
    );
  });

  // One press for the whole set. It sits beside the count it acts on, so the
  // reader who has just been told eight things are finished can deal with all
  // eight without opening anything.
  const archiveAll =
    totals.complete > 0
      ? `<button type="button" class="tally-action" data-action="archive-all"` +
        ` title="${escapeHtml(`Archive all ${totals.complete} completed changes`)}">` +
        `${ARCHIVE_ICON}<span>Archive ${totals.complete}</span></button>`
      : '';

  return `<header class="tally">${items.join('')}${archiveAll}</header>`;
}

/**
 * An empty list is an answer, and which answer it is matters: one of these says
 * wait, the other says look at the filter.
 */
function renderEmpty(loading: boolean): string {
  if (loading) {
    return `<div class="empty"><p>Looking for OpenSpec changes...</p>
<p class="hint">The list appears as soon as discovery has answered.</p></div>`;
  }
  return `<div class="empty"><p>No change matches the current filter.</p>
<p class="hint">Clear the filter in the view title to see every change. If the list is still empty, no OpenSpec change was found.</p></div>`;
}

export function renderHtml(overview: Overview, nonce: string): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  // The root label is noise when everything comes from one root, and the one
  // thing you cannot do without when it does not.
  const showRoot = new Set(overview.rows.map((row) => row.rootPath)).size > 1;
  const body =
    overview.rows.length === 0
      ? renderEmpty(overview.loading === true)
      : `${renderHeader(overview.totals, overview.filter)}<div class="rows">${overview.rows
          .map((row) => renderRow(row, showRoot))
          .join('')}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Overview</title>
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>
${body}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const STYLES = `
:root { color-scheme: light dark; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: transparent;
  margin: 0;
  padding: 0 0 12px;
  line-height: 1.35;
}
p { margin: 0 0 6px; }
/* Status lives in one custom property per row, so the icon and the bar are
   coloured from the same decision. Only the two states that call for a decision
   are tinted; colouring all four would leave the eye nothing to land on. */
.complete { --status: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #89d185)); }
.stale { --status: var(--vscode-list-warningForeground, var(--vscode-editorWarning-foreground, #cca700)); }
.active { --status: var(--vscode-foreground); }
.undecomposed { --status: var(--vscode-descriptionForeground); }
.icon { color: var(--status); flex: none; }
.tally {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  padding: 7px 12px 6px;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
}
.tally-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  color: var(--vscode-descriptionForeground);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.tally-item:hover { background: var(--vscode-toolbar-hoverBackground); }
.tally-item:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
/* The active filter is stated, not merely implied by a shorter list. */
.tally-item.on {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.tally-item.on .count { color: inherit; }
.tally-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  padding: 2px 8px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.tally-action:hover { background: var(--vscode-button-secondaryHoverBackground); }
.tally-action:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.tally-item .count { color: var(--vscode-foreground); font-variant-numeric: tabular-nums; }
.rows { display: flex; flex-direction: column; }
/* The row holds the main button and, on a finished change, the archive action.
   A button cannot be nested inside a button, so the row itself is a container. */
.row {
  display: flex;
  align-items: stretch;
  border-left: 2px solid transparent;
}
.row-main {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  column-gap: 8px;
  row-gap: 3px;
  align-items: start;
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
  margin: 0;
  padding: 6px 4px 7px 8px;
  border: none;
  border-radius: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.row-action {
  flex: 0 0 auto;
  align-self: center;
  margin: 0 8px 0 4px;
  padding: 3px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  /* Revealed on hover or focus, like the tree's own inline actions, so a list
     of thirty rows is not a wall of buttons. */
  opacity: 0;
}
.row:hover .row-action,
.row-action:focus-visible { opacity: 1; }
.row-action:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
.row-action:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
/* The rule down the edge is spent on the one state that wants attention. */
.row.stale { border-left-color: var(--status); }
.row:hover, .row:focus-within { background: var(--vscode-list-hoverBackground); }
.row-main:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
  background: var(--vscode-list-hoverBackground);
}
.row > .icon { grid-row: 1 / span 2; margin-top: 1px; }
.line1 { display: block; min-width: 0; }
.change-id {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.context {
  flex: 0 1 auto;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.6;
}
/* One flexible line rather than a grid of columns: the figures and the state
   belong together as a phrase, and a fixed column between them was pulling them
   apart. Where the change lives is the least useful of the three, so it trails
   at the end and dims. */
.line2 {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  font-size: 0.92em;
  color: var(--vscode-descriptionForeground);
}
.stats {
  flex: 0 0 auto;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  color: var(--vscode-foreground);
}
.empty { padding: 14px 14px 0; max-width: 60ch; }
.empty .hint { color: var(--vscode-descriptionForeground); }
`;

/**
 * The click handler, and one small courtesy: a refresh replaces the whole
 * document, and a reader who has scrolled to the bottom of thirty changes
 * should not be sent back to the top every time a task is ticked.
 */
const SCRIPT = `
const api = acquireVsCodeApi();
const saved = api.getState();
if (saved && typeof saved.scrollTop === 'number') {
  window.scrollTo(0, saved.scrollTop);
}
window.addEventListener('scroll', () => {
  api.setState({ scrollTop: window.scrollY });
}, { passive: true });
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) { return; }

  const tally = target.closest('button[data-filter]');
  if (tally) {
    api.postMessage({ type: 'filter', filter: tally.getAttribute('data-filter') });
    return;
  }

  const action = target.closest('button[data-action]');
  if (action) {
    api.postMessage({
      type: 'action',
      action: action.getAttribute('data-action'),
      rootPath: action.getAttribute('data-root'),
      changeId: action.getAttribute('data-change'),
    });
    return;
  }

  const row = target.closest('button.row-main');
  if (!row) { return; }
  api.postMessage({
    type: 'select',
    rootPath: row.getAttribute('data-root'),
    changeId: row.getAttribute('data-change'),
  });
});
`;
