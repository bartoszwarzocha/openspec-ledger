/**
 * The whole data model of the extension, in one place.
 *
 * Every module below `src/` reads or produces these shapes, so this file is the
 * contract between them. It contains types only - the helpers that operate on
 * them live in `src/model/keys.ts`.
 *
 * Dependency direction (design.md D1): view and handoff depend on model;
 * history and evidence depend on model; model depends on discovery; nothing
 * depends on view.
 */

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * One discovered OpenSpec root.
 *
 * `path` is the directory that *contains* `openspec`, because that is what the
 * git layers and the handoff need as a working directory. `openspecPath` is the
 * `openspec` directory itself.
 */
export interface OpenSpecRoot {
  /** Absolute path of the directory containing the `openspec` directory. */
  path: string;
  /** Absolute path of the `openspec` directory. */
  openspecPath: string;
  /** Label for the tree: path relative to its workspace folder, else the directory name. */
  label: string;
  /** Absolute path of the workspace folder containing this root, when it is inside one. */
  workspaceFolder?: string;
  /** `schema` from `openspec/config.yaml`, when it could be read. */
  schema?: string;
  /** False when the root was accepted through `openspec/changes/` with no `config.yaml`. */
  hasConfig: boolean;
  /** Set when `config.yaml` exists but could not be parsed. The root is kept regardless. */
  configError?: string;
  /** True when the root came from `openspecLedger.additionalRoots`, not from the workspace. */
  fromSettings: boolean;
}

// ---------------------------------------------------------------------------
// Change model
// ---------------------------------------------------------------------------

export type TaskState = 'pending' | 'complete' | 'in-progress';

/** One checkbox line in `tasks.md`. */
export interface Task {
  /** `N.M` or `N.M.K` when the label carried one, stripped from `label`. */
  number?: string;
  /** Task text with the number prefix removed. */
  label: string;
  state: TaskState;
  /** One-based line number in `tasks.md`. */
  line: number;
  /** The verbatim text of that line, used to detect the file changing underneath. */
  raw: string;
  /** Normalised indent column of the list marker, tabs expanded. */
  indent: number;
  children: Task[];
}

/**
 * A run of tasks under one markdown heading. Tasks appearing before the first
 * heading belong to an implicit section with no title and depth 0.
 */
export interface TaskSection {
  /** Heading text without its leading `#`s; undefined for the implicit section. */
  title?: string;
  /** Heading depth 1-6; 0 for the implicit section. */
  depth: number;
  /** One-based line of the heading; 0 for the implicit section. */
  line: number;
  /** Top-level tasks of this section. Nested tasks hang off `Task.children`. */
  tasks: Task[];
}

/** Leaf-task arithmetic. `percent` is 100 only when every leaf task is complete. */
export interface Progress {
  completed: number;
  total: number;
  percent: number;
}

export interface ParsedTaskFile {
  sections: TaskSection[];
  progress: Progress;
  /** Every task in file order, parents included. */
  all: Task[];
  /** Leaf tasks in file order - the ones progress counts. */
  leaves: Task[];
  /** Non-fatal oddities found while reading the file, surfaced on the change. */
  problems?: readonly string[];
}

export interface ChangeDocuments {
  proposal: boolean;
  design: boolean;
  tasks: boolean;
  specs: boolean;
}

/** One change directory under `openspec/changes/`. */
export interface Change {
  /** Directory name, e.g. `add-lookup-provider`. */
  id: string;
  /** Absolute path of the change directory. */
  path: string;
  /** `OpenSpecRoot.path` of the root that owns this change. */
  rootPath: string;
  documents: ChangeDocuments;
  /** `schema` from `.openspec.yaml`. */
  schema?: string;
  /** Declared `created`, or the earliest document mtime when `createdInferred`. */
  created?: Date;
  createdInferred: boolean;
  /** Absolute path of `tasks.md`, when present. */
  tasksPath?: string;
  /**
   * Absent exactly when `tasks.md` does not exist. An existing but empty
   * `tasks.md` yields a parsed file with progress 0 of 0 (design.md D5).
   */
  taskFile?: ParsedTaskFile;
  /** True when `tasks.md` is absent: the change was never decomposed. */
  undecomposed: boolean;
  /** Non-fatal problems; a change is never dropped because of one. */
  problems: string[];
}

