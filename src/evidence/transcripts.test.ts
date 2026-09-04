import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TranscriptIndex,
  claudeDataDirectory,
  listTranscripts,
  scanTranscript,
} from './transcripts.ts';

// ---------------------------------------------------------------------------
// Fixtures
//
// Every transcript is synthetic and lives under the OS temp directory. Nothing
// here reads the machine's own `.claude`, so the suite behaves the same on a
// developer's laptop and on a build agent that has never run Claude Code.
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  dataDir: string;
  projectsDir: string;
  env: NodeJS.ProcessEnv;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'osl-transcripts-'));
  const dataDir = path.join(root, '.claude');
  const projectsDir = path.join(dataDir, 'projects');
  await fsp.mkdir(projectsDir, { recursive: true });
  const fixture: Fixture = {
    root,
    dataDir,
    projectsDir,
    env: { CLAUDE_CONFIG_DIR: dataDir, HOME: root, USERPROFILE: root },
  };
  try {
    await run(fixture);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

/** Timestamps are built from local components so a date key is zone-independent. */
function at(day: number, hour: number): string {
  return new Date(2026, 7, day, hour, 0, 0).toISOString();
}

interface AssistantOptions {
  sessionId: string;
  messageId: string;
  requestId: string;
  timestamp: string;
  model?: string;
  cwd?: string;
  inputTokens?: number;
  outputTokens?: number;
  edits?: string[];
  text?: string;
}

function assistant(options: AssistantOptions): unknown {
  const content: unknown[] = [];
  if (options.text !== undefined) {
    content.push({ type: 'text', text: options.text });
  }
  for (const file of options.edits ?? []) {
    content.push({
      type: 'tool_use',
      id: `toolu_${content.length}`,
      name: 'Edit',
      input: { file_path: file, old_string: 'a', new_string: 'b' },
    });
  }
  return {
    type: 'assistant',
    sessionId: options.sessionId,
    cwd: options.cwd ?? 'E:\\proj',
    timestamp: options.timestamp,
    requestId: options.requestId,
    message: {
      id: options.messageId,
      role: 'assistant',
      model: options.model ?? 'claude-opus-5',
      content,
      usage: {
        input_tokens: options.inputTokens ?? 100,
        output_tokens: options.outputTokens ?? 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

function user(sessionId: string, timestamp: string, text: string): unknown {
  return {
    type: 'user',
    sessionId,
    cwd: 'E:\\proj',
    timestamp,
    message: { role: 'user', content: text },
  };
}

async function writeTranscript(
  fixture: Fixture,
  project: string,
  sessionId: string,
  lines: readonly unknown[],
): Promise<string> {
  const dir = path.join(fixture.projectsDir, project);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const body = lines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n');
  await fsp.writeFile(file, `${body}\n`, 'utf8');
  return file;
}

async function backdate(file: string, days: number): Promise<void> {
  const when = new Date(Date.now() - days * 86_400_000);
  await fsp.utimes(file, when, when);
}

// ---------------------------------------------------------------------------
// Locating the data directory
// ---------------------------------------------------------------------------

test('CLAUDE_CONFIG_DIR overrides the default location', async () => {
  await withFixture(async (fixture) => {
    const elsewhere = path.join(fixture.root, 'elsewhere');
    await fsp.mkdir(elsewhere, { recursive: true });

    assert.equal(
      claudeDataDirectory({ CLAUDE_CONFIG_DIR: elsewhere, HOME: fixture.root, USERPROFILE: fixture.root }),
      elsewhere,
    );
  });
});

test('the default location is .claude in the home directory', async () => {
  await withFixture(async (fixture) => {
    assert.equal(claudeDataDirectory({ HOME: fixture.root, USERPROFILE: fixture.root }), fixture.dataDir);
  });
});

test('a machine with no Claude Code data directory reports an explained absence', async () => {
  await withFixture(async (fixture) => {
    const bare = path.join(fixture.root, 'bare');
    await fsp.mkdir(bare, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: path.join(bare, 'does-not-exist'),
      HOME: bare,
      USERPROFILE: bare,
    };

    assert.equal(claudeDataDirectory(env), undefined);

    const index = new TranscriptIndex({ env });
    const result = await index.scan();
    assert.equal(result.unavailable, 'no-data-directory');
    assert.equal(result.scanned, 0);
    assert.deepEqual(index.forChange('anything'), []);
  });
});

// ---------------------------------------------------------------------------
// Listing and scanning
// ---------------------------------------------------------------------------

test('every .jsonl beneath projects is found, at any depth', async () => {
  await withFixture(async (fixture) => {
    await writeTranscript(fixture, 'proj-a', 'aaa', [user('aaa', at(1, 9), 'hello')]);
    await writeTranscript(fixture, path.join('proj-b', 'nested'), 'bbb', [
      user('bbb', at(1, 9), 'hello'),
    ]);
    await fsp.writeFile(path.join(fixture.projectsDir, 'notes.txt'), 'ignored', 'utf8');

    const files = await listTranscripts(fixture.projectsDir);

    assert.deepEqual(
      files.map((file) => file.sessionId).sort(),
      ['aaa', 'bbb'],
    );
    assert.ok(files.every((file) => file.size > 0));
  });
});

test('an unreadable projects directory yields no transcripts rather than an error', async () => {
  const missing = path.join(os.tmpdir(), 'osl-transcripts-missing-directory');
  assert.deepEqual(await listTranscripts(missing), []);
});

test('scanTranscript summarises one file', async () => {
  await withFixture(async (fixture) => {
    const file = await writeTranscript(fixture, 'proj-a', 'session-1', [
      user('session-1', at(3, 9), 'work on openspec/changes/demo-change/tasks.md'),
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(3, 10),
        inputTokens: 1_000_000,
        outputTokens: 0,
        edits: ['E:\\proj\\src\\provider\\mod.rs'],
      }),
    ]);

    const [listed] = await listTranscripts(fixture.projectsDir);
    assert.ok(listed);
    const summary = await scanTranscript(listed);

    assert.ok(summary);
    assert.equal(summary.sessionId, 'session-1');
    assert.equal(summary.transcriptPath, file);
    assert.equal(summary.cwd, 'E:\\proj');
    assert.deepEqual(summary.changeIds, ['demo-change']);
    assert.deepEqual(summary.models, ['claude-opus-5']);
    assert.deepEqual(summary.unpricedModels, []);
    assert.equal(summary.messageCount, 1);
    assert.equal(summary.tokens.input, 1_000_000);
    assert.equal(summary.costUsd, 5);
    assert.deepEqual(summary.editedFiles, ['E:\\proj\\src\\provider\\mod.rs']);
    assert.equal(summary.firstActivity.getTime(), Date.parse(at(3, 9)));
    assert.equal(summary.lastActivity.getTime(), Date.parse(at(3, 10)));
  });
});

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

test('a session is bound by a change path in a tool input', async () => {
  await withFixture(async (fixture) => {
    await writeTranscript(fixture, 'proj-a', 'session-1', [
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(4, 10),
        text: 'reading openspec/changes/route-reads-through-data-service/tasks.md',
      }),
    ]);

    const index = new TranscriptIndex({ env: fixture.env });
    await index.scan();

    const bound = index.forChange('route-reads-through-data-service');
    assert.equal(bound.length, 1);
    assert.equal(bound[0]?.sessionId, 'session-1');
  });
});

test('a backslash change path binds too', async () => {
  await withFixture(async (fixture) => {
    await writeTranscript(fixture, 'proj-a', 'session-1', [
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(4, 10),
        edits: ['E:\\proj\\openspec\\changes\\theme-tokens\\design.md'],
      }),
    ]);

    const index = new TranscriptIndex({ env: fixture.env });
    await index.scan();

    assert.equal(index.forChange('theme-tokens').length, 1);
  });
});

