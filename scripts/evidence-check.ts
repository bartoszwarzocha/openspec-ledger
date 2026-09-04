/**
 * Runs the git evidence layer over a real tree of OpenSpec roots and counts what
 * it concludes, so the decision in task 8.14 - whether the layer ships on or off
 * by default - rests on a measured false-positive rate rather than on taste.
 *
 * The tree to read is the argument; the path below is only a placeholder:
 *
 *   node scripts/evidence-check.ts "D:\\work\\projects"
 *
 * Read-only: history is backfilled into a throwaway directory under the system
 * temp folder, and nothing is written to the repositories being read.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { discoverRoots } from '../src/discovery/roots.ts';
import { searchFilesystem } from '../src/discovery/search.ts';
import { evaluateGitEvidence } from '../src/evidence/git.ts';
import { backfillRoot } from '../src/history/backfill.ts';
import { HistoryStore } from '../src/history/store.ts';
import { ModelBuilder } from '../src/model/build.ts';
import { toDateKey } from '../src/model/keys.ts';
import type { EvidenceState } from '../src/model/types.ts';

const base = process.argv[2] ?? 'D:\\work\\projects';
const today = toDateKey(new Date());

const roots = await discoverRoots({
  workspaceFolders: [base],
  additionalRoots: [],
  searchWorkspace: (signal) => searchFilesystem([base], { signal }),
});

const model = await new ModelBuilder().build(roots);
const store = new HistoryStore(path.join(os.tmpdir(), `osl-evidence-${process.pid}`));

process.stderr.write('backfilling history...\n');
for (const rootModel of model.roots) {
  for (const change of rootModel.changes) {
    if (!change.undecomposed) {
      await store.observe(rootModel.root.path, change);
    }
  }
  await backfillRoot({ root: rootModel.root, changes: rootModel.changes, store });
}
await store.flush();

const tally: Record<EvidenceState, number> = {
  corroborated: 0,
  'no-references': 0,
  'no-trace': 0,
  'unknown-date': 0,
};
const unavailable = new Map<string, number>();
const noTrace: Array<{ change: string; label: string; refs: string[]; window: string }> = [];

process.stderr.write('evaluating...\n');
const started = Date.now();
for (const rootModel of model.roots) {
  for (const change of rootModel.changes) {
    const evidence = await evaluateGitEvidence({
      enabled: true,
      root: rootModel.root,
      change,
      history: store.history(rootModel.root.path, change.id),
      dismissedKeys: [],
      today,
    });
    if (!evidence.available) {
      const reason = evidence.reason ?? 'unknown';
      unavailable.set(reason, (unavailable.get(reason) ?? 0) + 1);
      continue;
    }
    for (const result of evidence.results) {
      tally[result.state] += 1;
    }
    for (const result of evidence.noTrace) {
      noTrace.push({
        change: change.id,
        label: result.label,
        refs: [...result.references.paths, ...result.references.symbols],
        window: `${result.windowFrom ?? '?'} to ${result.completedOn ?? '?'}`,
      });
    }
  }
}
const elapsed = Date.now() - started;

const evaluated = Object.values(tally).reduce((a, b) => a + b, 0);
console.log(`Reference environment: ${base}`);
console.log(`Completed tasks evaluated: ${evaluated} in ${(elapsed / 1000).toFixed(1)} s\n`);
for (const [state, count] of Object.entries(tally)) {
  const share = evaluated > 0 ? ((count / evaluated) * 100).toFixed(1) : '0.0';
  console.log(`  ${state.padEnd(14)} ${String(count).padStart(4)}  ${share.padStart(5)} %`);
}
if (unavailable.size > 0) {
  console.log('\nChanges where the layer reported itself unavailable:');
  for (const [reason, count] of unavailable) {
    console.log(`  ${reason.padEnd(20)} ${count}`);
  }
}

console.log(`\nSurfaced no-trace results: ${noTrace.length}`);
for (const item of noTrace.slice(0, 200)) {
  console.log(`\n  ${item.change}`);
  console.log(`    task:   ${item.label.slice(0, 110)}`);
  console.log(`    window: ${item.window}`);
  console.log(`    refs:   ${item.refs.join(', ').slice(0, 140)}`);
}
if (noTrace.length > 200) {
  console.log(`\n  ... and ${noTrace.length - 200} more not listed`);
}

store.dispose();
