/**
 * Dated progress snapshots, one JSON file per OpenSpec root.
 *
 * design.md D6: the files live in the extension's global storage, never inside
 * a user repository, and they are a *cache* - the whole record is
 * reconstructible from `git log` (D7), so a corrupt file is thrown away rather
 * than repaired or reported.
 *
 * Writes are debounced because a single watcher burst can rebuild the model
 * several times a second (D13), and every rebuild observes every change.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type { Change, ChangeHistory, ProgressSnapshot, RootHistoryFile } from '../model/types.ts';
import { changeKey, isDateKey, pathKey, taskKey, toDateKey } from '../model/keys.ts';
import { readTextSafe, writeFileAtomic } from '../util/fsx.ts';
import { log } from '../util/log.ts';

/** Long enough for a rebuild storm to settle into one write, short enough that little is lost. */
const WRITE_DEBOUNCE_MS = 750;

const NO_DISMISSALS: readonly string[] = Object.freeze([]);

interface RootState {
  file: RootHistoryFile;
  dirty: boolean;
  timer?: NodeJS.Timeout;
  /** Serialises writes to one file: `writeFileAtomic` renames a temp name that is per-process, not per-call. */
  writing?: Promise<void>;
}

export class HistoryStore {
  /** Directory the JSON files are written to; nothing is written outside it. */
  readonly directory: string;

  private readonly states: Map<string, RootState>;
  private readonly loading: Map<string, Promise<RootHistoryFile>>;
  /**
   * Task keys seen complete at the previous observation of each change, keyed
   * by `changeKey`. Held for this session only, because it records what this
   * process actually watched happen and a fresh process has watched nothing.
   */
  private readonly completeAtLastObservation: Map<string, ReadonlySet<string>>;
  private disposed: boolean;

  constructor(directory: string) {
    this.directory = directory;
    this.states = new Map();
    this.loading = new Map();
    this.completeAtLastObservation = new Map();
    this.disposed = false;
  }

  /** `sha1` of the comparison form of the path: one stable file name per root, on any platform. */
  fileNameFor(rootPath: string): string {
    return `${createHash('sha1').update(pathKey(rootPath)).digest('hex')}.json`;
  }

  pathFor(rootPath: string): string {
    return path.join(this.directory, this.fileNameFor(rootPath));
  }

  /**
   * Read a root's history, once. Anything that is not a history file - missing,
   * unreadable, not JSON, or JSON of the wrong shape - yields an empty one.
   */
  async load(rootPath: string): Promise<RootHistoryFile> {
    const key = pathKey(rootPath);
    const state = this.states.get(key);
    if (state) {
      return state.file;
    }
    const inFlight = this.loading.get(key);
    if (inFlight) {
      return inFlight;
    }
    const pending = this.read(rootPath).then((file) => {
      this.loading.delete(key);
      // A concurrent caller may have installed the state while this read was in flight.
      const existing = this.states.get(key);
      if (existing) {
        return existing.file;
      }
      this.states.set(key, { file, dirty: false });
      return file;
    });
    this.loading.set(key, pending);
    return pending;
  }

  /**
   * Record today's progress for a change. A second observation on the same day
   * replaces the first, and only a tick this session watched happen dates a
   * completion.
   */
  async observe(rootPath: string, change: Change): Promise<void> {
    const file = await this.load(rootPath);
    const taskFile = change.taskFile;
    if (!taskFile) {
      // An undecomposed change has no progress to record; zero would read as work not started (D5).
      return;
    }

    const today = toDateKey(new Date());
    const history = ensureChange(file, change.id);
    let changed = upsertSnapshot(history, {
      date: today,
      completed: taskFile.progress.completed,
      total: taskFile.progress.total,
      source: 'observed',
    });

    // Today is a completion date only for a tick this session watched happen.
    // A task already complete the first time we look was ticked on some earlier
    // day the store has no evidence of, and stamping it with today would move
    // the git evidence window off the days the work was actually committed
    // (git-evidence, "Completion date resolution"); backfill dates those from
    // git when it can.
    const observationKey = changeKey(pathKey(rootPath), change.id);
    const previouslyComplete = this.completeAtLastObservation.get(observationKey);
    const nowComplete = new Set<string>();
    for (const task of taskFile.all) {
      if (task.state !== 'complete') {
        continue;
      }
      const key = taskKey(task.raw);
      nowComplete.add(key);
      const witnessed = previouslyComplete !== undefined && !previouslyComplete.has(key);
      if (witnessed && recordCompletion(history, key, today)) {
        changed = true;
      }
    }
    this.completeAtLastObservation.set(observationKey, nowComplete);

    if (changed) {
      this.markDirty(rootPath);
    }
  }

