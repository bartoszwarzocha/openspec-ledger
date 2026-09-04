/**
 * Measures the extension's pure layers against a real tree of OpenSpec roots,
 * so the performance budgets in `design.md` are numbers somebody checked rather
 * than numbers somebody hoped for (tasks 2.10, 3.14, 6.15, 9.21, 10.3).
 *
 * Everything it touches is read-only. Run it against a tree of your own - the
 * path below is only a placeholder for the argument you supply:
 *
 *   node scripts/reference-check.ts "D:\\work\\projects"
 *
 * A second argument limits the transcript scan; pass `--no-transcripts` to skip
 * it entirely.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import { discoverRoots } from '../src/discovery/roots.ts';
import { searchFilesystem } from '../src/discovery/search.ts';
import { TranscriptIndex } from '../src/evidence/transcripts.ts';
import { backfillChange } from '../src/history/backfill.ts';
import { ModelBuilder } from '../src/model/build.ts';
import { parseTasks } from '../src/model/parser.ts';
import { findRepositoryRoot, isGitAvailable } from '../src/util/git.ts';
import { setLogSink } from '../src/util/log.ts';

const base = process.argv[2] ?? 'D:\\work\\projects';
const skipTranscripts = process.argv.includes('--no-transcripts');

const verbose = process.argv.includes('--verbose');
setLogSink(verbose ? (_level, line) => console.error(`  ${line}`) : undefined);

function ms(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function verdict(actual: number, budget: number): string {
  return actual <= budget ? 'within' : 'OVER';
}

async function main(): Promise<void> {
  console.log(`Reference environment: ${base}\n`);

  // --- Discovery -----------------------------------------------------------
  const discoveryStart = performance.now();
  const roots = await discoverRoots({
    workspaceFolders: [base],
    additionalRoots: [],
    searchWorkspace: (signal) => searchFilesystem([base], { signal }),
  });
  const discoveryMs = performance.now() - discoveryStart;
  console.log(`Discovery         ${roots.length} roots in ${ms(discoveryMs)}  (budget 1000 ms, ${verdict(discoveryMs, 1000)})`);

  // --- Cold model build ----------------------------------------------------
  const builder = new ModelBuilder();
  const coldStart = performance.now();
  const model = await builder.build(roots);
  const coldMs = performance.now() - coldStart;

  const changes = model.roots.flatMap((root) => root.changes);
  const decomposed = changes.filter((change) => !change.undecomposed);
  const complete = decomposed.filter(
    (change) => (change.taskFile?.progress.total ?? 0) > 0 && change.taskFile?.progress.percent === 100
  );
  const oneShort = decomposed.filter((change) => {
    const progress = change.taskFile?.progress;
    return progress !== undefined && progress.total - progress.completed === 1;
  });
  const leafTotal = decomposed.reduce((sum, c) => sum + (c.taskFile?.progress.total ?? 0), 0);

  console.log(`Model (cold)      ${changes.length} changes, ${leafTotal} leaf tasks in ${ms(coldMs)}`);

  // --- Warm rebuild --------------------------------------------------------
  const warmStart = performance.now();
  await builder.build(roots);
  const warmMs = performance.now() - warmStart;
  console.log(`Model (warm)      rebuild in ${ms(warmMs)}  (budget 250 ms, ${verdict(warmMs, 250)})`);

  console.log('');
  console.log(`  active changes            ${changes.length}`);
  console.log(`  at 100 percent            ${complete.length}`);
  console.log(`  one task short            ${oneShort.length}`);
  console.log(`  not decomposed            ${changes.length - decomposed.length}`);
  console.log(`  roots holding changes     ${model.roots.filter((r) => r.changes.length > 0).length}`);

  // --- Parser budget -------------------------------------------------------
  let biggest = { path: '', tasks: 0, content: '' };
  for (const change of decomposed) {
    const total = change.taskFile?.all.length ?? 0;
    if (total > biggest.tasks && change.tasksPath) {
      biggest = { path: change.tasksPath, tasks: total, content: await fs.readFile(change.tasksPath, 'utf8') };
    }
  }
  if (biggest.content) {
    const runs: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      parseTasks(biggest.content);
      runs.push(performance.now() - start);
    }
    runs.sort((a, b) => a - b);
    const median = runs[Math.floor(runs.length / 2)] ?? 0;
    console.log('');
    console.log(
      `Parser            ${biggest.tasks} tasks (${path.basename(path.dirname(biggest.path))}) median ${ms(median)}  (budget 10 ms, ${verdict(median, 10)})`
    );
  }

  // --- Backfill ------------------------------------------------------------
  if (await isGitAvailable()) {
    const candidate = decomposed.find((change) => change.tasksPath);
    if (candidate?.tasksPath) {
      const repoRoot = await findRepositoryRoot(path.dirname(candidate.tasksPath));
      if (repoRoot) {
        const start = performance.now();
        const result = await backfillChange({ repoRoot, tasksPath: candidate.tasksPath });
        const elapsed = performance.now() - start;
        console.log(
          `Backfill          ${candidate.id}: ${result?.commits ?? 0} commits, ${result?.snapshots.length ?? 0} snapshots in ${ms(elapsed)}  (budget 2000 ms, ${verdict(elapsed, 2000)})`
        );
      } else {
        console.log('Backfill          skipped: the first change is not inside a git repository');
      }
    }
  } else {
    console.log('Backfill          skipped: git is not on PATH');
  }

  // --- Transcripts ---------------------------------------------------------
  if (!skipTranscripts) {
    const index = new TranscriptIndex();
    const coldScanStart = performance.now();
    const cold = await index.scan();
    const coldScanMs = performance.now() - coldScanStart;
    const warmScanStart = performance.now();
    const warm = await index.scan();
    const warmScanMs = performance.now() - warmScanStart;
    console.log('');
    console.log(
      `Transcripts cold  ${cold.scanned} read, ${cold.skipped} skipped as old, in ${ms(coldScanMs)}${cold.unavailable ? ` (${cold.unavailable})` : ''}`
    );
    console.log(
      `Transcripts warm  ${warm.cached} from cache in ${ms(warmScanMs)}  (budget 1000 ms, ${verdict(warmScanMs, 1000)})`
    );

    let bound = 0;
    for (const change of changes) {
      if (index.forChange(change.id).length > 0) {
        bound++;
      }
    }
    console.log(`  changes with a bound session   ${bound} of ${changes.length}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
