/**
 * Wiring. Everything the extension does is assembled here: discovery feeds the
 * model, the model feeds the tree and the history store, and the two evidence
 * layers hang off the change detail panel.
 *
 * The one rule this file exists to enforce is the activation budget. Nothing
 * below runs while `activate` is on the stack: `start()` is scheduled after it
 * returns, so the view is registered and rendering before any directory is
 * read (design.md D13).
 */

import * as path from 'node:path';
import * as vscode from 'vscode';

import { RootCache } from './discovery/cache.ts';
import { createWorkspaceSearcher } from './discovery/vscodeSearch.ts';
import { evaluateClaudeEvidence } from './evidence/claude.ts';
import { evaluateGitEvidence } from './evidence/git.ts';
import { TranscriptIndex } from './evidence/transcripts.ts';
import { backfillRoot } from './history/backfill.ts';
import { lastAdvanced as deriveLastAdvanced, stallOf } from './history/derive.ts';
import { HistoryStore } from './history/store.ts';
import { ModelBuilder } from './model/build.ts';
import { changeKey, makeProgress, sumProgress, toDateKey } from './model/keys.ts';
import { addExclusion, applyExclusions, removeExclusion } from './model/exclude.ts';
import { DEFAULT_STALE_AFTER_DAYS, statusOf } from './model/status.ts';
import type {
  Change,
  LedgerModel,
  LedgerNode,
  OpenSpecRoot,
  Progress,
  FilterMode,
  SortMode,
  Stall,
  Task,
  TaskState,
  TreeOptions,
} from './model/types.ts';
import { FILTER_MODES, SORT_MODES } from './model/types.ts';
import { buildMovementReport, renderMovementReport } from './report/movement.ts';
import { countReadyToArchive, filterLabel } from './view/nodes.ts';
import { buildOverview } from './view/overview.ts';
import { OverviewViewProvider } from './view/overviewPanel.ts';
import { ChangeDetailPanel } from './view/detail.ts';
import { LedgerTreeDataProvider } from './view/tree.ts';
import { applyToggle } from './view/writeback.ts';
import { buildSectionPrompt, buildTaskPrompt } from './handoff/prompt.ts';
import { deliverPrompt } from './handoff/terminal.ts';
import { isChatAvailable, sendToChat } from './handoff/chat.ts';
import { archiveChange, archiveChanges, DEFAULT_ARCHIVE_COMMAND } from './handoff/archive.ts';
import { DEFAULT_HANDOFF_TARGET, resolveTarget, type HandoffTarget } from './handoff/target.ts';
import { log } from './util/log.ts';

const SORT_MODE_KEY = 'openspecLedger.sortMode';
const FILTER_KEY = 'openspecLedger.filter';
/** Context key the view-title menus compare against. */
const FILTER_CONTEXT = 'openspecLedger.filtered';
const PASS_DEBOUNCE_MS = 300;

const SORT_LABELS: Record<SortMode, { label: string; detail: string }> = {
  name: { label: 'Name', detail: 'Alphabetical by change identifier' },
  progress: { label: 'Progress', detail: 'Descending by completion percentage' },
  'nearest-done': { label: 'Nearest done', detail: 'Fewest tasks remaining first' },
  stalled: { label: 'Stalled longest', detail: 'Longest without advancing first' },
  created: { label: 'Newest', detail: 'Most recently created first' },
};

