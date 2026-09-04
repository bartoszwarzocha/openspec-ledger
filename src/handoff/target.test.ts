import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  archiveChainCommandLine,
  archiveCommandLine,
  DEFAULT_ARCHIVE_COMMAND,
  HANDOFF_TARGETS,
  resolveTarget,
} from './target.ts';

const CHAT = { chat: true };
const NO_CHAT = { chat: false };

// ---------------------------------------------------------------------------
// resolveTarget
// ---------------------------------------------------------------------------

test('an unset target is the terminal', () => {
  assert.equal(resolveTarget(undefined, CHAT), 'terminal');
  assert.equal(resolveTarget('', CHAT), 'terminal');
  assert.equal(resolveTarget('   ', CHAT), 'terminal');
});

test('an unknown target falls back to the terminal rather than failing', () => {
  assert.equal(resolveTarget('copilot', CHAT), 'terminal');
  assert.equal(resolveTarget('terminal ', NO_CHAT), 'terminal');
});

test('every known target resolves to itself when the host supports it', () => {
  for (const target of HANDOFF_TARGETS) {
    assert.equal(resolveTarget(target, CHAT), target);
  }
});

test('the configured value is read case- and whitespace-insensitively', () => {
  assert.equal(resolveTarget(' Chat ', CHAT), 'chat');
  assert.equal(resolveTarget('CLIPBOARD', CHAT), 'clipboard');
});

test('chat without a chat panel becomes the clipboard, not the terminal', () => {
  assert.equal(resolveTarget('chat', NO_CHAT), 'clipboard');
});

test('a missing chat panel leaves the other targets alone', () => {
  assert.equal(resolveTarget('terminal', NO_CHAT), 'terminal');
  assert.equal(resolveTarget('clipboard', NO_CHAT), 'clipboard');
  assert.equal(resolveTarget(undefined, NO_CHAT), 'terminal');
});

// ---------------------------------------------------------------------------
// archiveCommandLine
// ---------------------------------------------------------------------------

test('an ordinary change id needs no quoting', () => {
  assert.equal(
    archiveCommandLine(DEFAULT_ARCHIVE_COMMAND, 'add-lookup-provider'),
    'openspec archive add-lookup-provider',
  );
  assert.equal(
    archiveCommandLine(DEFAULT_ARCHIVE_COMMAND, 'fix_v1.2.of-thing'),
    'openspec archive fix_v1.2.of-thing',
  );
});

test('a change id with a space is quoted', () => {
  assert.equal(
    archiveCommandLine(DEFAULT_ARCHIVE_COMMAND, 'add lookup provider'),
    "openspec archive 'add lookup provider'",
  );
});

test('shell syntax in a change id is quoted rather than run', () => {
  for (const id of ['a&b', 'a;rm -rf .', 'a$HOME', 'a|b', 'a`b`', 'a(b)', 'a*']) {
    assert.equal(archiveCommandLine('openspec archive', id), `openspec archive '${id}'`);
  }
});

test('a quote inside the change id is doubled so it stays inside the quoting', () => {
  assert.equal(
    archiveCommandLine('openspec archive', "dev's-change"),
    "openspec archive 'dev''s-change'",
  );
});

test('the command is configurable and kept verbatim', () => {
  assert.equal(archiveCommandLine('pnpm openspec archive', 'a-b'), 'pnpm openspec archive a-b');
  assert.equal(archiveCommandLine('  npx openspec archive  ', 'a-b'), 'npx openspec archive a-b');
});

test('a blank command falls back to the default', () => {
  assert.equal(archiveCommandLine('', 'a-b'), 'openspec archive a-b');
  assert.equal(archiveCommandLine('   ', 'a-b'), 'openspec archive a-b');
});

test('surrounding whitespace on the change id is not carried into the line', () => {
  assert.equal(archiveCommandLine('openspec archive', '  a-b\t'), 'openspec archive a-b');
});

test('the command line is a single line, so nothing is submitted by the text itself', () => {
  const line = archiveCommandLine('openspec archive', 'a b');
  assert.equal(line.includes('\n'), false);
  assert.equal(line, line.trim());
});

test('a chain archives several changes in one line, stopping at the first failure', () => {
  const line = archiveChainCommandLine('openspec archive', ['alpha', 'beta']);
  assert.equal(line, 'openspec archive alpha && openspec archive beta');
});

test('a chain quotes what needs quoting and drops blanks and repeats', () => {
  const line = archiveChainCommandLine('openspec archive', ['a b', '', 'a b', ' c ']);
  assert.equal(line, "openspec archive 'a b' && openspec archive c");
});

test('a chain of nothing is empty, so the caller can refuse to open a terminal', () => {
  assert.equal(archiveChainCommandLine('openspec archive', []), '');
  assert.equal(archiveChainCommandLine('openspec archive', ['  ']), '');
});