  /**
   * Merge a git reconstruction into a change's history.
   *
   * Backfill never overwrites an observed snapshot: the reconstruction is a
   * best effort from commit dates, while an observation is what the editor
   * actually saw that day.
   */
  async recordBackfill(
    rootPath: string,
    changeId: string,
    snapshots: readonly ProgressSnapshot[],
    completions: Record<string, string>,
    meta: { head: string; commits: number },
  ): Promise<void> {
    const file = await this.load(rootPath);
    const history = ensureChange(file, changeId);

    for (const snapshot of snapshots) {
      upsertSnapshot(history, snapshot);
    }
    for (const [key, date] of Object.entries(completions)) {
      recordCompletion(history, key, date);
    }
    history.backfill = { at: toDateKey(new Date()), head: meta.head, commits: meta.commits };

    this.markDirty(rootPath);
  }

  /** The cached history, or undefined when the root has not been loaded or the change has none. */
  history(rootPath: string, changeId: string): ChangeHistory | undefined {
    return this.states.get(pathKey(rootPath))?.file.changes[changeId];
  }

  /** Silence one no-trace signal. A dismissal is the user's judgement and outlives a rebuild (D8). */
  async dismiss(rootPath: string, changeId: string, key: string): Promise<void> {
    const file = await this.load(rootPath);
    const dismissals = (file.dismissals ??= {});
    const current = dismissals[changeId];
    if (!current) {
      dismissals[changeId] = [key];
    } else if (current.includes(key)) {
      return;
    } else {
      current.push(key);
    }
    this.markDirty(rootPath);
  }

  dismissals(rootPath: string, changeId: string): readonly string[] {
    return this.states.get(pathKey(rootPath))?.file.dismissals?.[changeId] ?? NO_DISMISSALS;
  }

  /** Write every pending change now and wait for it to land. */
  async flush(): Promise<void> {
    const pending: Array<Promise<void>> = [];
    for (const key of [...this.states.keys()]) {
      pending.push(this.write(key));
    }
    await Promise.all(pending);
  }

  /**
   * Stop the timers. A caller that cares about the last observation should
   * `await flush()` first; the write started here is best effort, because
   * deactivation does not wait.
   */
  dispose(): void {
    this.disposed = true;
    for (const state of this.states.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
    }
    void this.flush();
  }

  private async read(rootPath: string): Promise<RootHistoryFile> {
    const text = await readTextSafe(this.pathFor(rootPath));
    if (text === undefined) {
      return emptyFile(rootPath);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // D6: the record is reconstructible, so a damaged cache is discarded in
      // silence and backfill rebuilds it. The user is never asked about it.
      log.warn(`history file for ${rootPath} was not readable JSON; starting a fresh one`);
      return emptyFile(rootPath);
    }
    const file = sanitizeFile(parsed, rootPath);
    if (!file) {
      log.warn(`history file for ${rootPath} was not in the expected shape; starting a fresh one`);
      return emptyFile(rootPath);
    }
    return file;
  }

  private markDirty(rootPath: string): void {
    const key = pathKey(rootPath);
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    state.dirty = true;
    if (this.disposed || state.timer) {
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.write(key);
    }, WRITE_DEBOUNCE_MS);
    // A pending history write must never be the reason a process stays alive.
    state.timer.unref?.();
  }

  private async write(key: string): Promise<void> {
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (!state.dirty) {
      await state.writing;
      return;
    }
    state.dirty = false;

    const target = this.pathFor(state.file.rootPath);
    // Compact: this is a cache read by machines, and it grows with every day of every change.
    const contents = JSON.stringify(state.file);
    const previous = state.writing ?? Promise.resolve();
    const writing = previous.then(async () => {
      try {
        await writeFileAtomic(target, contents);
      } catch (error) {
        // Losing a write costs one backfill, so it is logged rather than surfaced.
        log.error(`could not write the history file for ${state.file.rootPath}`, error);
      }
    });
    state.writing = writing;
    await writing;
  }
}