export class LedgerController implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly tree: LedgerTreeDataProvider;
  private readonly view: vscode.TreeView<LedgerNode>;
  private readonly rootCache = new RootCache();
  private readonly builder: ModelBuilder;
  private readonly store: HistoryStore;
  private readonly transcripts = new TranscriptIndex();
  private readonly overview: OverviewViewProvider;
  private readonly disposables: vscode.Disposable[] = [];

  private watchers: vscode.FileSystemWatcher[] = [];
  private roots: OpenSpecRoot[] = [];
  private model: LedgerModel | undefined;
  private stalls: Record<string, Stall | undefined> = {};
  private lastAdvanced: Record<string, string | undefined> = {};

  private passTimer: NodeJS.Timeout | undefined;
  private passRunning = false;
  private passQueued = false;
  private rediscoverPending = false;
  private discovered = false;
  private readonly seenChanges = new Set<string>();
  private backfillAbort: AbortController | undefined;
  private disposed = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.builder = new ModelBuilder({ tabWidth: tabWidth() });
    // design.md D6 names `globalStorage/history`; the store itself stays
    // ignorant of the editor's storage conventions and writes where it is told.
    this.store = new HistoryStore(path.join(context.globalStorageUri.fsPath, 'history'));
    this.tree = new LedgerTreeDataProvider();
    this.overview = new OverviewViewProvider(context);
    this.view = vscode.window.createTreeView<LedgerNode>('openspecLedger.ledger', {
      treeDataProvider: this.tree,
      showCollapseAll: true,
      manageCheckboxStateManually: true,
    });

    this.disposables.push(this.view, this.tree, this.store, this.overview);
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(OverviewViewProvider.viewType, this.overview, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      // Clicking a row in the overview is a request to work on that change,
      // so it opens the same thing the tree would.
      this.overview.onDidSelect((selection) => void this.revealFromOverview(selection)),
      // Clicking a count in the header is a request to see those ones.
      this.overview.onDidFilter((filter) => void this.setFilter(filter)),
      // Archiving from the row itself: filtering to the finished changes and
      // then sending the reader to the tree to act on them would waste the
      // filter entirely.
      this.overview.onDidAct((action) => {
        void (action.action === 'archive-all'
          ? this.archiveCompleted()
          : this.archiveByName(action.rootPath, action.changeId));
      })
    );
    this.disposables.push(
      this.view.onDidChangeCheckboxState((event) => void this.onCheckboxChanged(event))
    );

    void this.setState(hasSomethingToSearch() ? 'loading' : 'noWorkspace');
    void vscode.commands.executeCommand('setContext', FILTER_CONTEXT, this.filter !== 'all');

    // Render before anything is read. The spec asks for a loading state inside
    // 300 ms, and `start()` does not run until activation has returned, so
    // without this the view would sit blank for the length of a discovery.
    this.tree.setModel(undefined, this.treeOptions());

    this.registerCommands();
    this.registerListeners();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Called after `activate` has returned, so discovery never delays the view. */
  async start(): Promise<void> {
    await this.refresh({ rediscover: true });
    this.scheduleBackfill();
  }

  dispose(): void {
    this.disposed = true;
    this.backfillAbort?.abort();
    if (this.passTimer) {
      clearTimeout(this.passTimer);
    }
    this.rootCache.cancel();
    this.disposeWatchers();
    ChangeDetailPanel.dispose();
    for (const item of this.disposables.splice(0, this.disposables.length)) {
      item.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // The model pass
  // -------------------------------------------------------------------------

  /**
   * One pass: discover if asked, rebuild the model, refresh the tree, and
   * record today's snapshot. Two passes never overlap - a burst of agent writes
   * to `tasks.md` would otherwise start one pass per write (design.md D13).
   */
  async refresh(options: { rediscover?: boolean } = {}): Promise<void> {
    // A request to rediscover must survive being coalesced. Debouncing a folder
    // change behind a burst of file writes, or queueing Refresh behind a pass
    // already running, would otherwise quietly downgrade it to a plain rebuild
    // and the new folder's roots would never appear.
    this.rediscoverPending = this.rediscoverPending || options.rediscover === true;

    if (this.passRunning) {
      this.passQueued = true;
      return;
    }
    this.passRunning = true;
    const rediscover = this.rediscoverPending;
    this.rediscoverPending = false;
    try {
      if (rediscover) {
        this.rootCache.invalidate();
        this.roots = await this.rootCache.get(this.discoveryInput());
        this.discovered = true;
        log.info(`discovered ${this.roots.length} openspec root(s)`);
      }

      if (this.roots.length === 0) {
        this.model = undefined;
        this.publish();
        await this.setState(hasSomethingToSearch() ? 'noRoots' : 'noWorkspace');
        return;
      }

      const built = await this.builder.build(this.roots);
      // Hidden roots and changes are dropped once, here, so every count, badge
      // and ranking downstream is computed over the same set (model/exclude.ts).
      const model = applyExclusions(built, this.excluded);
      recomputeRootProgress(model);
      this.model = model;
      await this.setState('ready');
      this.installWatchers();
      await this.recordObservations(model);
      this.recomputeDerived(model);
      this.publish();

      // A change created while the window is open has no reconstructed history
      // until something replays its commits. `backfillRoot` skips whatever it
      // has already done at this HEAD, so re-running it for a root that gained a
      // change costs one `rev-parse` and nothing else.
      if (this.noteNewChanges(model) && this.discovered) {
        this.scheduleBackfill();
      }
    } catch (error) {
      log.error('model pass failed', error);
    } finally {
      this.passRunning = false;
      if (this.passQueued) {
        this.passQueued = false;
        void this.refresh();
      }
    }
  }

  private schedulePass(rediscover = false): void {
    this.rediscoverPending = this.rediscoverPending || rediscover;
    if (this.passTimer) {
      clearTimeout(this.passTimer);
    }
    this.passTimer = setTimeout(() => {
      this.passTimer = undefined;
      void this.refresh();
    }, PASS_DEBOUNCE_MS);
  }

  /** True when this pass turned up a change we have not seen before. */
  private noteNewChanges(model: LedgerModel): boolean {
    let added = false;
    for (const root of model.roots) {
      for (const change of root.changes) {
        const key = changeKey(root.root.path, change.id);
        if (!this.seenChanges.has(key)) {
          this.seenChanges.add(key);
          added = true;
        }
      }
    }
    return added;
  }

  private async recordObservations(model: LedgerModel): Promise<void> {
    for (const root of model.roots) {
      for (const change of root.changes) {
        if (!change.undecomposed) {
          await this.store.observe(root.root.path, change);
        }
      }
    }
    await this.store.flush();
  }

  private recomputeDerived(model: LedgerModel): void {
    const today = toDateKey(new Date());
    const stalls: Record<string, Stall | undefined> = {};
    const advanced: Record<string, string | undefined> = {};
    for (const root of model.roots) {
      for (const change of root.changes) {
        const key = changeKey(root.root.path, change.id);
        const history = this.store.history(root.root.path, change.id);
        stalls[key] = stallOf(history, change, today);
        advanced[key] = deriveLastAdvanced(history);
      }
    }
    this.stalls = stalls;
    this.lastAdvanced = advanced;
  }

  /**
   * Push the current model to both surfaces at once.
   *
   * The tree and the overview answer the same question in two shapes, so they
   * are refreshed together; a reader who saw them disagree would have no way to
   * tell which one was stale.
   */
  private publish(): void {
    const options = this.treeOptions();
    this.tree.setModel(this.model, options);
    this.overview.setOverview(
      this.model
        ? buildOverview(this.model, options)
        : {
            rows: [],
            totals: { status: 'active', complete: 0, stale: 0, active: 0, undecomposed: 0 },
            filter: options.filter,
            loading: options.loading,
          },
    );
    this.view.description = options.filter === 'all' ? undefined : filterLabel(options.filter);
    if (this.model) {
      this.updateBadge(this.model);
    } else {
      this.view.badge = undefined;
    }
  }

  /** A click in the overview opens what a click in the tree would open. */
  private async revealFromOverview(selection: { rootPath: string; changeId: string }): Promise<void> {
    const node = this.tree.find(
      (candidate) =>
        candidate.kind === 'change' &&
        candidate.rootPath === selection.rootPath &&
        candidate.changeId === selection.changeId,
    );
    if (!node) {
      return;
    }
    try {
      // Collapse first. `reveal` only ever opens things, so without this every
      // click leaves the previous change open too and the tree grows into the
      // wall of rows this whole view exists to avoid. There is no API to close
      // one element, but a view declared with `showCollapseAll` gets this
      // command, which closes the lot.
      await vscode.commands.executeCommand(
        'workbench.actions.treeView.openspecLedger.ledger.collapseAll',
      );

      // Exactly one thing unfolds: the first section that still has work in it.
      // Everything else stays shut and says what it is through its icon. The
      // reader asked to see one change, not to have a project unpacked over
      // them - and with fifteen sections, "all the unfinished ones" is no better
      // than "all of them".
      await this.view.reveal(node, { select: true, focus: false, expand: true });
      const firstUnfinished = node.children.find(
        (child) => child.kind === 'section' && child.contextValue === 'section-incomplete',
      );
      if (firstUnfinished) {
        await this.view.reveal(firstUnfinished, { select: false, focus: false, expand: true });
        // Selection back on the change, so it stays where the click was.
        await this.view.reveal(node, { select: true, focus: false, expand: false });
      }
    } catch (error) {
      log.warn(`could not reveal ${selection.changeId} in the tree: ${String(error)}`);
    }
    if (node.filePath) {
      await vscode.commands.executeCommand('openspecLedger.openChangeDetail', node);
    }
  }

  private updateBadge(model: LedgerModel): void {
    const ready = countReadyToArchive(model);
    this.view.badge =
      ready > 0
        ? { value: ready, tooltip: `${ready} change${ready === 1 ? '' : 's'} ready to archive` }
        : undefined;
  }

  // -------------------------------------------------------------------------
  // Discovery inputs and settings
  // -------------------------------------------------------------------------

  private discoveryInput(): Parameters<RootCache['get']>[0] {
    const reported = new Set<string>();
    return {
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      additionalRoots: settings().get<string[]>('additionalRoots', []),
      searchWorkspace: createWorkspaceSearcher(),
      onMissingRoot: (missing) => {
        if (!reported.has(missing)) {
          reported.add(missing);
          log.warn(`openspecLedger.additionalRoots: ${missing} does not exist; skipped`);
        }
      },
    };
  }

  private get sortMode(): SortMode {
    const stored = this.context.workspaceState.get<SortMode>(SORT_MODE_KEY);
    if (stored && SORT_MODES.includes(stored)) {
      return stored;
    }
    const configured = settings().get<SortMode>('sortMode', 'name');
    return SORT_MODES.includes(configured) ? configured : 'name';
  }

  /** A value stored by an older build may be a boolean, so it is validated, not trusted. */
  private get filter(): FilterMode {
    const stored = this.context.workspaceState.get<FilterMode>(FILTER_KEY);
    return stored && FILTER_MODES.includes(stored) ? stored : 'all';
  }

  private get staleAfterDays(): number {
    const days = settings().get<number>('staleAfterDays', DEFAULT_STALE_AFTER_DAYS);
    return Number.isFinite(days) && days >= 0 ? days : DEFAULT_STALE_AFTER_DAYS;
  }

  private get excluded(): string[] {
    return settings().get<string[]>('exclude', []);
  }

  private treeOptions(): TreeOptions {
    return {
      sortMode: this.sortMode,
      filter: this.filter,
      staleAfterDays: this.staleAfterDays,
      stalls: this.stalls,
      lastAdvanced: this.lastAdvanced,
      // Until the first discovery has answered, an empty tree means "not yet",
      // not "nothing here", and must not be dressed as the no-roots empty state.
      loading: !this.discovered,
    };
  }

  private async setState(state: 'loading' | 'noWorkspace' | 'noRoots' | 'ready'): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'openspecLedger.state', state);
  }

  // -------------------------------------------------------------------------
  // Watching
  // -------------------------------------------------------------------------

  private installWatchers(): void {
    this.disposeWatchers();
    for (const root of this.roots) {
      for (const pattern of ['changes/**', '*.yaml']) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(root.openspecPath), pattern)
        );
        const onEvent = (): void => this.schedulePass();
        watcher.onDidChange(onEvent);
        watcher.onDidCreate(onEvent);
        watcher.onDidDelete(onEvent);
        this.watchers.push(watcher);
      }
    }
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers.splice(0, this.watchers.length)) {
      watcher.dispose();
    }
  }

  private registerListeners(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedulePass(true)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('openspecLedger.additionalRoots')) {
          this.schedulePass(true);
        } else if (event.affectsConfiguration('openspecLedger')) {
          this.schedulePass();
        }
      })
    );
  }

  // -------------------------------------------------------------------------
  // Background backfill
  // -------------------------------------------------------------------------

  /** Runs after the tree is already populated; a root outside git is skipped. */
  private scheduleBackfill(): void {
    if (this.disposed || !this.model) {
      return;
    }
    this.backfillAbort?.abort();
    const abort = new AbortController();
    this.backfillAbort = abort;
    const model = this.model;

    void (async () => {
      const started = Date.now();
      for (const root of model.roots) {
        if (abort.signal.aborted) {
          return;
        }
        await backfillRoot({
          root: root.root,
          changes: root.changes,
          store: this.store,
          tabWidth: tabWidth(),
          signal: abort.signal,
        });
      }
      if (abort.signal.aborted || this.disposed) {
        return;
      }
      await this.store.flush();
      log.info(`backfill finished in ${Date.now() - started} ms`);
      if (this.model) {
        this.recomputeDerived(this.model);
        this.publish();
      }
    })();
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private registerCommands(): void {
    const register = (id: string, handler: (...args: never[]) => unknown): void => {
      this.disposables.push(
        vscode.commands.registerCommand(id, handler as (...args: unknown[]) => unknown)
      );
    };

    register('openspecLedger.refresh', () => this.refresh({ rediscover: true }));
    register('openspecLedger.setSortMode', () => this.pickSortMode());
    register('openspecLedger.setFilter', () => this.pickFilter());
    register('openspecLedger.clearFilter', () => this.setFilter('all'));
    register('openspecLedger.archiveChange', (node: LedgerNode) => this.archive(node));
    register('openspecLedger.archiveCompleted', () => this.archiveCompleted());
    register('openspecLedger.hideItem', (node: LedgerNode) => this.hide(node));
    register('openspecLedger.manageHidden', () => this.manageHidden());
    register('openspecLedger.handoffTaskToChat', (node: LedgerNode) => this.handoff(node, 'chat'));
    register('openspecLedger.movementReport', () => this.showMovementReport());
    register('openspecLedger.openChangeDetail', (node: LedgerNode) => this.showDetail(node));
    register('openspecLedger.revealChangeFolder', (node: LedgerNode) => this.revealChange(node));
    register('openspecLedger.openChangeFile', (node: LedgerNode) => this.openChangeFile(node));
    register('openspecLedger.handoffTask', (node: LedgerNode) => this.handoff(node, 'terminal'));
    register('openspecLedger.copyTaskPrompt', (node: LedgerNode) => this.handoff(node, 'clipboard'));
    register('openspecLedger.handoffSection', (node: LedgerNode) => this.handoffSection(node));
    register('openspecLedger.openAdditionalRootsSetting', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'openspecLedger.additionalRoots')
    );
    register('openspecLedger.rescanTranscripts', () => this.rescanTranscripts());
    register('openspecLedger.showOutput', () => showOutput());
  }

  private async pickSortMode(): Promise<void> {
    const current = this.sortMode;
    const picked = await vscode.window.showQuickPick(
      SORT_MODES.map((mode) => ({
        label: SORT_LABELS[mode].label,
        detail: SORT_LABELS[mode].detail,
        description: mode === current ? 'current' : undefined,
        mode,
      })),
      { title: 'Sort changes by', placeHolder: SORT_LABELS[current].label }
    );
    if (!picked) {
      return;
    }
    await this.context.workspaceState.update(SORT_MODE_KEY, picked.mode);
    this.tree.setOptions({ sortMode: picked.mode });
  }

  private async setFilter(filter: FilterMode): Promise<void> {
    await this.context.workspaceState.update(FILTER_KEY, filter);
    await vscode.commands.executeCommand('setContext', FILTER_CONTEXT, filter !== 'all');
    this.tree.setOptions({ filter });
    this.publish();
  }

  private async pickFilter(): Promise<void> {
    const current = this.filter;
    const picked = await vscode.window.showQuickPick(
      FILTER_MODES.map((mode) => ({
        label: filterLabel(mode),
        description: mode === current ? 'current' : undefined,
        mode,
      })),
      { title: 'Show which changes', placeHolder: filterLabel(current) }
    );
    if (picked) {
      await this.setFilter(picked.mode);
    }
  }

  private async rescanTranscripts(): Promise<void> {
    if (!settings().get<boolean>('claudeEvidence.enabled', false)) {
      const enable = 'Enable';
      const choice = await vscode.window.showInformationMessage(
        'Claude Code evidence is off, so no transcript is read. Enable it to see which sessions worked on a change.',
        enable
      );
      if (choice === enable) {
        await settings().update('claudeEvidence.enabled', true, vscode.ConfigurationTarget.Global);
      }
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Rescanning Claude Code transcripts' },
      async () => {
        const result = await this.transcripts.scan({ fullRescan: true });
        const message =
          result.unavailable === 'no-data-directory'
            ? 'No Claude Code history was found on this machine.'
            : `Read ${result.scanned} transcript(s); ${result.skipped} skipped as older than 30 days.`;
        void vscode.window.showInformationMessage(message);
      }
    );
  }

  // -------------------------------------------------------------------------
  // Node-scoped commands
  // -------------------------------------------------------------------------

  private locate(node: LedgerNode | undefined): { root: OpenSpecRoot; change: Change } | undefined {
    if (!node?.rootPath || !node.changeId || !this.model) {
      return undefined;
    }
    for (const root of this.model.roots) {
      if (root.root.path !== node.rootPath) {
        continue;
      }
      const change = root.changes.find((candidate) => candidate.id === node.changeId);
      if (change) {
        return { root: root.root, change };
      }
    }
    return undefined;
  }

  /**
   * The change's own document: `proposal.md`, or `design.md` when there is no
   * proposal. A change with neither has nothing to open, so its directory is
   * revealed instead - the same fallback chain the click used to follow.
   */
  private async openChangeFile(node: LedgerNode): Promise<void> {
    const target = node.filePath;
    if (!target) {
      await this.revealChange(node);
      return;
    }
    if (!/\.md$/i.test(target)) {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(target));
      return;
    }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target), {
      preview: true,
    });
  }

  private async revealChange(node: LedgerNode): Promise<void> {
    const found = this.locate(node);
    if (found) {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(found.change.path));
    }
  }

  private async showDetail(node: LedgerNode): Promise<void> {
    const found = this.locate(node);
    if (!found) {
      return;
    }
    const { root, change } = found;
    const history = this.store.history(root.path, change.id);
    const today = toDateKey(new Date());

    // Both evidence layers are read here and nowhere else, which is what keeps
    // ~100 MB of transcripts off the activation path (design.md D9).
    const gitEnabled = settings().get<boolean>('gitEvidence.enabled', false);
    const claudeEnabled = settings().get<boolean>('claudeEvidence.enabled', false);

    const gitEvidence = await evaluateGitEvidence({
      enabled: gitEnabled,
      root,
      change,
      history,
      dismissedKeys: this.store.dismissals(root.path, change.id),
      today,
    });

    if (claudeEnabled) {
      await this.transcripts.scan();
    }
    const claudeEvidence = await evaluateClaudeEvidence({
      enabled: claudeEnabled,
      change,
      history,
      index: this.transcripts,
    });

    ChangeDetailPanel.show(this.context, {
      change,
      rootLabel: root.label,
      snapshots: history?.snapshots ?? [],
      stall: this.stalls[changeKey(root.path, change.id)],
      lastAdvanced: this.lastAdvanced[changeKey(root.path, change.id)],
      gitEvidence,
      claudeEvidence,
      onDismiss: (key: string) => {
        void this.store.dismiss(root.path, change.id, key);
      },
    });
  }

  private taskAt(node: LedgerNode): { root: OpenSpecRoot; change: Change; task: Task } | undefined {
    const found = this.locate(node);
    if (!found || node.line === undefined) {
      return undefined;
    }
    const task = found.change.taskFile?.all.find((candidate) => candidate.line === node.line);
    return task ? { ...found, task } : undefined;
  }

  private async handoff(node: LedgerNode, mode?: HandoffTarget): Promise<void> {
    const found = this.taskAt(node);
    if (!found) {
      return;
    }
    const { root, change, task } = found;
    const prompt = buildTaskPrompt({
      changeId: change.id,
      number: task.number,
      label: task.label,
      tasksPath: displayPath(change.tasksPath ?? ''),
      line: task.line,
      proposalPath: change.documents.proposal
        ? displayPath(path.join(change.path, 'proposal.md'))
        : undefined,
      template: settings().get<string>('handoff.template', ''),
    });
    await this.deliver(prompt, root, mode);
  }

  private async handoffSection(node: LedgerNode): Promise<void> {
    const found = this.locate(node);
    if (!found || node.sectionIndex === undefined) {
      return;
    }
    const { root, change } = found;
    const section = change.taskFile?.sections[node.sectionIndex];
    if (!section) {
      return;
    }
    const incomplete = flattenSectionTasks(section.tasks).filter(
      (task) => task.state !== 'complete' && task.children.length === 0
    );
    if (incomplete.length === 0) {
      return;
    }
    const prompt = buildSectionPrompt({
      changeId: change.id,
      sectionTitle: section.title,
      tasksPath: displayPath(change.tasksPath ?? ''),
      proposalPath: change.documents.proposal
        ? displayPath(path.join(change.path, 'proposal.md'))
        : undefined,
      tasks: incomplete.map((task) => ({ number: task.number, label: task.label, line: task.line })),
    });
    await this.deliver(prompt, root, 'terminal');
  }

  /**
   * Archiving is the CLI's job.
   *
   * `openspec archive` does not merely move a directory: it folds the change's
   * spec deltas into `openspec/specs/`. Reimplementing the move alone would
   * silently skip that and leave the project's specs behind its changes, so the
   * command is written into a terminal for the user to run and read.
   */
  private async archive(node: LedgerNode): Promise<void> {
    const found = this.locate(node);
    if (found) {
      await this.archiveByName(found.root.path, found.change.id);
    }
  }

  /**
   * Every finished change, offered in one go.
   *
   * Grouped by root because `openspec archive` reads the project it stands in,
   * and confirmed first by name: it rewrites `openspec/specs/` in each of them,
   * which is not something to set off from a button without saying what it will
   * touch.
   */
  private async archiveCompleted(): Promise<void> {
    if (!this.model) {
      return;
    }
    const byRoot = new Map<string, { label: string; ids: string[] }>();
    for (const rootModel of this.model.roots) {
      for (const change of rootModel.changes) {
        if (statusOf(change, this.stalls[changeKey(rootModel.root.path, change.id)], this.staleAfterDays) !== 'complete') {
          continue;
        }
        const entry = byRoot.get(rootModel.root.path) ?? { label: rootModel.root.label, ids: [] };
        entry.ids.push(change.id);
        byRoot.set(rootModel.root.path, entry);
      }
    }

    const total = [...byRoot.values()].reduce((sum, entry) => sum + entry.ids.length, 0);
    if (total === 0) {
      void vscode.window.showInformationMessage('No change is at 100 percent, so there is nothing to archive.');
      return;
    }

    const listing = [...byRoot.values()]
      .map((entry) => `${entry.label}: ${entry.ids.join(', ')}`)
      .join('\n');
    const proceed = 'Open the commands';
    const choice = await vscode.window.showWarningMessage(
      `Archive ${total} completed change${total === 1 ? '' : 's'}?`,
      {
        modal: true,
        detail:
          `${listing}\n\nOne terminal per project, with the commands typed in and waiting. ` +
          'Nothing runs until you press Enter. Note that openspec archive also folds each ' +
          'change’s spec deltas into openspec/specs/, so this is not just a move.',
      },
      proceed,
    );
    if (choice !== proceed) {
      return;
    }

    const command = settings().get<string>('archive.command', DEFAULT_ARCHIVE_COMMAND);
    for (const [rootPath, entry] of byRoot) {
      const result = await archiveChanges({ rootPath, changeIds: entry.ids, command });
      if (!result.started) {
        void vscode.window.showWarningMessage(
          result.reason ?? `Could not open a terminal for ${entry.label}.`,
        );
      }
    }
  }

  private async archiveByName(rootPath: string, changeId: string): Promise<void> {
    const result = await archiveChange({
      rootPath,
      changeId,
      command: settings().get<string>('archive.command', DEFAULT_ARCHIVE_COMMAND),
    });
    if (!result.started) {
      void vscode.window.showWarningMessage(
        result.reason ?? `Could not open a terminal to archive ${changeId}.`,
      );
    }
  }

  /** Hide a root or a change from every count, badge and ranking. */
  private async hide(node: LedgerNode): Promise<void> {
    const found = this.locate(node);
    const target = node.kind === 'root' ? node.rootPath : found?.change.path;
    const name = node.kind === 'root' ? node.label : found?.change.id;
    if (!target || !name) {
      return;
    }

    const undo = 'Undo';
    await settings().update(
      'exclude',
      addExclusion(this.excluded, target),
      vscode.ConfigurationTarget.Workspace,
    );
    const choice = await vscode.window.showInformationMessage(`${name} is hidden from the Ledger.`, undo);
    if (choice === undo) {
      await settings().update(
        'exclude',
        removeExclusion(this.excluded, target),
        vscode.ConfigurationTarget.Workspace,
      );
    }
  }

  private async manageHidden(): Promise<void> {
    const hidden = this.excluded;
    if (hidden.length === 0) {
      void vscode.window.showInformationMessage(
        'Nothing is hidden. Use Hide from the Ledger on a root or a change to leave it out of every count.',
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      hidden.map((entry) => ({ label: path.basename(entry), description: entry, entry })),
      { title: 'Hidden items - pick one to show again', canPickMany: true },
    );
    if (!picked || picked.length === 0) {
      return;
    }
    let remaining = hidden;
    for (const item of picked) {
      remaining = removeExclusion(remaining, item.entry);
    }
    await settings().update('exclude', remaining, vscode.ConfigurationTarget.Workspace);
  }

  private async deliver(prompt: string, root: OpenSpecRoot, mode?: HandoffTarget): Promise<void> {
    const configured = mode ?? settings().get<string>('handoff.target', DEFAULT_HANDOFF_TARGET);
    const target = resolveTarget(configured, { chat: await isChatAvailable() });

    if (target === 'chat') {
      const sent = await sendToChat(prompt);
      if (sent.ok) {
        return;
      }
      // Falling through rather than failing: the prompt is built and the user
      // asked for it, so the clipboard is a worse answer than chat but a much
      // better one than nothing.
      log.info(`chat handoff unavailable: ${sent.reason ?? 'no reason given'}`);
    }

    const result = await deliverPrompt(prompt, {
      cwd: root.path,
      command: settings().get<string>('handoff.command', 'claude'),
      preferClipboard: target === 'clipboard' || target === 'chat',
    });
    if (result.mode === 'clipboard') {
      const reason = result.reason ? ` ${result.reason}` : '';
      void vscode.window.showInformationMessage(`Prompt copied to the clipboard.${reason}`);
    }
  }

  // -------------------------------------------------------------------------
  // Checkbox write-back
  // -------------------------------------------------------------------------

  private async onCheckboxChanged(
    event: vscode.TreeCheckboxChangeEvent<LedgerNode>
  ): Promise<void> {
    let failed = false;

    // Every item in the batch is attempted. One task whose line moved must not
    // silently swallow the others the user ticked in the same gesture.
    for (const [node, checked] of event.items) {
      const found = this.taskAt(node);
      const tasksPath = found?.change.tasksPath;
      if (!found || !tasksPath) {
        continue;
      }
      const { change, task } = found;
      // The editor reports the state the user asked for; deriving it from our
      // own copy would invert the wrong way if the model had drifted.
      const next: TaskState =
        checked === vscode.TreeItemCheckboxState.Checked ? 'complete' : 'pending';
      if (next === task.state) {
        continue;
      }
      const outcome = await applyToggle({
        tasksPath,
        line: task.line,
        expectedRaw: task.raw,
        next,
      });

      if (!outcome.ok) {
        failed = true;
        const name = path.basename(tasksPath);
        if (outcome.reason === 'mismatch') {
          void vscode.window.showWarningMessage(
            `${name} changed on disk, so the checkbox was not written. The Ledger has been refreshed.`
          );
        } else if (outcome.reason === 'missing-line' || outcome.reason === 'not-a-task') {
          void vscode.window.showWarningMessage(
            `Line ${task.line} of ${name} is no longer that task, so the checkbox was not written. The Ledger has been refreshed.`
          );
        }
        continue;
      }

      // Reflect the write immediately from the in-memory model. The watcher
      // will run a real pass shortly; this is only so the tree does not lag
      // behind the click (design.md D13: under 100 ms).
      //
      // These objects are the ones the parse cache holds, so the optimistic
      // edit has to be paired with dropping that cache entry. Otherwise a
      // toggle applied to a dirty buffer - where the edit is real but the file
      // on disk has not changed, so its stamp has not changed either - would be
      // believed by every later rebuild, and a snapshot claiming progress that
      // `tasks.md` does not contain would be written to the history.
      task.state = next;
      task.raw = outcome.newRaw;
      recomputeChangeProgress(change);
      this.builder.invalidate(tasksPath);
    }

    if (this.model) {
      // The root badge is an aggregate over its changes, so it has to be
      // recomputed too or it lags a tick behind the change it contains.
      recomputeRootProgress(this.model);
      this.recomputeDerived(this.model);
      this.publish();
    }
    if (failed) {
      await this.refresh();
    }
  }

  // -------------------------------------------------------------------------
  // Movement report
  // -------------------------------------------------------------------------

  private async showMovementReport(): Promise<void> {
    if (!this.model) {
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'Last 7 days', days: 7 },
        { label: 'Last 14 days', days: 14 },
        { label: 'Last 30 days', days: 30 },
        { label: 'Last 90 days', days: 90 },
      ],
      { title: 'Movement report over', placeHolder: 'Last 7 days' }
    );
    const days = picked?.days ?? 7;
    const report = buildMovementReport({
      model: this.model,
      days,
      today: toDateKey(new Date()),
      historyFor: (rootPath, changeId) => this.store.history(rootPath, changeId),
    });
    // Written to a file in the extension's own storage rather than opened as an
    // untitled buffer, so it can be shown through the editor's markdown PREVIEW.
    // A report is something to read, and an untitled buffer hands the reader
    // raw markup and an unsaved-changes dot they never asked for.
    const target = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      'reports',
      `movement-${days}-days.md`,
    );
    const markdown = renderMovementReport(report);

    try {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(this.context.globalStorageUri, 'reports'),
      );
      await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, 'utf8'));
      await vscode.commands.executeCommand('markdown.showPreview', target);
      return;
    } catch (error) {
      // The preview command belongs to a built-in extension, which a stripped
      // build may not have. The report is still worth showing.
      log.warn(`could not open the movement report as a preview: ${String(error)}`);
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: markdown,
    });
    await vscode.window.showTextDocument(document, { preview: false });
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('openspecLedger');
}

