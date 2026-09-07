import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseArchiveDates, readArchiveDates } from './archived.ts';
import type { OpenSpecRoot } from '../model/types.ts';

const PREFIX = 'openspec/changes/archive';
const R = '\u0001';

/** One `git log --format=%x01%ad --name-only` block. */
function block(date: string, files: readonly string[]): string {
  return [`${R}${date}`, '', ...files, ''].join('\n');
}

// ---------------------------------------------------------------------------
// Parsing, which is the part that can be wrong
// ---------------------------------------------------------------------------

test('every file of one commit dates the change it belongs to', () => {
  const stdout = block('2026-03-03', [
    `${PREFIX}/tls-cipher-policy/tasks.md`,
    `${PREFIX}/tls-cipher-policy/proposal.md`,
    `${PREFIX}/tls-cipher-policy/specs/behaviour/spec.md`,
  ]);
  assert.deepEqual(parseArchiveDates(stdout, PREFIX), { 'tls-cipher-policy': '2026-03-03' });
});

test('two changes archived on different days keep their own dates', () => {
  const stdout =
    block('2026-05-11', [`${PREFIX}/stopword-tuning/tasks.md`]) +
    block('2026-03-03', [`${PREFIX}/tls-cipher-policy/tasks.md`]);
  assert.deepEqual(parseArchiveDates(stdout, PREFIX), {
    'stopword-tuning': '2026-05-11',
    'tls-cipher-policy': '2026-03-03',
  });
});

test('a file added later does not move the archive date', () => {
  // git lists newest first, so the later commit is seen first and must lose.
  const stdout =
    block('2026-07-20', [`${PREFIX}/tls-cipher-policy/notes.md`]) +
    block('2026-03-03', [`${PREFIX}/tls-cipher-policy/tasks.md`]);
  assert.deepEqual(parseArchiveDates(stdout, PREFIX), { 'tls-cipher-policy': '2026-03-03' });
});

test('a path outside the archive prefix is not a change', () => {
  const stdout = block('2026-03-03', [
    'openspec/changes/still-in-flight/tasks.md',
    'src/tls/policy.ts',
    `${PREFIX}/tls-cipher-policy/tasks.md`,
  ]);
  assert.deepEqual(parseArchiveDates(stdout, PREFIX), { 'tls-cipher-policy': '2026-03-03' });
});

test('a file lying directly in archive/ belongs to no change', () => {
  const stdout = block('2026-03-03', [`${PREFIX}/README.md`, `${PREFIX}/`]);
  assert.deepEqual(parseArchiveDates(stdout, PREFIX), {});
});

test('file names before any commit header are dropped rather than misdated', () => {
  const stdout = [`${PREFIX}/orphan/tasks.md`, '', block('2026-03-03', [`${PREFIX}/real/tasks.md`])].join(
    '\n',
  );
  const dates = parseArchiveDates(stdout, PREFIX);
  assert.equal(dates.orphan, undefined);
  assert.equal(dates.real, '2026-03-03');
});

test('a header that is not a date disowns the block under it', () => {
  const stdout = block('not-a-date', [`${PREFIX}/nope/tasks.md`]);
  assert.deepEqual(parseArchiveDates(stdout, PREFIX), {});
});

test('a trailing slash on the prefix makes no difference', () => {
  const stdout = block('2026-03-03', [`${PREFIX}/one/tasks.md`]);
  assert.deepEqual(parseArchiveDates(stdout, `${PREFIX}/`), parseArchiveDates(stdout, PREFIX));
});

test('CRLF output parses the same as LF', () => {
  const stdout = block('2026-03-03', [`${PREFIX}/one/tasks.md`]).replace(/\n/g, '\r\n');
  assert.deepEqual(parseArchiveDates(stdout, PREFIX), { one: '2026-03-03' });
});

test('empty output is no dates, not an error', () => {
  assert.deepEqual(parseArchiveDates('', PREFIX), {});
});

// ---------------------------------------------------------------------------
// Against a real repository, because the flags are the other half of the answer
// ---------------------------------------------------------------------------

function git(args: readonly string[], cwd: string, date?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (date) {
      env.GIT_AUTHOR_DATE = `${date}T12:00:00`;
      env.GIT_COMMITTER_DATE = `${date}T12:00:00`;
    }
    const child = spawn('git', [...args], { cwd, env, shell: false, windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args[0]} exited ${code}`))));
  });
}

async function gitAvailable(): Promise<boolean> {
  try {
    await git(['--version'], os.tmpdir());
    return true;
  } catch {
    return false;
  }
}

function rootFor(dir: string): OpenSpecRoot {
  return {
    path: dir,
    openspecPath: path.join(dir, 'openspec'),
    label: path.basename(dir),
    hasConfig: true,
    fromSettings: false,
  };
}

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

test('the date comes from the commit that moved the change, rename detection notwithstanding', async (t) => {
  if (!(await gitAvailable())) {
    t.skip('git is not on PATH');
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'osl-archived-'));
  try {
    const changes = path.join(dir, 'openspec', 'changes');
    await write(path.join(changes, 'shipped', 'tasks.md'), '- [x] 1.1 One\n');
    await write(path.join(changes, 'in-flight', 'tasks.md'), '- [ ] 1.1 One\n');

    await git(['init', '-q', '-b', 'main'], dir);
    for (const [key, value] of [
      ['user.name', 'Test'],
      ['user.email', 'test@example.invalid'],
      ['commit.gpgsign', 'false'],
    ]) {
      await git(['config', key ?? '', value ?? ''], dir);
    }
    await git(['add', '-A'], dir);
    await git(['commit', '-q', '-m', 'import'], dir, '2026-01-05');

    // The move, exactly as `openspec archive` performs it. Committed on its own
    // day, and as a pure rename - which is the case `--no-renames` exists for:
    // with git's default detection this commit adds nothing at all.
    await fs.mkdir(path.join(changes, 'archive'), { recursive: true });
    await fs.rename(path.join(changes, 'shipped'), path.join(changes, 'archive', 'shipped'));
    await git(['add', '-A'], dir);
    await git(['commit', '-q', '-m', 'archive shipped'], dir, '2026-04-18');

    const dates = await readArchiveDates({ root: rootFor(dir) });
    assert.deepEqual(dates, { shipped: '2026-04-18' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a root outside a repository yields no dates and no error', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'osl-archived-bare-'));
  try {
    await write(path.join(dir, 'openspec', 'changes', 'archive', 'one', 'tasks.md'), '- [x] 1.1\n');
    // In a temp directory that is not itself a repository. If the machine's
    // temp path happens to sit inside one, the call still has to answer
    // something rather than throw, which is what this asserts.
    const dates = await readArchiveDates({ root: rootFor(dir) });
    assert.equal(typeof dates, 'object');
    assert.equal(dates.one, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('an aborted read asks git nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  const dates = await readArchiveDates({ root: rootFor(os.tmpdir()), signal: controller.signal });
  assert.deepEqual(dates, {});
});