test('a transcript mentioning no change path appears under no change', async () => {
  await withFixture(async (fixture) => {
    await writeTranscript(fixture, 'proj-a', 'session-1', [
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(4, 10),
        text: 'ordinary work with no specification in sight',
      }),
    ]);

    const index = new TranscriptIndex({ env: fixture.env });
    const result = await index.scan();

    assert.equal(result.scanned, 1);
    assert.deepEqual(index.forChange('demo-change'), []);
  });
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

test('a repeated message and request id pair is counted once', async () => {
  await withFixture(async (fixture) => {
    const repeated = assistant({
      sessionId: 'session-1',
      messageId: 'msg_1',
      requestId: 'req_1',
      timestamp: at(5, 10),
      inputTokens: 1_000,
      outputTokens: 500,
      text: 'openspec/changes/demo-change/tasks.md',
    });
    await writeTranscript(fixture, 'proj-a', 'session-1', [
      repeated,
      repeated,
      repeated,
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_2',
        requestId: 'req_2',
        timestamp: at(5, 11),
        inputTokens: 1_000,
        outputTokens: 500,
      }),
    ]);

    const index = new TranscriptIndex({ env: fixture.env });
    await index.scan();

    const [session] = index.forChange('demo-change');
    assert.ok(session);
    assert.equal(session.messageCount, 2);
    assert.equal(session.tokens.input, 2_000);
    assert.equal(session.tokens.output, 1_000);
  });
});