function tabWidth(): number {
  const size = vscode.workspace.getConfiguration('editor').get<number>('tabSize', 4);
  return Number.isFinite(size) && size > 0 ? size : 4;
}

function hasSomethingToSearch(): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const additional = settings().get<string[]>('additionalRoots', []);
  return folders.length > 0 || additional.length > 0;
}

/** Workspace-relative where possible, so a handoff prompt reads like a path a human would type. */
function displayPath(absolute: string): string {
  if (!absolute) {
    return '';
  }
  const relative = vscode.workspace.asRelativePath(vscode.Uri.file(absolute), false);
  return relative.replace(/\\/g, '/');
}

function flattenSectionTasks(tasks: readonly Task[]): Task[] {
  const out: Task[] = [];
  const walk = (list: readonly Task[]): void => {
    for (const task of list) {
      out.push(task);
      walk(task.children);
    }
  };
  walk(tasks);
  return out;
}

/** D5: a root's aggregate covers its decomposed changes only. */
function recomputeRootProgress(model: LedgerModel): void {
  for (const root of model.roots) {
    const parts: Progress[] = [];
    for (const change of root.changes) {
      if (!change.undecomposed && change.taskFile) {
        parts.push(change.taskFile.progress);
      }
    }
    root.progress = sumProgress(parts);
  }
}

/** After a toggle, recompute the change's progress without touching the disk. */
function recomputeChangeProgress(change: Change): void {
  const file = change.taskFile;
  if (!file) {
    return;
  }
  const leaves = file.leaves;
  const completed = leaves.filter((task) => task.state === 'complete').length;
  file.progress = makeProgress(completed, leaves.length);
}

let outputChannel: vscode.OutputChannel | undefined;

export function setOutputChannel(channel: vscode.OutputChannel): void {
  outputChannel = channel;
}

function showOutput(): void {
  outputChannel?.show(true);
}
