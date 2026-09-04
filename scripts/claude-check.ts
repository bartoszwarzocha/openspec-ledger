/**
 * What the Claude Code evidence layer reports for one change, read from the
 * transcripts on this machine.
 *
 *   node scripts/claude-check.ts implement-openspec-ledger
 *
 * Read-only, and it prints aggregates and file paths only - never prompt or
 * response text, which is the layer's standing guarantee.
 */

import { TranscriptIndex } from '../src/evidence/transcripts.ts';

const changeId = process.argv[2] ?? 'implement-openspec-ledger';

const index = new TranscriptIndex();
const started = Date.now();
const result = await index.scan();
console.log(
  `scan: ${result.scanned} read, ${result.cached} cached, ${result.skipped} skipped in ${Date.now() - started} ms` +
    (result.unavailable ? ` (${result.unavailable})` : '')
);

const sessions = index.forChange(changeId);
if (sessions.length === 0) {
  console.log(`\nNo Claude Code session references openspec/changes/${changeId}.`);
  process.exit(0);
}

let input = 0;
let output = 0;
let cacheWrite = 0;
let cacheRead = 0;
let cost = 0;
const files = new Set<string>();
const ids = new Set<string>();
const unpriced = new Set<string>();
let from = sessions[0]!.firstActivity;
let to = sessions[0]!.lastActivity;

for (const session of sessions) {
  input += session.tokens.input;
  output += session.tokens.output;
  cacheWrite += session.tokens.cacheWrite;
  cacheRead += session.tokens.cacheRead;
  cost += session.costUsd;
  ids.add(session.sessionId);
  for (const file of session.editedFiles) files.add(file);
  for (const model of session.unpricedModels) unpriced.add(model);
  if (session.firstActivity < from) from = session.firstActivity;
  if (session.lastActivity > to) to = session.lastActivity;
}

const fmt = (n: number): string => n.toLocaleString('en-GB');

console.log(`\nChange: ${changeId}`);
console.log(`  transcript records   ${sessions.length}`);
console.log(`  distinct session ids ${ids.size}   (a subagent transcript carries its parent's id)`);
console.log(`  span                 ${from.toISOString().slice(0, 16)} to ${to.toISOString().slice(0, 16)}`);
console.log(`  tokens               in ${fmt(input)}, out ${fmt(output)}, cache write ${fmt(cacheWrite)}, cache read ${fmt(cacheRead)}`);
console.log(`  estimated cost       $${cost.toFixed(2)}   (local estimate, not a billed figure)`);
console.log(`  files edited outside openspec/  ${files.size}`);
if (unpriced.size > 0) {
  console.log(`  unpriced models      ${[...unpriced].join(', ')}`);
}
for (const file of [...files].sort().slice(0, 15)) {
  console.log(`      ${file}`);
}
if (files.size > 15) {
  console.log(`      ... and ${files.size - 15} more`);
}