export interface RootModel {
  root: OpenSpecRoot;
  changes: Change[];
  /** Aggregate over decomposed changes only (design.md D5). */
  progress: Progress;
  problems: string[];
}

export interface LedgerModel {
  roots: RootModel[];
  builtAt: Date;
}

// ---------------------------------------------------------------------------
// Progress history
// ---------------------------------------------------------------------------

export type SnapshotSource = 'observed' | 'backfilled';

/** At most one per change per calendar day. */
export interface ProgressSnapshot {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  completed: number;
  total: number;
  source: SnapshotSource;
  /** Commit that produced a backfilled snapshot. */
  commit?: string;
}

export interface ChangeHistory {
  changeId: string;
  /** Ascending by date, at most one entry per date. */
  snapshots: ProgressSnapshot[];
  /**
   * Earliest date on which each task line was seen complete, keyed by
   * `taskKey()`. This is what git evidence resolves a completion date from.
   */
  completions: Record<string, string>;
  /** Recorded after a successful backfill so it is not repeated for the same head. */
  backfill?: { at: string; head: string; commits: number };
}

export interface RootHistoryFile {
  version: 1;
  rootPath: string;
  changes: Record<string, ChangeHistory>;
  /** Dismissed no-trace signals: change id -> the task keys dismissed. */
  dismissals?: Record<string, string[]>;
}

/** Movement of one change across a period. */
export interface Movement {
  /** Completed count at the start of the period; undefined when history does not reach back. */
  startCompleted?: number;
  startTotal?: number;
  completedSince: number;
  /** `YYYY-MM-DD` of the last increase in the completed count. */
  lastAdvanced?: string;
  /** The change was created inside the period. */
  newInPeriod: boolean;
}

export interface Stall {
  days: number;
  /** True when measured from the creation date because the change never advanced. */
  fromCreation: boolean;
}

// ---------------------------------------------------------------------------
// Git evidence
// ---------------------------------------------------------------------------

export type EvidenceState =
  /** At least one reference matched a commit in the window. */
  | 'corroborated'
  /** Extraction found nothing to search for - common and not suspicious. */
  | 'no-references'
  /** References existed and none matched. The only state that is surfaced. */
  | 'no-trace'
  /** History does not cover the task, so no window could be computed. */
  | 'unknown-date';

export interface TaskReferences {
  paths: string[];
  symbols: string[];
}

export interface ReferenceMatch {
  reference: string;
  kind: 'path' | 'symbol';
  commit: string;
  date: string;
}

export interface TaskEvidence {
  taskKey: string;
  line: number;
  label: string;
  state: EvidenceState;
  references: TaskReferences;
  /** `YYYY-MM-DD` the task was first seen complete. */
  completedOn?: string;
  /** Start of the search window, `completedOn` minus seven days. */
  windowFrom?: string;
  matches: ReferenceMatch[];
  /** The exact git commands run, so the user can reproduce and disagree. */
  commands: string[];
  /**
   * Why this task's search could not be completed, when that is why the state
   * is `unknown-date`.
   *
   * `unknown-date` covers two different facts that call for different remedies:
   * the history does not reach back to the task, and the search itself did not
   * finish. Telling a user their history is missing when git in fact errored
   * sends them to fix the wrong thing.
   */
  searchIncomplete?: string;
}

export type GitEvidenceUnavailable =
  | 'disabled'
  | 'git-missing'
  | 'not-a-repository'
  | 'planning-only'
  | 'no-history';

export interface ChangeGitEvidence {
  changeId: string;
  available: boolean;
  reason?: GitEvidenceUnavailable;
  /** User-facing sentence explaining `reason`. */
  reasonText?: string;
  /** Every completed task that was evaluated. */
  results: TaskEvidence[];
  /** The `no-trace` subset, minus dismissals. This is what the panel shows. */
  noTrace: TaskEvidence[];
}

