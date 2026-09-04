/**
 * Renders a movement report against a real tree of OpenSpec roots, without an
 * editor, so the wording and the table can be read before shipping them.
 *
 * The first argument is the tree to read - the path below is only a placeholder
 * for your own - and the second is the window in days:
 *
 *   node scripts/report-preview.ts "D:\\work\\projects" 90
 *
 * History is built into a throwaway directory under the system temp folder;
 * nothing is written to the repositories being read or to extension storage.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { discoverRoots } from '../src/discovery/roots.ts';
import { searchFilesystem } from '../src/discovery/search.ts';
import { backfillRoot } from '../src/history/backfill.ts';
import { HistoryStore } from '../src/history/store.ts';
import { ModelBuilder } from '../src/model/build.ts';
import { toDateKey } from '../src/model/keys.ts';
import { buildMovementReport, renderMovementReport } from '../src/report/movement.ts';

const base = process.argv[2] ?? 'D:\\work\\projects';
const days = Number(process.argv[3] ?? '30');

const roots = await discoverRoots({
  workspaceFolders: [base],
  additionalRoots: [],
  searchWorkspace: (signal) => searchFilesystem([base], { signal }),
});

const model = await new ModelBuilder().build(roots);
const store = new HistoryStore(path.join(os.tmpdir(), `osl-preview-${process.pid}`));

for (const root of model.roots) {
  for (const change of root.changes) {
    if (!change.undecomposed) {
      await store.observe(root.root.path, change);
    }
  }
  await backfillRoot({ root: root.root, changes: root.changes, store });
}
await store.flush();

console.log(
  renderMovementReport(
    buildMovementReport({
      model,
      days,
      today: toDateKey(new Date()),
      historyFor: (rootPath, changeId) => store.history(rootPath, changeId),
    })
  )
);

store.dispose();
