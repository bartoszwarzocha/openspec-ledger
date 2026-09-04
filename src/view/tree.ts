/**
 * The tree surface: `LedgerNode` in, `vscode.TreeItem` out.
 *
 * Every judgement about what a node says - label, badge, icon, order, which
 * children it has - is made in `nodes.ts`, which is pure and unit-tested. This
 * file only hands those decisions to the editor, so the one module that cannot
 * run outside an extension host contains no logic worth testing.
 */

import * as vscode from 'vscode';
import type { LedgerModel, LedgerNode, TreeOptions } from '../model/types.ts';
import { buildTree, countReadyToArchive } from './nodes.ts';

/** Stands in for a model that has not been built yet; nothing reads its date. */
const EPOCH = new Date(0);

/** Options the provider uses until `setModel` supplies the real ones. */
function initialOptions(): TreeOptions {
  return {
    sortMode: 'name',
    filter: 'all',
    stalls: {},
    lastAdvanced: {},
    loading: true,
  };
}

export function toCollapsibleState(
  collapsible: LedgerNode['collapsible'],
): vscode.TreeItemCollapsibleState {
  switch (collapsible) {
    case 'expanded':
      return vscode.TreeItemCollapsibleState.Expanded;
    case 'collapsed':
      return vscode.TreeItemCollapsibleState.Collapsed;
    default:
      return vscode.TreeItemCollapsibleState.None;
  }
}

export function toCheckboxState(
  checkbox: LedgerNode['checkbox'],
): vscode.TreeItemCheckboxState | undefined {
  if (checkbox === 'checked') {
    return vscode.TreeItemCheckboxState.Checked;
  }
  if (checkbox === 'unchecked') {
    return vscode.TreeItemCheckboxState.Unchecked;
  }
  return undefined;
}

/** Past any real line length, and still inside what the editor treats as a small integer. */
const MAX_COLUMN = 1 << 30;

/**
 * Selection covering the whole recorded line.
 *
 * The end column is deliberately past any real line length: the editor clamps a
 * selection to the document, and the node does not know how long its line is.
 */
export function lineSelection(line: number): vscode.Range {
  const zeroBased = Math.max(0, line - 1);
  return new vscode.Range(zeroBased, 0, zeroBased, MAX_COLUMN);
}

/**
 * True when the node's target is a directory rather than a document.
 *
 * `nodes.ts` points a root at its `openspec` directory, and points a change
 * with neither a proposal nor a design at the change directory itself; those
 * are the only two targets that are not a markdown file.
 */
export function isFolderTarget(node: LedgerNode): boolean {
  if (!node.filePath) {
    return false;
  }
  return node.kind === 'root' || (node.kind === 'change' && !/\.md$/i.test(node.filePath));
}

/**
 * What a click does.
 *
 * `vscode.open` rather than a command of our own: it already handles a document
 * that is open, closed, or shown in another group, and needs no registration.
 * A change with nothing to open reveals its directory instead, which is what
 * the navigation requirement asks for. A root gets no command at all - the
 * click's job there is to expand it, and pulling focus into the Explorer while
 * the user is navigating the ledger would be a worse answer than none.
 */
export function nodeCommand(node: LedgerNode): vscode.Command | undefined {
  // A change opens its detail panel, which is the assembled answer: progress
  // over time, the sessions that worked on it, the evidence. `proposal.md` is
  // one input to that answer, and putting the raw file behind the click while
  // the summary needed a second button had it exactly backwards.
  if (node.kind === 'change') {
    return { command: 'openspecLedger.openChangeDetail', title: 'Open Change Detail', arguments: [node] };
  }

  if (!node.filePath) {
    return undefined;
  }
  const uri = vscode.Uri.file(node.filePath);

  if (isFolderTarget(node)) {
    return undefined;
  }

  const options: vscode.TextDocumentShowOptions = { preview: true };
  if (node.line !== undefined && node.line > 0) {
    options.selection = lineSelection(node.line);
  }
  return { command: 'vscode.open', title: 'Open', arguments: [uri, options] };
}