// ---------------------------------------------------------------------------
// Pure record maintenance
// ---------------------------------------------------------------------------

function emptyFile(rootPath: string): RootHistoryFile {
  return { version: 1, rootPath, changes: {} };
}

function ensureChange(file: RootHistoryFile, changeId: string): ChangeHistory {
  const existing = file.changes[changeId];
  if (existing) {
    return existing;
  }
  const created: ChangeHistory = { changeId, snapshots: [], completions: {} };
  file.changes[changeId] = created;
  return created;
}

/** True when the record changed, so an unchanged rebuild does not cost a write. */
function upsertSnapshot(history: ChangeHistory, snapshot: ProgressSnapshot): boolean {
  const index = history.snapshots.findIndex((entry) => entry.date === snapshot.date);
  if (index < 0) {
    history.snapshots.push(snapshot);
    history.snapshots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return true;
  }
  const existing = history.snapshots[index];
  if (!existing) {
    return false;
  }
  if (snapshot.source === 'backfilled' && existing.source === 'observed') {
    return false;
  }
  if (
    existing.completed === snapshot.completed &&
    existing.total === snapshot.total &&
    existing.source === snapshot.source &&
    existing.commit === snapshot.commit
  ) {
    return false;
  }
  history.snapshots[index] = snapshot;
  return true;
}

/** The earliest date a task was seen complete is what git evidence dates its window from (D8). */
function recordCompletion(history: ChangeHistory, key: string, date: string): boolean {
  if (key.length === 0 || !isDateKey(date)) {
    return false;
  }
  const existing = history.completions[key];
  if (existing !== undefined && existing <= date) {
    return false;
  }
  history.completions[key] = date;
  return true;
}

// ---------------------------------------------------------------------------
// Reading back what a previous session wrote
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function sanitizeFile(value: unknown, rootPath: string): RootHistoryFile | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.changes)) {
    return undefined;
  }
  const file = emptyFile(rootPath);
  for (const [changeId, raw] of Object.entries(value.changes)) {
    const history = sanitizeChange(raw, changeId);
    if (history) {
      file.changes[changeId] = history;
    }
  }
  if (isRecord(value.dismissals)) {
    const dismissals: Record<string, string[]> = {};
    for (const [changeId, raw] of Object.entries(value.dismissals)) {
      if (Array.isArray(raw)) {
        const keys = raw.filter((entry): entry is string => typeof entry === 'string');
        if (keys.length > 0) {
          dismissals[changeId] = keys;
        }
      }
    }
    if (Object.keys(dismissals).length > 0) {
      file.dismissals = dismissals;
    }
  }
  return file;
}

function sanitizeChange(value: unknown, changeId: string): ChangeHistory | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const history: ChangeHistory = { changeId, snapshots: [], completions: {} };

  if (Array.isArray(value.snapshots)) {
    for (const raw of value.snapshots) {
      const snapshot = sanitizeSnapshot(raw);
      if (snapshot) {
        upsertSnapshot(history, snapshot);
      }
    }
  }
  if (isRecord(value.completions)) {
    for (const [key, date] of Object.entries(value.completions)) {
      if (typeof date === 'string') {
        recordCompletion(history, key, date);
      }
    }
  }
  const backfill = value.backfill;
  if (
    isRecord(backfill) &&
    typeof backfill.at === 'string' &&
    typeof backfill.head === 'string' &&
    isCount(backfill.commits)
  ) {
    history.backfill = { at: backfill.at, head: backfill.head, commits: backfill.commits };
  }
  return history;
}

function sanitizeSnapshot(value: unknown): ProgressSnapshot | undefined {
  if (
    !isRecord(value) ||
    !isDateKey(value.date) ||
    !isCount(value.completed) ||
    !isCount(value.total)
  ) {
    return undefined;
  }
  const source = value.source === 'observed' || value.source === 'backfilled' ? value.source : undefined;
  if (!source) {
    return undefined;
  }
  const snapshot: ProgressSnapshot = {
    date: value.date,
    completed: value.completed,
    total: value.total,
    source,
  };
  if (typeof value.commit === 'string') {
    snapshot.commit = value.commit;
  }
  return snapshot;
}