// ---------------------------------------------------------------------------
// Claude Code evidence
// ---------------------------------------------------------------------------

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface MessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  /** `fast` reprices Opus 5 / 4.8. */
  speed?: string;
  /** `us` applies a 1.1x multiplier. */
  inference_geo?: string;
  service_tier?: string;
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
    code_execution_requests?: number;
  };
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** What one Claude Code session did, as far as its transcript records it. */
export interface SessionSummary {
  sessionId: string;
  transcriptPath: string;
  cwd?: string;
  firstActivity: Date;
  lastActivity: Date;
  /** Model ids seen, in first-seen order. */
  models: string[];
  /** Model ids that matched no price entry and therefore contributed nothing. */
  unpricedModels: string[];
  tokens: TokenTotals;
  messageCount: number;
  /** Local estimate, never a billed figure. */
  costUsd: number;
  /** Absolute paths written by file-writing tools, excluding anything under `openspec/`. */
  editedFiles: string[];
  /** The change ids this transcript referenced. */
  changeIds: string[];
}

export interface ClaudeRollup {
  sessions: number;
  from: Date;
  to: Date;
  tokens: TokenTotals;
  costUsd: number;
  editedFiles: string[];
  unpricedModels: string[];
}

export interface CheckedWithoutCode {
  taskKey: string;
  label: string;
  line: number;
  /** `YYYY-MM-DD` the task was first seen complete. */
  date: string;
  /** Sessions active on that date whose edits stayed inside `openspec/`. */
  sessionIds: string[];
}

export type ClaudeEvidenceUnavailable =
  | 'disabled'
  | 'no-data-directory'
  | 'no-sessions'
  | 'no-history';

export interface ChangeClaudeEvidence {
  changeId: string;
  available: boolean;
  reason?: ClaudeEvidenceUnavailable;
  reasonText?: string;
  sessions: SessionSummary[];
  /** Undefined when no session is bound: absence of measurement, not a measured zero. */
  rollup?: ClaudeRollup;
  checkedWithoutCode: CheckedWithoutCode[];
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export type SortMode = 'name' | 'progress' | 'nearest-done' | 'stalled' | 'created';

export const SORT_MODES: readonly SortMode[] = [
  'name',
  'progress',
  'nearest-done',
  'stalled',
  'created',
];

export type NodeKind = 'root' | 'change' | 'section' | 'task' | 'message';

/**
 * A tree node as pure data. `view/tree.ts` maps these onto `vscode.TreeItem`
 * one-for-one, which keeps every label, badge and ordering rule unit-testable
 * without an extension host.
 */
export interface LedgerNode {
  kind: NodeKind;
  /** Stable across rebuilds, so expansion state survives a refresh. */
  id: string;
  label: string;
  /** Grey text after the label: progress badges, dates. */
  description?: string;
  /** Markdown tooltip. */
  tooltip?: string;
  /** Codicon id, e.g. `pass-filled`. */
  iconId?: string;
  /** Theme colour id for the icon, e.g. `testing.iconPassed`. */
  iconColor?: string;
  /** Drives menu `when` clauses; see package.json. */
  contextValue?: string;
  collapsible: 'none' | 'collapsed' | 'expanded';
  /** Present only on task nodes. */
  checkbox?: 'checked' | 'unchecked';
  children: LedgerNode[];

