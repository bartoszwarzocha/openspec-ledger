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

import type {
  ChangeStatus,
  FilterMode,
  LedgerScope,
  Overview,
  OverviewRow,
  RootStatus,
} from '../model/types.ts';
import { FILTER_MODES, LEDGER_SCOPES } from '../model/types.ts';

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
  private readonly scoped = new vscode.EventEmitter<LedgerScope>();
  private readonly acted = new vscode.EventEmitter<OverviewAction>();
  private readonly listeners: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private disposed = false;

  /** Until the controller says otherwise, an empty list means "not yet". */
  private overview: Overview = {
    rows: [],
    totals: emptyTotals(),
    filter: 'all',
    scope: 'current',
    loading: true,
  };

  readonly onDidSelect: vscode.Event<OverviewSelection> = this.selected.event;
  /** A tally entry was clicked; the header is the fastest route to a filter. */
  readonly onDidFilter: vscode.Event<FilterMode> = this.filtered.event;
  /** Current or Archive was pressed. Unlike a filter, this needs a rebuild. */
  readonly onDidChangeScope: vscode.Event<LedgerScope> = this.scoped.event;
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

  /**
   * Say a pass is running without touching the rows.
   *
   * Separate from `setOverview` because the rows on screen are the answer to
   * the *previous* question and there is no new answer yet: rebuilding them
   * against a model that has not read the new scope is exactly the flash this
   * avoids. So the list stays, dimmed, under a bar.
   */
  setBusy(busy: boolean): void {
    if ((this.overview.busy === true) === busy) {
      return;
    }
    this.overview = { ...this.overview, busy };
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
    this.scoped.dispose();
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
      scope?: unknown;
      action?: unknown;
    };

    if (payload.type === 'scope') {
      if (typeof payload.scope === 'string' && (LEDGER_SCOPES as readonly string[]).includes(payload.scope)) {
        this.scoped.fire(payload.scope as LedgerScope);
      }
      return;
    }

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

/**
 * The two words that mean something else once the work is over.
 *
 * `stalled` needs no entry: `statusOf` never calls an archived change stale, so
 * that chip cannot appear in this scope at all.
 */
const ARCHIVE_STATUS_WORDS: Partial<Record<ChangeStatus, string>> = {
  complete: 'finished',
  active: 'with tasks open',
};

function statusWord(status: ChangeStatus, scope: LedgerScope): string {
  return (scope === 'archive' ? ARCHIVE_STATUS_WORDS[status] : undefined) ?? STATUS_WORDS[status];
}

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

