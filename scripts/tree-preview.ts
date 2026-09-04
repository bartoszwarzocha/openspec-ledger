/**
 * Prints the node tree the Ledger view renders, for a real tree of OpenSpec
 * roots. `view/tree.ts` maps these nodes onto `vscode.TreeItem` one for one, so
 * what this prints is what the view shows, minus the pixels. The first argument
 * is the tree to read; the path below is only a placeholder for your own:
 *
 *   node scripts/tree-preview.ts "D:\\work\\projects" [sortMode] [--tasks]
 *
 * Read-only, and it needs no editor.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { discoverRoots } from '../src/discovery/roots.ts';
import { backfillRoot } from '../src/history/backfill.ts';
import { stallOf } from '../src/history/derive.ts';
import { HistoryStore } from '../src/history/store.ts';
import { toDateKey } from '../src/model/keys.ts';
import { changeKey } from '../src/model/keys.ts';
import type { Stall } from '../src/model/types.ts';
import { searchFilesystem } from '../src/discovery/search.ts';
import { ModelBuilder } from '../src/model/build.ts';
import type { LedgerNode, SortMode } from '../src/model/types.ts';
import { buildTree, countReadyToArchive } from '../src/view/nodes.ts';

const base = process.argv[2] ?? 'D:\\work\\projects';
const sortMode = (process.argv[3] as SortMode | undefined) ?? 'nearest-done';
const showTasks = process.argv.includes('--tasks');

const roots = await discoverRoots({
  workspaceFolders: [base],
  additionalRoots: [],
  searchWorkspace: (signal) => searchFilesystem([base], { signal }),
});
const model = await new ModelBuilder().build(roots);

// Real stall figures, so the warning icons are the ones the user would see.
const store = new HistoryStore(path.join(os.tmpdir(), `osl-tree-${process.pid}`));
const stalls: Record<string, Stall | undefined> = {};
const today = toDateKey(new Date());
for (const rootModel of model.roots) {
  for (const change of rootModel.changes) {
    if (!change.undecomposed) {
      await store.observe(rootModel.root.path, change);
    }
  }
  await backfillRoot({ root: rootModel.root, changes: rootModel.changes, store });
  for (const change of rootModel.changes) {
    stalls[changeKey(rootModel.root.path, change.id)] = stallOf(
      store.history(rootModel.root.path, change.id),
      change,
      today,
    );
  }
}
await store.flush();

const nodes = buildTree(model, {
  sortMode,
  filter: (process.argv[4] as never) ?? 'all',
  stalls,
  lastAdvanced: {},
  staleAfterDays: 30,
});

const counts: Record<string, number> = {};

function walk(list: readonly LedgerNode[], depth: number): void {
  for (const node of list) {
    counts[node.kind] = (counts[node.kind] ?? 0) + 1;
    if (node.kind === 'task' && !showTasks) {
      continue;
    }
    const badge = node.description ? `  ${node.description}` : '';
    const icon = node.iconId ? `[${node.iconId}]` : '';
    console.log(`${'  '.repeat(depth)}${icon} ${node.label}${badge}`);
    walk(node.children, depth + 1);
  }
}

console.log(`sort mode: ${sortMode}\n`);
walk(nodes, 0);

console.log('\n--- node counts ---');
for (const [kind, count] of Object.entries(counts).sort()) {
  console.log(`  ${kind.padEnd(8)} ${count}`);
}
console.log(`  ready to archive badge: ${countReadyToArchive(model)}`);