export class LedgerTreeDataProvider
  implements vscode.TreeDataProvider<LedgerNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<LedgerNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<LedgerNode | undefined> = this.emitter.event;

  private model: LedgerModel | undefined = undefined;
  private options: TreeOptions = initialOptions();
  private roots: LedgerNode[] = [];
  /** Node by id, so a caller holding a node from before a rebuild still resolves. */
  private readonly byId = new Map<string, LedgerNode>();
  /** Child id -> parent node, the only way `getParent` can answer for `reveal`. */
  private readonly parentOf = new Map<string, LedgerNode>();

  constructor() {
    // Nothing to wire: the provider is fed by `setModel`.
  }

  setModel(model: LedgerModel | undefined, options: TreeOptions): void {
    this.model = model;
    this.options = options;
    this.rebuild();
  }

  setOptions(options: Partial<TreeOptions>): void {
    this.options = { ...this.options, ...options };
    this.rebuild();
  }

  get nodes(): LedgerNode[] {
    return this.roots;
  }

  /** Changes at 100 percent across the whole model - the view title badge. */
  get readyToArchiveCount(): number {
    return this.model ? countReadyToArchive(this.model) : 0;
  }

  find(predicate: (node: LedgerNode) => boolean): LedgerNode | undefined {
    const stack = [...this.roots].reverse();
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (predicate(node)) {
        return node;
      }
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const child = node.children[i];
        if (child) {
          stack.push(child);
        }
      }
    }
    return undefined;
  }

  /**
   * Redraw one node and its subtree (design.md D13): a checkbox toggle mutates
   * the node it happened on and refreshes from there, so the 100 ms budget does
   * not depend on rebuilding the model.
   */
  refreshNode(node: LedgerNode): void {
    // A caller may hold the node it was handed before the last rebuild; the
    // editor only knows the instance currently in the tree.
    this.emitter.fire(this.byId.get(node.id) ?? node);
  }

  getTreeItem(node: LedgerNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, toCollapsibleState(node.collapsible));
    // Identity from the node, so expansion and selection survive a refresh.
    item.id = node.id;
    item.description = node.description;
    item.contextValue = node.contextValue;

    if (node.tooltip !== undefined) {
      const tooltip = new vscode.MarkdownString(node.tooltip);
      tooltip.supportThemeIcons = true;
      // Left untrusted: tooltips carry task text from the user's repositories.
      item.tooltip = tooltip;
    }

    if (node.iconId !== undefined) {
      item.iconPath = new vscode.ThemeIcon(
        node.iconId,
        node.iconColor === undefined ? undefined : new vscode.ThemeColor(node.iconColor),
      );
    }

    const checkbox = toCheckboxState(node.checkbox);
    if (checkbox !== undefined) {
      item.checkboxState = checkbox;
    }

    const command = nodeCommand(node);
    if (command) {
      item.command = command;
    }

    return item;
  }

  getChildren(node?: LedgerNode): LedgerNode[] {
    return node ? node.children : this.roots;
  }

  getParent(node: LedgerNode): LedgerNode | undefined {
    return this.parentOf.get(node.id);
  }

  dispose(): void {
    this.emitter.dispose();
    this.byId.clear();
    this.parentOf.clear();
    this.roots = [];
  }

  private rebuild(): void {
    // No model yet is the same shape as a model with no roots: `buildTree`
    // decides between "looking for roots" and the welcome content from
    // `options.loading`, so both cases go through it rather than short-circuiting
    // to an empty tree that would render blank during the first discovery.
    this.roots = buildTree(this.model ?? { roots: [], builtAt: EPOCH }, this.options);
    this.byId.clear();
    this.parentOf.clear();
    this.index(this.roots, undefined);
    this.emitter.fire(undefined);
  }

  private index(nodes: readonly LedgerNode[], parent: LedgerNode | undefined): void {
    for (const node of nodes) {
      this.byId.set(node.id, node);
      if (parent) {
        this.parentOf.set(node.id, parent);
      }
      if (node.children.length > 0) {
        this.index(node.children, node);
      }
    }
  }
}