  // Payload used by the commands bound to this node.
  rootPath?: string;
  changeId?: string;
  /** Absolute path opened by the node's default click action. */
  filePath?: string;
  /** One-based line to reveal in `filePath`. */
  line?: number;
  /** Index of the section within its change, for section handoff. */
  sectionIndex?: number;
}

/**
 * What the list is narrowed to.
 *
 * A badge saying ten changes are ready to archive is only useful if one click
 * shows those ten, so the filter set is built around the questions the badges
 * raise rather than around what is easy to compute.
 */
export type FilterMode =
  /** Everything discovered. */
  | 'all'
  /** Changes at 100 percent - the ones the badge counts. */
  | 'ready-to-archive'
  /** Changes past the stale threshold. */
  | 'stale'
  /** Changes with work left that have advanced recently enough not to be stale. */
  | 'active'
  /** Changes with no `tasks.md`. */
  | 'undecomposed'
  /** Anything with a task still open. */
  | 'unfinished';

export const FILTER_MODES: readonly FilterMode[] = [
  'all',
  'ready-to-archive',
  'stale',
  'active',
  'undecomposed',
  'unfinished',
];

export interface TreeOptions {
  sortMode: SortMode;
  filter: FilterMode;
  /** Keyed by `changeKey(rootPath, changeId)`. */
  stalls: Record<string, Stall | undefined>;
  /** Keyed by `changeKey(rootPath, changeId)`; `YYYY-MM-DD`. */
  lastAdvanced: Record<string, string | undefined>;
  /** True while discovery is still running, so empty means "not yet". */
  loading?: boolean;
  /**
   * Days without advancing after which a change is called stale and carries a
   * warning. From `openspecLedger.staleAfterDays`; 0 turns the warning off.
   */
  staleAfterDays?: number;
}

/**
 * What a change looks like from across the room.
 *
 * The whole point of the extension is that a reader sees the state of thirty
 * changes without opening any of them, so this is deliberately a small closed
 * set rather than a number to interpret.
 */
export type ChangeStatus =
  /** Every leaf task complete: nothing left but archiving it. */
  | 'complete'
  /** Advancing, or too recent to judge. */
  | 'active'
  /** Has not advanced for longer than the stale threshold. */
  | 'stale'
  /** No `tasks.md`: a proposal nobody broke down. Not a failure. */
  | 'undecomposed';

/** Aggregate of the changes under one root, for the root's own badge. */
export interface RootStatus {
  status: ChangeStatus;
  complete: number;
  stale: number;
  active: number;
  undecomposed: number;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/**
 * One row of the overview panel: everything it shows, already decided.
 *
 * The panel is a webview, so keeping every judgement out here means the layout
 * is the only thing that cannot be unit-tested.
 */
export interface OverviewRow {
  rootPath: string;
  rootLabel: string;
  changeId: string;
  status: ChangeStatus;
  /** Undefined for an undecomposed change, which has no denominator. */
  progress?: Progress;
  /** Days since the change last advanced, when that is known. */
  stall?: Stall;
  /** Right-hand caption: `stalled 83 days`, `ready to archive`, `not decomposed`. */
  note: string;
  /** Absolute path opened when the row is clicked. */
  filePath?: string;
}

export interface Overview {
  rows: OverviewRow[];
  /** The filter these rows were built under, so the header can show it as active. */
  filter: FilterMode;
  /** Counts across every row, for the header. */
  totals: RootStatus;
  /** True while discovery has not answered yet. */
  loading?: boolean;
}

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

export interface TaskPromptInput {
  changeId: string;
  number?: string;
  label: string;
  /** Workspace-relative path of `tasks.md`, POSIX separators. */
  tasksPath: string;
  line: number;
  /** Workspace-relative path of `proposal.md` when the change has one. */
  proposalPath?: string;
  /** Empty or absent means the built-in prompt. */
  template?: string;
}

export interface SectionPromptInput {
  changeId: string;
  sectionTitle?: string;
  tasksPath: string;
  proposalPath?: string;
  /** Incomplete tasks only, in file order. */
  tasks: Array<{ number?: string; label: string; line: number }>;
}

// ---------------------------------------------------------------------------
// Movement report
// ---------------------------------------------------------------------------

export interface ReportRow {
  rootLabel: string;
  rootPath: string;
  changeId: string;
  startCompleted?: number;
  startTotal?: number;
  nowCompleted: number;
  nowTotal: number;
  completedInPeriod: number;
  stall?: Stall;
  newInPeriod: boolean;
  complete: boolean;
}

export interface MovementReport {
  /** `YYYY-MM-DD` inclusive lower bound of the period. */
  since: string;
  generatedFor: string;
  days: number;
  moved: ReportRow[];
  didNotMove: ReportRow[];
  undecomposed: Array<{ rootLabel: string; changeId: string }>;
}
