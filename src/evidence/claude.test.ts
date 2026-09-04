import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Change, ChangeHistory, Task } from '../model/types.ts';
import { makeProgress, taskKey } from '../model/keys.ts';
import { TranscriptIndex } from './transcripts.ts';
import { evaluateClaudeEvidence } from './claude.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  projectsDir: string;
  env: NodeJS.ProcessEnv;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'osl-claude-'));
  const projectsDir = path.join(root, '.claude', 'projects');
  await fsp.mkdir(projectsDir, { recursive: true });
  try {
    await run({ root, projectsDir, env: { HOME: root, USERPROFILE: root } });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

/** Local components, so the calendar day of a timestamp does not depend on the zone. */
function at(day: number, hour: number): string {
  return new Date(2026, 7, day, hour, 0, 0).toISOString();
}

interface SessionFixture {
  sessionId: string;
  from: string;
  to: string;
  changeId?: string;
  edits?: string[];
  inputTokens?: number;
}

async function writeSession(fixture: Fixture, session: SessionFixture): Promise<void> {
  const dir = path.join(fixture.projectsDir, 'proj');
  await fsp.mkdir(dir, { recursive: true });
  const content: unknown[] = [
    {
      type: 'text',
      text: session.changeId
        ? `working on openspec/changes/${session.changeId}/tasks.md`
        : 'no specification in sight',
    },
  ];
  for (const file of session.edits ?? []) {
    content.push({
      type: 'tool_use',
      id: `toolu_${content.length}`,
      name: 'Write',
      input: { file_path: file, content: 'x' },
    });
  }
  const lines = [
    {
      type: 'user',
      sessionId: session.sessionId,
      cwd: 'E:\\proj',
      timestamp: session.from,
      message: { role: 'user', content: 'go' },
    },
    {
      type: 'assistant',
      sessionId: session.sessionId,
      cwd: 'E:\\proj',
      timestamp: session.to,
      requestId: `req_${session.sessionId}`,
      message: {
        id: `msg_${session.sessionId}`,
        role: 'assistant',
        model: 'claude-opus-5',
        content,
        usage: {
          input_tokens: session.inputTokens ?? 1_000_000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  ];
  await fsp.writeFile(
    path.join(dir, `${session.sessionId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  );
}

function task(raw: string, line: number, number?: string, label?: string): Task {
  return {
    number,
    label: label ?? raw,
    state: raw.includes('[x]') ? 'complete' : 'pending',
    line,
    raw,
    indent: 0,
    children: [],
  };
}

function makeChange(id: string, tasks: Task[]): Change {
  const completed = tasks.filter((entry) => entry.state === 'complete').length;
  return {
    id,
    path: `E:\\proj\\openspec\\changes\\${id}`,
    rootPath: 'E:\\proj',
    documents: { proposal: true, design: false, tasks: true, specs: true },
    createdInferred: false,
    tasksPath: `E:\\proj\\openspec\\changes\\${id}\\tasks.md`,
    taskFile: {
      sections: [{ depth: 0, line: 0, tasks }],
      progress: makeProgress(completed, tasks.length),
      all: tasks,
      leaves: tasks,
    },
    undecomposed: false,
    problems: [],
  };
}

const TICKED = '- [x] 1.1 Route reads through the data service';

function historyFor(changeId: string, date: string): ChangeHistory {
  return {
    changeId,
    snapshots: [],
    completions: { [taskKey(TICKED)]: date },
  };
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

test('the layer opens no transcript while it is disabled', async () => {
  await withFixture(async (fixture) => {
    await writeSession(fixture, {
      sessionId: 'session-1',
      from: at(10, 9),
      to: at(10, 17),
      changeId: 'demo-change',
    });

    const index = new TranscriptIndex({ env: fixture.env });
    let scans = 0;
    const realScan = index.scan.bind(index);
    index.scan = (options) => {
      scans++;
      return realScan(options);
    };

    const evidence = await evaluateClaudeEvidence({
      enabled: false,
      change: makeChange('demo-change', []),
      history: undefined,
      index,
    });

    assert.equal(scans, 0);
    assert.equal(index.lastScan, undefined);
    assert.equal(evidence.available, false);
    assert.equal(evidence.reason, 'disabled');
    assert.ok(evidence.reasonText);
    assert.deepEqual(evidence.sessions, []);
    assert.equal(evidence.rollup, undefined);
  });
});

test('a machine with no Claude Code history explains itself', async () => {
  await withFixture(async (fixture) => {
    const bare = path.join(fixture.root, 'bare');
    await fsp.mkdir(bare, { recursive: true });

    const evidence = await evaluateClaudeEvidence({
      enabled: true,
      change: makeChange('demo-change', []),
      history: undefined,
      index: new TranscriptIndex({ env: { HOME: bare, USERPROFILE: bare } }),
    });

    assert.equal(evidence.available, false);
    assert.equal(evidence.reason, 'no-data-directory');
    assert.match(evidence.reasonText ?? '', /Claude Code/);
  });
});

test('a change no transcript mentions reports absence of measurement, not a measured zero', async () => {
  await withFixture(async (fixture) => {
    await writeSession(fixture, {
      sessionId: 'session-1',
      from: at(10, 9),
      to: at(10, 17),
      changeId: 'another-change',
    });

    const evidence = await evaluateClaudeEvidence({
      enabled: true,
      change: makeChange('demo-change', []),
      history: undefined,
      index: new TranscriptIndex({ env: fixture.env }),
    });

    assert.equal(evidence.available, false);
    assert.equal(evidence.reason, 'no-sessions');
    assert.equal(evidence.rollup, undefined);
    assert.deepEqual(evidence.sessions, []);
    assert.deepEqual(evidence.checkedWithoutCode, []);
  });
});

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

test('several bound sessions roll up into one span, cost and file set', async () => {
  await withFixture(async (fixture) => {
    await writeSession(fixture, {
      sessionId: 'session-1',
      from: at(10, 9),
      to: at(10, 17),
      changeId: 'demo-change',
      edits: ['E:\\proj\\src\\a.ts'],
    });
    await writeSession(fixture, {
      sessionId: 'session-2',
      from: at(12, 9),
      to: at(12, 11),
      changeId: 'demo-change',
      edits: ['E:\\proj\\src\\b.ts', 'E:\\proj\\src\\a.ts'],
    });

    const evidence = await evaluateClaudeEvidence({
      enabled: true,
      change: makeChange('demo-change', []),
      history: undefined,
      index: new TranscriptIndex({ env: fixture.env }),
    });

    assert.equal(evidence.available, true);
    assert.equal(evidence.sessions.length, 2);
    const rollup = evidence.rollup;
    assert.ok(rollup);
    assert.equal(rollup.sessions, 2);
    assert.equal(rollup.from.getTime(), Date.parse(at(10, 9)));
    assert.equal(rollup.to.getTime(), Date.parse(at(12, 11)));
    assert.equal(rollup.tokens.input, 2_000_000);
    // Two messages of a million input tokens each, at $5 per million.
    assert.equal(rollup.costUsd, 10);
    assert.deepEqual(rollup.editedFiles, ['E:\\proj\\src\\a.ts', 'E:\\proj\\src\\b.ts']);
    assert.deepEqual(rollup.unpricedModels, []);
  });
});

// ---------------------------------------------------------------------------
// The checked-without-code signal
// ---------------------------------------------------------------------------

test('a task ticked on a day whose only session stayed inside openspec is surfaced', async () => {
  await withFixture(async (fixture) => {
    await writeSession(fixture, {
      sessionId: 'spec-only',
      from: at(14, 9),
      to: at(14, 18),
      changeId: 'demo-change',
      edits: ['E:\\proj\\openspec\\changes\\demo-change\\tasks.md'],
    });

    const change = makeChange('demo-change', [
      task(TICKED, 7, '1.1', 'Route reads through the data service'),
    ]);

    const evidence = await evaluateClaudeEvidence({
      enabled: true,
      change,
      history: historyFor('demo-change', '2026-08-14'),
      index: new TranscriptIndex({ env: fixture.env }),
    });

    assert.equal(evidence.available, true);
    assert.equal(evidence.checkedWithoutCode.length, 1);
    const signal = evidence.checkedWithoutCode[0];
    assert.ok(signal);
    assert.equal(signal.taskKey, taskKey(TICKED));
    assert.equal(signal.line, 7);
    assert.equal(signal.date, '2026-08-14');
    assert.equal(signal.label, '1.1 Route reads through the data service');
    assert.deepEqual(signal.sessionIds, ['spec-only']);
  });
});

test('a session that edited source files on that day produces no signal', async () => {
  await withFixture(async (fixture) => {
    await writeSession(fixture, {
      sessionId: 'coding',
      from: at(14, 9),
      to: at(14, 18),
      changeId: 'demo-change',
      edits: [
        'E:\\proj\\src\\provider\\mod.rs',
        'E:\\proj\\src\\provider\\query.rs',
        'E:\\proj\\openspec\\changes\\demo-change\\tasks.md',
      ],
    });

    const evidence = await evaluateClaudeEvidence({
      enabled: true,
      change: makeChange('demo-change', [
        task(TICKED, 7, '1.1', 'Route reads through the data service'),
      ]),
      history: historyFor('demo-change', '2026-08-14'),
      index: new TranscriptIndex({ env: fixture.env }),
    });

    assert.deepEqual(evidence.checkedWithoutCode, []);
    assert.equal(evidence.rollup?.editedFiles.length, 2);
  });
});

test('one spec-only session does not fire while another that day wrote code', async () => {
  await withFixture(async (fixture) => {
    await writeSession(fixture, {
      sessionId: 'spec-only',
      from: at(14, 9),
      to: at(14, 12),
      changeId: 'demo-change',
      edits: ['E:\\proj\\openspec\\changes\\demo-change\\tasks.md'],
    });
    await writeSession(fixture, {
      sessionId: 'coding',
      from: at(14, 13),
      to: at(14, 18),
      changeId: 'demo-change',
      edits: ['E:\\proj\\src\\provider\\mod.rs'],
    });

    const evidence = await evaluateClaudeEvidence({
      enabled: true,
      change: makeChange('demo-change', [
        task(TICKED, 7, '1.1', 'Route reads through the data service'),
      ]),
      history: historyFor('demo-change', '2026-08-14'),
      index: new TranscriptIndex({ env: fixture.env }),
    });

    assert.deepEqual(evidence.checkedWithoutCode, []);
  });
});

test('a completion date outside every session span is left alone', async () => {
  await withFixture(async (fixture) => {
    await writeSession(fixture, {
      sessionId: 'spec-only',
      from: at(14, 9),
      to: at(14, 18),
      changeId: 'demo-change',
      edits: ['E:\\proj\\openspec\\changes\\demo-change\\tasks.md'],
    });

    const evidence = await evaluateClaudeEvidence({
      enabled: true,
      change: makeChange('demo-change', [
        task(TICKED, 7, '1.1', 'Route reads through the data service'),
      ]),
      history: historyFor('demo-change', '2026-08-20'),
      index: new TranscriptIndex({ env: fixture.env }),
    });

    assert.equal(evidence.available, true);
    assert.deepEqual(evidence.checkedWithoutCode, []);
  });
});

test('a pending task is never a candidate', async () => {
  await withFixture(async (fixture) => {
    await writeSession(fixture, {
      sessionId: 'spec-only',
      from: at(14, 9),
      to: at(14, 18),
      changeId: 'demo-change',
      edits: ['E:\\proj\\openspec\\changes\\demo-change\\tasks.md'],
    });

    const pending = '- [ ] 1.1 Route reads through the data service';
    const evidence = await evaluateClaudeEvidence({
      enabled: true,
      change: makeChange('demo-change', [
        task(pending, 7, '1.1', 'Route reads through the data service'),
      ]),
      history: {
        changeId: 'demo-change',
        snapshots: [],
        completions: { [taskKey(pending)]: '2026-08-14' },
      },
      index: new TranscriptIndex({ env: fixture.env }),
    });

    assert.deepEqual(evidence.checkedWithoutCode, []);
  });
});

test('without history the sessions still show and the signal is explained away', async () => {
  await withFixture(async (fixture) => {
    await writeSession(fixture, {
      sessionId: 'spec-only',
      from: at(14, 9),
      to: at(14, 18),
      changeId: 'demo-change',
      edits: ['E:\\proj\\openspec\\changes\\demo-change\\tasks.md'],
    });

    const evidence = await evaluateClaudeEvidence({
      enabled: true,
      change: makeChange('demo-change', [
        task(TICKED, 7, '1.1', 'Route reads through the data service'),
      ]),
      history: undefined,
      index: new TranscriptIndex({ env: fixture.env }),
    });

    assert.equal(evidence.available, true);
    assert.equal(evidence.sessions.length, 1);
    assert.ok(evidence.rollup);
    assert.equal(evidence.reason, 'no-history');
    assert.ok(evidence.reasonText);
    assert.deepEqual(evidence.checkedWithoutCode, []);
  });
});
