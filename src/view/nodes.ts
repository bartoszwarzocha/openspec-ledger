/**
 * The Ledger tree as pure data.
 *
 * Every label, badge, icon, ordering and filter rule lives here rather than in
 * `view/tree.ts`, so the whole surface is unit-testable outside an extension
 * host (design.md D3). `tree.ts` maps a `LedgerNode` onto a `vscode.TreeItem`
 * field for field and decides nothing of its own.
 */

import * as path from 'node:path';

import type {
  Change,
  ChangeStatus,
  FilterMode,
  LedgerModel,
  LedgerNode,
  NodeKind,
  OpenSpecRoot,
  RootModel,
  RootStatus,
  SortMode,
  Stall,
  Task,
  TaskSection,
  TaskState,
  TreeOptions,
} from '../model/types.ts';
import { changeKey, leafTasks, normalizePath, taskKey, toDateKey } from '../model/keys.ts';
import { rootStatusOf, statusOf } from '../model/status.ts';

/** design.md D5: an absent task list is a state of its own, never 0 percent. */
const NOT_DECOMPOSED = 'not decomposed';

interface Icon {
  iconId: string;
  /** Left off entirely for the default foreground; an absent key is not an unset colour. */
  iconColor?: string;
}

const TASK_ICONS: Record<TaskState, Icon> = {
  complete: { iconId: 'pass-filled', iconColor: 'testing.iconPassed' },
  // A filled disc reads as distinct from a tick at a glance, which is the whole
  // job of the in-progress marker.
  'in-progress': { iconId: 'circle-filled', iconColor: 'testing.iconQueued' },
  pending: { iconId: 'circle-outline' },
};

/**
 * The same four icons on a change and on its root.
 *
 * A reader who has learned that the yellow triangle means "this has stopped
 * moving" must not have to learn it twice, so the root's aggregate is painted
 * from this table too rather than getting a vocabulary of its own. Only the two
 * states that call for a decision are coloured; colouring all four would leave
 * the eye nothing to land on.
 */
const STATUS_ICONS: Record<ChangeStatus, Icon> = {
  complete: { iconId: 'pass-filled', iconColor: 'testing.iconPassed' },
  stale: { iconId: 'warning', iconColor: 'list.warningForeground' },
  active: { iconId: 'checklist' },
  // A proposal that was never broken down is an idea, not a failure.
  undecomposed: { iconId: 'lightbulb' },
};

/**
 * Menu visibility, which is a coarser question than the icon.
 *
 * A stale change is an ordinary change to every command in the menus; the
 * warning it carries is a signal to review, not a different kind of thing, and
 * a fourth context value would silently hide the menus package.json binds to
 * `change`.
 */
/** A section is finished or it is not; it has no stall figure of its own. */
const SECTION_DONE_ICON: Icon = { iconId: 'pass-filled', iconColor: 'testing.iconPassed' };
const SECTION_OPEN_ICON: Icon = { iconId: 'list-unordered' };

const CHANGE_CONTEXT: Record<ChangeStatus, string> = {
  complete: 'change-complete',
  undecomposed: 'change-undecomposed',
  stale: 'change',
  active: 'change',
};

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * A node id that survives a rebuild, so the tree keeps its expansion state.
 *
 * Tasks are keyed by `taskKey()` rather than by line number: ticking a box or
 * inserting a line above must not collapse the subtree the user was reading.
 */
export function nodeIdFor(
  kind: NodeKind,
  rootPath: string,
  changeId?: string,
  extra?: string | number,
): string {
  const parts = [kind, normalizePath(rootPath)];
  if (changeId !== undefined) {
    parts.push(changeId);
  }
  if (extra !== undefined) {
    parts.push(String(extra));
  }
  return parts.join('::');
}

/**
 * Two tasks in one section can carry the same text. VS Code rejects a duplicate
 * id outright, so collisions are numbered in encounter order, which is as stable
 * as the order of the file itself.
 */
function uniqueId(base: string, seen: Set<string>): string {
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  let n = 2;
  while (seen.has(`${base}~${n}`)) {
    n += 1;
  }
  const id = `${base}~${n}`;
  seen.add(id);
  return id;
}

// ---------------------------------------------------------------------------
// Badges and tooltips
// ---------------------------------------------------------------------------

/** `61/63  97%`, or `not decomposed` when the change has no task list. */
export function changeDescription(change: Change): string {
  // `taskFile` is absent exactly when `tasks.md` does not exist, so the guard and
  // the flag state the same fact two ways.
  if (change.undecomposed || !change.taskFile) {
    return NOT_DECOMPOSED;
  }
  const { completed, total, percent } = change.taskFile.progress;
  return `${completed}/${total}  ${percent}%`;
}