test('edited files exclude the change documents themselves', async () => {
  await withFixture(async (fixture) => {
    await writeTranscript(fixture, 'proj-a', 'session-1', [
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(6, 10),
        edits: [
          'E:\\proj\\src\\provider\\mod.rs',
          'E:\\proj\\openspec\\changes\\demo-change\\tasks.md',
          'E:/proj/openspec/changes/demo-change/proposal.md',
          'E:\\proj\\src\\provider\\mod.rs',
        ],
      }),
    ]);

    const index = new TranscriptIndex({ env: fixture.env });
    await index.scan();

    const [session] = index.forChange('demo-change');
    assert.ok(session);
    assert.deepEqual(session.editedFiles, ['E:\\proj\\src\\provider\\mod.rs']);
  });
});

test('an unpriced model is listed and contributes nothing', async () => {
  await withFixture(async (fixture) => {
    await writeTranscript(fixture, 'proj-a', 'session-1', [
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(6, 10),
        model: 'some-other-vendor-model',
        inputTokens: 1_000_000,
        text: 'openspec/changes/demo-change/tasks.md',
      }),
    ]);

    const index = new TranscriptIndex({ env: fixture.env });
    await index.scan();

    const [session] = index.forChange('demo-change');
    assert.ok(session);
    assert.deepEqual(session.unpricedModels, ['some-other-vendor-model']);
    assert.equal(session.costUsd, 0);
    assert.equal(session.tokens.input, 1_000_000);
  });
});

test('a malformed line is skipped without abandoning the file', async () => {
  await withFixture(async (fixture) => {
    await writeTranscript(fixture, 'proj-a', 'session-1', [
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(7, 10),
        inputTokens: 1_000,
      }),
      '{"type":"assistant","sessionId":"session-1","message":{"id":"msg_x", truncated',
      '',
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_2',
        requestId: 'req_2',
        timestamp: at(7, 11),
        inputTokens: 1_000,
        text: 'openspec/changes/demo-change/tasks.md',
      }),
    ]);

    const index = new TranscriptIndex({ env: fixture.env });
    await index.scan();

    const [session] = index.forChange('demo-change');
    assert.ok(session);
    assert.equal(session.messageCount, 2);
    assert.equal(session.tokens.input, 2_000);
  });
});

test('a change reference on a half-written line still binds', async () => {
  await withFixture(async (fixture) => {
    await writeTranscript(fixture, 'proj-a', 'session-1', [
      user('session-1', at(7, 9), 'hello'),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"openspec/changes/half-w',
    ]);

    const index = new TranscriptIndex({ env: fixture.env });
    await index.scan();

    assert.equal(index.forChange('half-w').length, 1);
  });
});

// ---------------------------------------------------------------------------
// Laziness and caching
// ---------------------------------------------------------------------------

test('constructing the index reads nothing', async () => {
  await withFixture(async (fixture) => {
    await writeTranscript(fixture, 'proj-a', 'session-1', [
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(8, 10),
        text: 'openspec/changes/demo-change/tasks.md',
      }),
    ]);

    const index = new TranscriptIndex({ env: fixture.env });

    assert.equal(index.lastScan, undefined);
    assert.deepEqual(index.forChange('demo-change'), []);
  });
});