function renderRow(row: OverviewRow, showRoot: boolean, archived: boolean): string {
  const counts = row.progress
    ? `${row.progress.completed}/${row.progress.total} &middot; ${row.progress.percent}%`
    : '&ndash;';
  const { date, name } = splitChangeId(row.changeId);

  // The figures read as one phrase - `8/12 · 67% · stalled 24 days` - because
  // that is one thought and splitting it across columns left the state of the
  // change floating away from the numbers it belongs to. Where the change lives
  // matters least of the three, so it goes last and dimmed.
  const stats = [counts, row.note].filter((part) => part.length > 0).join(' &middot; ');
  // In the archive the caption already carries a date - the day the change was
  // put away - and the one in the id is the day it was created. Two bare dates
  // on one row, neither labelled, would be read as a range or as a mistake, so
  // the creation date steps back to the tooltip and the detail panel.
  const trailing = [archived ? undefined : date, showRoot ? row.rootLabel : undefined].filter(
    (part): part is string => part !== undefined,
  );
  const context =
    trailing.length > 0 ? `<span class="line3">${escapeHtml(trailing.join(' · '))}</span>` : '';
  const title = `${row.changeId} - ${row.rootLabel} - ${row.note}`;
  const where = `data-root="${escapeHtml(row.rootPath)}" data-change="${escapeHtml(row.changeId)}"`;

  // A finished change is the one row that has an obvious next step, and making
  // the reader leave this list to take it is what the filter was meant to save
  // them. The button rides on the row rather than living in a menu.
  const action =
    row.status === 'complete' && !archived
      ? `<button type="button" class="row-action" data-action="archive" ${where}` +
        ` title="${escapeHtml(`Archive ${row.changeId}`)}" aria-label="${escapeHtml(`Archive ${row.changeId}`)}">${ARCHIVE_ICON}</button>`
      : '';

  return `<div class="row ${row.status}">
<button type="button" class="row-main" ${where} title="${escapeHtml(title)}">
${icon(row.status)}
<span class="lines"><span class="line1"><span class="change-id">${escapeHtml(name)}</span></span>
<span class="line2"><span class="stats">${stats}</span></span>
${context}</span>
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
function renderHeader(totals: RootStatus, active: FilterMode, scope: LedgerScope): string {
  const items = TALLY_ORDER.filter((status) => totals[status] > 0).map((status) => {
    const filter = STATUS_FILTERS[status];
    const on = filter === active;
    const label = escapeHtml(statusWord(status, scope));
    // Colon rather than a bare join: the words differ in grammatical shape
    // - `finished` is an adjective, `with tasks open` a phrase - and no single
    // sentence reads well with both. A label after a colon is a label.
    const title = on ? `Showing only: ${label} - click to show all` : `Show only: ${label}`;
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
  // Never in the archive: everything there has already been through it.
  const archiveAll =
    totals.complete > 0 && scope !== 'archive'
      ? `<button type="button" class="tally-action" data-action="archive-all"` +
        ` title="${escapeHtml(`Archive all ${totals.complete} completed changes`)}">` +
        `${ARCHIVE_ICON}<span>Archive ${totals.complete}</span></button>`
      : '';

  return `<header class="tally">${items.join('')}${archiveAll}</header>`;
}

/**
 * The two words the scope switch answers to.
 *
 * `Current` rather than `Active`: the tally already uses "in progress" for one
 * of the four states, and a switch that shares a word with a filter beside it
 * reads as though the two do the same job.
 */
const SCOPE_LABELS: Record<LedgerScope, string> = {
  current: 'Current',
  archive: 'Archive',
};

const SCOPE_TITLES: Record<LedgerScope, string> = {
  current: 'Changes still in openspec/changes/',
  archive: 'Changes moved into openspec/changes/archive/',
};

/**
 * The scope switch, and the reason it is rendered before anything else can
 * decide not to render.
 *
 * An archive with nothing in it draws the empty state, and an empty state with
 * no way back would strand the reader in a view they cannot leave without the
 * command palette. So the switch is outside that branch, always.
 */
function renderScopes(active: LedgerScope): string {
  const buttons = LEDGER_SCOPES.map((scope) => {
    const on = scope === active;
    return (
      `<button type="button" class="scope${on ? ' on' : ''}" data-scope="${scope}"` +
      ` title="${escapeHtml(SCOPE_TITLES[scope])}" aria-pressed="${on ? 'true' : 'false'}">` +
      `${escapeHtml(SCOPE_LABELS[scope])}</button>`
    );
  });
  return `<nav class="scopes" role="group" aria-label="Which changes to show">${buttons.join('')}</nav>`;
}

/**
 * The bar that says a pass is running.
 *
 * Pressing Archive can mean reading a directory bigger than the active list,
 * and until now that looked like nothing happening: the old rows sat there, the
 * button was pressed, and the answer arrived some time later. A slim
 * indeterminate bar under the switch is the smallest honest thing to draw -
 * there is no total to count towards, and replacing the rows with a spinner
 * would throw away a list that is still worth reading while the next one loads.
 */
const BUSY_BAR = '<div class="busy" role="status" aria-label="Loading"><span></span></div>';

/**
 * An empty list is an answer, and which answer it is matters: one says wait,
 * one says look at the filter, and one says nothing has been archived.
 */
function renderEmpty(loading: boolean, scope: LedgerScope): string {
  if (loading) {
    return `<div class="empty"><p>Looking for OpenSpec changes...</p>
<p class="hint">The list appears as soon as discovery has answered.</p></div>`;
  }
  if (scope === 'archive') {
    return `<div class="empty"><p>Nothing has been archived yet.</p>
<p class="hint">A change moves here when <code>openspec archive</code> folds its spec deltas into <code>openspec/specs/</code>. Press Current to go back to the work in flight.</p></div>`;
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
  const scope = overview.scope ?? 'current';
  const empty = overview.rows.length === 0;
  const busy = overview.busy === true;
  const top =
    `<div class="top">${renderScopes(scope)}` +
    `${empty ? '' : renderHeader(overview.totals, overview.filter, scope)}` +
    `${busy ? BUSY_BAR : ''}</div>`;
  const body = empty
    ? `${top}${renderEmpty(overview.loading === true, scope)}`
    : `${top}<div class="rows${busy ? ' waiting' : ''}">${overview.rows
        .map((row) => renderRow(row, showRoot, scope === 'archive'))
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
/* Scope switch and tally travel together: both answer "what am I looking at",
   and a reader who scrolls a hundred archived changes must not lose the way
   back out of the archive. */
.top {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
}
/* Two words, not two icons. This is the one control that changes which universe
   of changes the whole view is about, so it says so in language rather than
   asking the reader to learn a glyph. */
.scopes {
  display: flex;
  gap: 4px;
  padding: 8px 12px 0;
}
.scope {
  flex: 1 1 0;
  margin: 0;
  padding: 3px 10px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
  border-radius: 4px;
  background: none;
  color: var(--vscode-descriptionForeground);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.scope:hover { background: var(--vscode-toolbar-hoverBackground); }
.scope:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.scope.on {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-button-background, var(--vscode-list-activeSelectionBackground));
  color: var(--vscode-button-foreground, var(--vscode-list-activeSelectionForeground));
  font-weight: 600;
}
.tally {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  padding: 7px 12px 6px;
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
/* A two-pixel indeterminate bar. There is no total to count towards - the pass
   reads however many directories the project has - so a determinate bar would
   be a fiction, and a spinner in the middle of the list would take away rows
   that are still worth reading while the next set loads. */
.busy { height: 2px; overflow: hidden; background: var(--vscode-panel-border, rgba(128,128,128,0.3)); }
.busy > span {
  display: block;
  width: 34%;
  height: 100%;
  background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
  animation: slide 1.1s ease-in-out infinite;
}
@keyframes slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(390%); }
}
/* Motion is decoration here: the bar's presence is the message, so a reader who
   has asked for less of it still sees the state. */
@media (prefers-reduced-motion: reduce) {
  .busy > span { width: 100%; animation: none; opacity: 0.6; }
}
.rows { display: flex; flex-direction: column; }
/* The rows are from before the pass that is running. Dimming says so without
   removing them, which is the difference between "still working" and "gone". */
.rows.waiting { opacity: 0.45; }
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
.row-main > .icon { margin-top: 1px; }
/* The lines are one block beside the icon rather than three grid items sharing
   a column with it. A row carries two or three of them depending on whether it
   has a root label, and spanning the icon across a count that changes per row
   is what put the third line on top of the second. */
.lines { display: block; min-width: 0; }
.line1 { display: block; min-width: 0; }
.line2, .line3 { margin-top: 3px; }
.change-id {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
/* A line of its own rather than the tail of the figures.
   Sharing line 2 made the label the part that gave way in a narrow sidebar, and
   it gave way to nothing useful: two roots under the same parent truncate to
   the same prefix, so the one thing the label exists to answer - which
   repository is this - was exactly what the truncation took. On its own line it
   has the full width. */
.line3 {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.92em;
  color: var(--vscode-descriptionForeground);
  opacity: 0.75;
}
/* The figures and the state belong together as a phrase, so they share one
   line rather than sitting in a grid of columns. */
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

  const scope = target.closest('button[data-scope]');
  if (scope) {
    api.postMessage({ type: 'scope', scope: scope.getAttribute('data-scope') });
    return;
  }

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