function documentList(change: Change): string[] {
  const present: string[] = [];
  if (change.documents.proposal) {
    present.push('proposal.md');
  }
  if (change.documents.design) {
    present.push('design.md');
  }
  if (change.documents.tasks) {
    present.push('tasks.md');
  }
  if (change.documents.specs) {
    present.push('specs/');
  }
  return present;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Markdown, which `tree.ts` wraps in a `vscode.MarkdownString`. */
export function changeTooltip(
  change: Change,
  stall: Stall | undefined,
  lastAdvanced: string | undefined,
): string {
  const blocks: string[] = [`\`${change.id}\``];

  if (change.undecomposed || !change.taskFile) {
    blocks.push('No `tasks.md`, so this change has not been decomposed into tasks yet.');
  } else {
    const { completed, total, percent } = change.taskFile.progress;
    blocks.push(
      total === 0
        ? '`tasks.md` holds no task lines yet.'
        : `${completed} of ${total} tasks complete (${percent}%)`,
    );
  }

  const facts: string[] = [];
  if (change.created) {
    const inferred = change.createdInferred ? ' (inferred from file dates)' : '';
    facts.push(`Created ${toDateKey(change.created)}${inferred}`);
  }
  if (lastAdvanced) {
    facts.push(`Last advanced ${lastAdvanced}`);
  }
  if (stall) {
    const measured = stall.fromCreation ? ', measured from creation' : '';
    facts.push(`Stalled ${plural(stall.days, 'day')}${measured}`);
  }
  const documents = documentList(change);
  if (documents.length > 0) {
    facts.push(`Documents: ${documents.join(', ')}`);
  }
  if (change.schema) {
    facts.push(`Schema ${change.schema}`);
  }
  if (facts.length > 0) {
    // Two trailing spaces are a markdown hard break, so the facts stay one group.
    blocks.push(facts.join('  \n'));
  }

  if (change.problems.length > 0) {
    blocks.push(
      ['Noted while reading this change:', ...change.problems.map((p) => `- ${p}`)].join('\n'),
    );
  }

  return blocks.join('\n\n');
}

/**
 * The counts spelled out, because the badge beside the label is the first thing
 * a narrow sidebar truncates and the tooltip is where the full story lives.
 */
function statusSummary(counts: RootStatus): string {
  const parts: string[] = [];
  if (counts.complete > 0) {
    parts.push(`${counts.complete} complete`);
  }
  if (counts.stale > 0) {
    parts.push(`${counts.stale} not advancing`);
  }
  if (counts.active > 0) {
    parts.push(`${counts.active} in progress`);
  }
  if (counts.undecomposed > 0) {
    parts.push(`${counts.undecomposed} not decomposed`);
  }
  return parts.join(', ');
}

function rootTooltip(root: OpenSpecRoot, problems: readonly string[], counts: RootStatus): string {
  const facts = [`\`${root.path}\``];
  const summary = statusSummary(counts);
  if (summary) {
    facts.push(summary);
  }
  if (root.schema) {
    facts.push(`Schema ${root.schema}`);
  }
  if (!root.hasConfig) {
    facts.push('Accepted through `openspec/changes/`; no `config.yaml` was found.');
  }
  if (root.configError) {
    facts.push(`\`config.yaml\` could not be read: ${root.configError}`);
  }
  if (root.fromSettings) {
    facts.push('Added through `openspecLedger.additionalRoots`.');
  }
  const blocks = [`**${root.label}**`, facts.join('  \n')];
  if (problems.length > 0) {
    blocks.push(['Noted while reading this root:', ...problems.map((p) => `- ${p}`)].join('\n'));
  }
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/** Ordering within one root. Ties break by id, so a rebuild never shuffles the tree. */
export function sortChanges(
  changes: readonly Change[],
  options: { sortMode: SortMode; stalls: TreeOptions['stalls']; rootPath: string },
): Change[] {
  const percentOf = (change: Change): number => change.taskFile?.progress.percent ?? 0;
  const remainingOf = (change: Change): number => {
    const progress = change.taskFile?.progress;
    // An undecomposed change has no remaining count; it is already ordered last.
    return progress ? progress.total - progress.completed : Number.MAX_SAFE_INTEGER;
  };
  // -1 for "no figure" rather than -Infinity: subtracting two infinities yields
  // NaN, which makes the comparator inconsistent.
  const stallOf = (change: Change): number =>
    options.stalls[changeKey(options.rootPath, change.id)]?.days ?? -1;
  const createdOf = (change: Change): number => change.created?.getTime() ?? -1;

  const byMode: Record<SortMode, (a: Change, b: Change) => number> = {
    name: () => 0,
    progress: (a, b) => percentOf(b) - percentOf(a),
    'nearest-done': (a, b) => remainingOf(a) - remainingOf(b),
    stalled: (a, b) => stallOf(b) - stallOf(a),
    created: (a, b) => createdOf(b) - createdOf(a),
  };
  const compare = byMode[options.sortMode];

  return [...changes].sort((a, b) => {
    // Every ranking but the alphabetical one is about progress, and an
    // undecomposed change has none to rank (design.md D5).
    if (options.sortMode !== 'name') {
      const byDecomposition = Number(a.undecomposed) - Number(b.undecomposed);
      if (byDecomposition !== 0) {
        return byDecomposition;
      }
    }
    const primary = compare(a, b);
    return primary !== 0 ? primary : a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------
// Status and filters
//
// Nothing here decides what state a change is in: `model/status.ts` does, and
// both surfaces read it, because a reader who sees a green tick in the tree and
// a warning in the overview stops trusting both.
// ---------------------------------------------------------------------------

/** The parts of `TreeOptions` a status depends on; the rest cannot change it. */
type StatusOptions = Pick<TreeOptions, 'stalls' | 'staleAfterDays'>;

function statusFor(change: Change, options: StatusOptions): ChangeStatus {
  const stall = options.stalls[changeKey(change.rootPath, change.id)];
  return statusOf(change, stall, options.staleAfterDays);
}

function countStatuses(model: LedgerModel, options: StatusOptions): RootStatus {
  const statuses: ChangeStatus[] = [];
  for (const rootModel of model.roots) {
    for (const change of rootModel.changes) {
      statuses.push(statusFor(change, options));
    }
  }
  return rootStatusOf(statuses);
}

/** Every status across every root, for the view title and the overview header. */
export function countByStatus(model: LedgerModel, options: TreeOptions): RootStatus {
  return countStatuses(model, options);
}

/** How many changes across every root are at 100 percent - the view title badge. */
export function countReadyToArchive(model: LedgerModel): number {
  // Completion outranks staleness in `statusOf`, so no stall figure can move a
  // change in or out of this count and the caller need not supply one.
  return countStatuses(model, { stalls: {} }).complete;
}

/** How the filter names itself in the view title and the menu. */
const FILTER_LABELS: Record<FilterMode, string> = {
  all: 'All changes',
  'ready-to-archive': 'Ready to archive',
  stale: 'Stale',
  active: 'In progress',
  undecomposed: 'Not decomposed',
  unfinished: 'Unfinished',
};

/** The noun a root's badge counts in, e.g. `3 of 11 stale`. */
const FILTER_NOUNS: Record<FilterMode, string> = {
  all: 'shown',
  'ready-to-archive': 'ready',
  stale: 'stale',
  active: 'in progress',
  undecomposed: 'not decomposed',
  unfinished: 'unfinished',
};

/**
 * A filter that empties a root has to say which one did it, otherwise the
 * absence reads as a bug in the extension rather than as an answer.
 */
const NOTHING_MATCHED: Record<FilterMode, string> = {
  all: 'No change here is visible.',
  'ready-to-archive': 'No change here is ready to archive.',
  active: 'No change here is in progress.',
  stale: 'No change here is stale.',
  undecomposed: 'No change here is undecomposed.',
  unfinished: 'No change here is unfinished.',
};

export function filterLabel(filter: FilterMode): string {
  return FILTER_LABELS[filter];
}

/**
 * True when the change still has work in it.
 *
 * Read from the leaf tasks rather than from the percentage so the question is
 * the literal one - is any box still unticked - which also leaves an
 * undecomposed change and an empty `tasks.md` out of it: neither has an open
 * task, and neither belongs in a list of work to pick up.
 */
function hasOpenTask(change: Change): boolean {
  if (change.undecomposed || !change.taskFile) {
    return false;
  }
  return change.taskFile.leaves.some((task) => task.state !== 'complete');
}

const FILTER_PREDICATES: Record<FilterMode, (change: Change, status: ChangeStatus) => boolean> = {
  all: () => true,
  'ready-to-archive': (_change, status) => status === 'complete',
  stale: (_change, status) => status === 'stale',
  active: (_change, status) => status === 'active',
  undecomposed: (_change, status) => status === 'undecomposed',
  unfinished: (change) => hasOpenTask(change),
};

/**
 * The changes one filter keeps, in input order.
 *
 * An unrecognised mode shows everything rather than throwing. `buildTree` runs
 * on every refresh, so an exception here would not narrow the list - it would
 * empty the whole view, and a stored value from an older build is exactly the
 * kind of thing that would cause it.
 */
export function filterChanges(changes: readonly Change[], options: TreeOptions): Change[] {
  const matches = FILTER_PREDICATES[options.filter] ?? FILTER_PREDICATES.all;
  return changes.filter((change) => matches(change, statusFor(change, options)));
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

interface BuildContext {
  options: TreeOptions;
  ids: Set<string>;
}

function messageNode(id: string, label: string, tooltip?: string): LedgerNode {
  const node: LedgerNode = {
    kind: 'message',
    id,
    label,
    iconId: 'info',
    contextValue: 'message',
    collapsible: 'none',
    children: [],
  };
  if (tooltip) {
    node.tooltip = tooltip;
  }
  return node;
}

function taskNode(
  task: Task,
  change: Change,
  sectionIndex: number,
  context: BuildContext,
): LedgerNode {
  // The number was stripped from the label at parse time (design.md D4); it goes
  // back in front so the node reads the way the file does.
  const label =
    [task.number, task.label]
      .filter((part) => !!part)
      .join(' ')
      .trim() || task.raw.trim();
  const contextValue =
    task.state === 'complete'
      ? 'task-complete'
      : task.state === 'in-progress'
        ? 'task-inprogress'
        : 'task-pending';

  const node: LedgerNode = {
    kind: 'task',
    id: uniqueId(
      nodeIdFor('task', change.rootPath, change.id, `${sectionIndex}:${taskKey(task.raw)}`),
      context.ids,
    ),
    label,
    ...TASK_ICONS[task.state],
    contextValue,
    // Collapsed like its section: a nested list that opens itself defeats the
    // point of nesting it.
    collapsible: task.children.length > 0 ? 'collapsed' : 'none',
    checkbox: task.state === 'complete' ? 'checked' : 'unchecked',
    children: task.children.map((child) => taskNode(child, change, sectionIndex, context)),
    rootPath: change.rootPath,
    changeId: change.id,
    line: task.line,
  };
  if (change.tasksPath) {
    node.filePath = change.tasksPath;
  }
  return node;
}

function sectionNode(
  section: TaskSection,
  index: number,
  change: Change,
  context: BuildContext,
): LedgerNode {
  const leaves = leafTasks(section.tasks);
  const completed = leaves.filter((task) => task.state === 'complete').length;

  const done = leaves.length > 0 && completed === leaves.length;
  const remaining = leaves.length - completed;

  const node: LedgerNode = {
    kind: 'section',
    id: uniqueId(nodeIdFor('section', change.rootPath, change.id, index), context.ids),
    label: section.title ?? 'Tasks',
    description: done ? `${completed}/${leaves.length}` : `${completed}/${leaves.length}  ${remaining} left`,
    // A finished section says so in the icon column, so a change of fifteen
    // sections can be read without opening one of them. The unfinished icon is
    // deliberately quiet - the section is not a problem, it is just where the
    // remaining work is.
    ...(done ? SECTION_DONE_ICON : SECTION_OPEN_ICON),
    contextValue: done ? 'section' : 'section-incomplete',
    // Collapsed, always. Opening a change used to unfold every section and every
    // nested task at once, which on a 145-task change buries the thing the
    // reader clicked for.
    collapsible: 'collapsed',
    children: section.tasks.map((task) => taskNode(task, change, index, context)),
    rootPath: change.rootPath,
    changeId: change.id,
    sectionIndex: index,
  };
  if (change.tasksPath) {
    node.filePath = change.tasksPath;
  }
  // The implicit section has no heading line to reveal.
  if (section.line > 0) {
    node.line = section.line;
  }
  return node;
}

/**
 * What a click on a change opens: the proposal, else the design, else the change
 * directory itself - which `tree.ts` reveals rather than opens, recognising the
 * case because the path equals `change.path`.
 */
function changeTarget(change: Change): string {
  if (change.documents.proposal) {
    return path.join(change.path, 'proposal.md');
  }
  if (change.documents.design) {
    return path.join(change.path, 'design.md');
  }
  return change.path;
}

function changeNode(change: Change, context: BuildContext): LedgerNode {
  const sections: LedgerNode[] = [];
  change.taskFile?.sections.forEach((section, index) => {
    // A heading with no tasks under it is prose, not a level of the tree.
    if (section.tasks.length > 0) {
      sections.push(sectionNode(section, index, change, context));
    }
  });

  const status = statusFor(change, context.options);

  const children =
    !change.undecomposed && sections.length === 0
      ? [
          messageNode(
            nodeIdFor('message', change.rootPath, change.id, 'no-tasks'),
            'tasks.md holds no task lines yet.',
          ),
        ]
      : sections;

  const key = changeKey(change.rootPath, change.id);
  return {
    kind: 'change',
    id: uniqueId(nodeIdFor('change', change.rootPath, change.id), context.ids),
    label: change.id,
    description: changeDescription(change),
    tooltip: changeTooltip(change, context.options.stalls[key], context.options.lastAdvanced[key]),
    ...STATUS_ICONS[status],
    contextValue: CHANGE_CONTEXT[status],
    collapsible: children.length > 0 ? 'collapsed' : 'none',
    children,
    rootPath: change.rootPath,
    changeId: change.id,
    filePath: changeTarget(change),
  };
}

/**
 * What is under a root, without expanding it.
 *
 * The reader's first question is whether this root wants them at all, so the
 * two counts that answer it come before the percentage, and a zero is dropped
 * rather than printed: "0 stale" costs a glance to establish nothing, and the
 * line has to survive a narrow sidebar. While a filter is on, the badge counts
 * what the filter kept instead - that is the number the reader is looking at.
 */
function rootDescription(
  rootModel: RootModel,
  counts: RootStatus,
  options: TreeOptions,
  visible: number,
): string {
  if (options.filter !== 'all') {
    return `${visible} of ${rootModel.changes.length} ${FILTER_NOUNS[options.filter]}`;
  }
  const parts = [plural(rootModel.changes.length, 'change')];
  if (counts.complete > 0) {
    parts.push(`${counts.complete} done`);
  }
  if (counts.stale > 0) {
    parts.push(`${counts.stale} stale`);
  }
  if (rootModel.progress.total > 0) {
    parts.push(`${rootModel.progress.percent}%`);
  }
  return parts.join(' · ');
}

/** The change level of one root, including the message that stands in for an empty list. */
function changeNodes(rootModel: RootModel, context: BuildContext): LedgerNode[] {
  const visible = filterChanges(rootModel.changes, context.options);
  const sorted = sortChanges(visible, {
    sortMode: context.options.sortMode,
    stalls: context.options.stalls,
    rootPath: rootModel.root.path,
  });

  if (sorted.length === 0) {
    return [
      rootModel.changes.length === 0
        ? messageNode(
            nodeIdFor('message', rootModel.root.path, undefined, 'no-changes'),
            'This root holds no active changes.',
          )
        : messageNode(
            nodeIdFor('message', rootModel.root.path, undefined, 'none-matched'),
            NOTHING_MATCHED[context.options.filter],
            `Switch the filter to ${FILTER_LABELS.all} to see the other changes in this root.`,
          ),
    ];
  }
  return sorted.map((change) => changeNode(change, context));
}

function rootNode(rootModel: RootModel, context: BuildContext): LedgerNode {
  const children = changeNodes(rootModel, context);
  const visible = children.filter((child) => child.kind === 'change').length;
  // Over every change in the root, not the visible ones: a filter is a lens on
  // the list, and it does not change what is actually sitting under the root.
  const counts = rootStatusOf(
    rootModel.changes.map((change) => statusFor(change, context.options)),
  );
  return {
    kind: 'root',
    id: uniqueId(nodeIdFor('root', rootModel.root.path), context.ids),
    label: rootModel.root.label,
    description: rootDescription(rootModel, counts, context.options, visible),
    tooltip: rootTooltip(rootModel.root, rootModel.problems, counts),
    // The point of the extension is that the state is visible before anything is
    // expanded, and a folder icon on fourteen roots says nothing at all.
    ...STATUS_ICONS[counts.status],
    contextValue: 'root',
    collapsible: 'collapsed',
    children,
    rootPath: rootModel.root.path,
    filePath: rootModel.root.openspecPath,
  };
}

/**
 * root -> change -> section -> task, with a lone root collapsed away.
 *
 * With no roots at all the result is deliberately empty: package.json declares
 * the welcome content explaining where roots are looked for, and that content
 * shows only while the tree holds nothing. `loading` is the exception - empty
 * means "not yet" then, which is a different sentence.
 */
export function buildTree(model: LedgerModel, options: TreeOptions): LedgerNode[] {
  const context: BuildContext = { options, ids: new Set<string>() };

  if (model.roots.length === 0) {
    return options.loading
      ? [
          messageNode(
            nodeIdFor('message', '', undefined, 'loading'),
            'Looking for OpenSpec roots...',
          ),
        ]
      : [];
  }

  const only = model.roots.length === 1 ? model.roots[0] : undefined;
  if (only) {
    return changeNodes(only, context);
  }
  return model.roots.map((rootModel) => rootNode(rootModel, context));
}