test('a second scan with nothing modified reads no transcript', async () => {
  await withFixture(async (fixture) => {
    await writeTranscript(fixture, 'proj-a', 'session-1', [
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(9, 10),
        text: 'openspec/changes/demo-change/tasks.md',
      }),
    ]);
    await writeTranscript(fixture, 'proj-b', 'session-2', [
      assistant({
        sessionId: 'session-2',
        messageId: 'msg_2',
        requestId: 'req_2',
        timestamp: at(9, 11),
        text: 'openspec/changes/demo-change/proposal.md',
      }),
    ]);

    const index = new TranscriptIndex({ env: fixture.env });
    const first = await index.scan();
    const second = await index.scan();

    assert.deepEqual(first, { scanned: 2, skipped: 0, cached: 0 });
    assert.deepEqual(second, { scanned: 0, skipped: 0, cached: 2 });
    assert.equal(index.forChange('demo-change').length, 2);
    assert.ok(index.lastScan instanceof Date);
  });
});

test('a modified transcript is read again', async () => {
  await withFixture(async (fixture) => {
    const lines = [
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(9, 10),
        text: 'openspec/changes/demo-change/tasks.md',
      }),
    ];
    await writeTranscript(fixture, 'proj-a', 'session-1', lines);

    const index = new TranscriptIndex({ env: fixture.env });
    await index.scan();

    await writeTranscript(fixture, 'proj-a', 'session-1', [
      ...lines,
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_2',
        requestId: 'req_2',
        timestamp: at(9, 12),
      }),
    ]);

    const second = await index.scan();
    assert.equal(second.scanned, 1);
    assert.equal(index.forChange('demo-change')[0]?.messageCount, 2);
  });
});

test('a transcript untouched for 45 days is skipped unless a full rescan is asked for', async () => {
  await withFixture(async (fixture) => {
    const file = await writeTranscript(fixture, 'proj-a', 'session-old', [
      assistant({
        sessionId: 'session-old',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(1, 10),
        text: 'openspec/changes/demo-change/tasks.md',
      }),
    ]);
    await backdate(file, 45);

    const index = new TranscriptIndex({ env: fixture.env });
    const first = await index.scan();

    assert.deepEqual(first, { scanned: 0, skipped: 1, cached: 0 });
    assert.deepEqual(index.forChange('demo-change'), []);

    const rescan = await index.scan({ fullRescan: true });

    assert.deepEqual(rescan, { scanned: 1, skipped: 0, cached: 0 });
    assert.equal(index.forChange('demo-change').length, 1);
  });
});

test('the age limit is configurable', async () => {
  await withFixture(async (fixture) => {
    const file = await writeTranscript(fixture, 'proj-a', 'session-old', [
      assistant({
        sessionId: 'session-old',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(1, 10),
        text: 'openspec/changes/demo-change/tasks.md',
      }),
    ]);
    await backdate(file, 45);

    const index = new TranscriptIndex({ env: fixture.env, maxAgeDays: 90 });
    const result = await index.scan();

    assert.equal(result.scanned, 1);
    assert.equal(index.forChange('demo-change').length, 1);
  });
});

test('a deleted transcript leaves the index', async () => {
  await withFixture(async (fixture) => {
    const file = await writeTranscript(fixture, 'proj-a', 'session-1', [
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(10, 10),
        text: 'openspec/changes/demo-change/tasks.md',
      }),
    ]);

    const index = new TranscriptIndex({ env: fixture.env });
    await index.scan();
    assert.equal(index.forChange('demo-change').length, 1);

    await fsp.rm(file);
    await index.scan();

    assert.deepEqual(index.forChange('demo-change'), []);
  });
});

test('clear forgets everything that was read', async () => {
  await withFixture(async (fixture) => {
    await writeTranscript(fixture, 'proj-a', 'session-1', [
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(10, 10),
        text: 'openspec/changes/demo-change/tasks.md',
      }),
    ]);

    const index = new TranscriptIndex({ env: fixture.env });
    await index.scan();
    index.clear();

    assert.equal(index.lastScan, undefined);
    assert.deepEqual(index.forChange('demo-change'), []);
  });
});

test('concurrent scans do not run twice over the same files', async () => {
  await withFixture(async (fixture) => {
    await writeTranscript(fixture, 'proj-a', 'session-1', [
      assistant({
        sessionId: 'session-1',
        messageId: 'msg_1',
        requestId: 'req_1',
        timestamp: at(11, 10),
        text: 'openspec/changes/demo-change/tasks.md',
      }),
    ]);

    const index = new TranscriptIndex({ env: fixture.env });
    const [a, b] = await Promise.all([index.scan(), index.scan()]);

    assert.deepEqual(a, b);
    assert.equal(a?.scanned, 1);
  });
});
