/**
 * Writes invented Claude Code transcripts for the demo workspace.
 *
 * The provenance layer binds a session to a change by finding the text
 * `openspec/changes/<id>` in a transcript, so a demo workspace full of invented
 * change names matches nothing on a real machine and the panel correctly says
 * there is no activity. That is honest but makes a poor screenshot.
 *
 * Copying real transcripts and renaming the changes inside them is not the
 * answer: a transcript is a verbatim record of prompts, file paths and replies,
 * and renaming a few identifiers would leave the rest. So these are written from
 * nothing - invented sessions, invented files, plausible token counts - into a
 * data directory of their own.
 *
 *   node scripts/make-demo-transcripts.ts [workspace] [--force]
 *
 * Then launch the editor with that directory as its Claude Code home, so your
 * own `~/.claude` is never opened:
 *
 *   CLAUDE_CONFIG_DIR=<workspace>/.claude code <workspace>       (bash)
 *   $env:CLAUDE_CONFIG_DIR="<workspace>\.claude"; code <workspace>   (PowerShell)
 *
 * and turn on `openspecLedger.claudeEvidence.enabled`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE = path.resolve(HERE, '..', '..', 'openspec-ledger-demo');

const workspace =
  process.argv[2] && !process.argv[2].startsWith('--')
    ? path.resolve(process.argv[2])
    : DEFAULT_WORKSPACE;
const force = process.argv.includes('--force');

// ---------------------------------------------------------------------------
// The invented sessions
// ---------------------------------------------------------------------------

interface SessionSpec {
  /** Repository directory, relative to the workspace root. */
  repo: string;
  changeId: string;
  /** Local date the session ran. */
  date: string;
  /** Start hour and the minutes it lasted, so the span in the panel is plausible. */
  startHour: number;
  minutes: number;
  model: string;
  /** Assistant turns; each contributes one usage record. */
  turns: number;
  /** Files it edited, relative to the repository. Empty means it touched only the spec. */
  edited: string[];
  /** Rough scale of the turn, which sets the token counts. */
  weight: 'small' | 'medium' | 'large';
}

/**
 * One session that edited nothing outside `openspec/` sits deliberately in this
 * list: it is what raises the checked-without-code signal, and a demo that only
 * shows the happy path would not show the thing the layer exists for.
 */
const SESSIONS: SessionSpec[] = [
  {
    repo: 'services/catalog-service',
    changeId: 'add-variant-pricing',
    date: '2026-03-09',
    startHour: 9,
    minutes: 214,
    model: 'claude-opus-4-5',
    turns: 38,
    weight: 'large',
    edited: ['src/pricing/resolver.rs', 'src/model/variant.rs', 'tests/pricing.rs'],
  },
  {
    repo: 'services/catalog-service',
    changeId: 'add-variant-pricing',
    date: '2026-03-18',
    startHour: 14,
    minutes: 96,
    model: 'claude-sonnet-4-5',
    turns: 17,
    weight: 'medium',
    edited: ['src/api/price.rs', 'tests/api_price.rs'],
  },
  {
    repo: 'services/catalog-service',
    changeId: '2026-07-02-bulk-import-endpoint',
    date: '2026-07-06',
    startHour: 10,
    minutes: 168,
    model: 'claude-opus-4-5',
    turns: 29,
    weight: 'large',
    edited: ['src/import/parser.rs', 'src/import/report.rs', 'src/api/import.rs'],
  },
  {
    repo: 'services/catalog-service',
    changeId: '2026-07-02-bulk-import-endpoint',
    date: '2026-07-08',
    startHour: 16,
    minutes: 41,
    model: 'claude-sonnet-4-5',
    turns: 8,
    weight: 'small',
    // Ticked boxes, wrote no code: this is the signal the layer exists to raise.
    edited: [],
  },
  {
    repo: 'services/catalog-service',
    changeId: 'normalise-category-tree',
    date: '2026-08-27',
    startHour: 11,
    minutes: 132,
    model: 'claude-opus-4-5',
    turns: 24,
    weight: 'medium',
    edited: ['src/model/category.rs', 'src/migration/categories.rs'],
  },
  {
    repo: 'api-gateway',
    changeId: 'rate-limit-per-tenant',
    date: '2026-04-14',
    startHour: 8,
    minutes: 187,
    model: 'claude-opus-4-5',
    turns: 31,
    weight: 'large',
    edited: ['src/limiter/bucket.ts', 'src/limiter/tenant.ts', 'src/middleware/limit.ts'],
  },
  {
    repo: 'api-gateway',
    changeId: '2026-08-30-request-id-propagation',
    date: '2026-09-01',
    startHour: 13,
    minutes: 74,
    model: 'claude-sonnet-4-5',
    turns: 14,
    weight: 'medium',
    edited: ['src/tracing/context.ts', 'src/client/forward.ts'],
  },
  {
    repo: 'services/billing-service',
    changeId: 'invoice-pdf-rendering',
    date: '2026-02-25',
    startHour: 9,
    minutes: 243,
    model: 'claude-opus-4-5',
    turns: 44,
    weight: 'large',
    edited: ['src/render/pdf.py', 'src/render/template.py', 'tests/test_render.py'],
  },
  {
    repo: 'services/billing-service',
    changeId: 'split-tax-calculation',
    date: '2026-09-01',
    startHour: 15,
    minutes: 88,
    model: 'claude-opus-4-5',
    turns: 16,
    weight: 'medium',
    edited: ['src/tax/engine.py'],
  },
  {
    repo: 'services/search-indexer',
    changeId: 'incremental-reindex',
    date: '2026-09-03',
    startHour: 10,
    minutes: 121,
    model: 'claude-opus-4-5',
    turns: 22,
    weight: 'large',
    edited: ['src/index/segment.go', 'src/index/cursor.go'],
  },
  {
    repo: 'web/console-ui',
    changeId: 'theme-tokens',
    date: '2026-04-11',
    startHour: 12,
    minutes: 156,
    model: 'claude-sonnet-4-5',
    turns: 27,
    weight: 'medium',
    edited: ['src/styles/tokens.css', 'src/styles/theme.ts'],
  },
  {
    repo: 'web/console-ui',
    changeId: '2026-08-11-bulk-actions-toolbar',
    date: '2026-08-18',
    startHour: 9,
    minutes: 198,
    model: 'claude-opus-4-5',
    turns: 35,
    weight: 'large',
    edited: ['src/state/selection.ts', 'src/components/Toolbar.tsx'],
  },
  {
    repo: 'web/console-ui',
    changeId: '2026-08-11-bulk-actions-toolbar',
    date: '2026-09-02',
    startHour: 14,
    minutes: 63,
    model: 'claude-sonnet-4-5',
    turns: 11,
    weight: 'small',
    edited: ['src/components/Toolbar.tsx'],
  },
];

/** Token scale per turn. Cache reads dominate, which is what a real session looks like. */
const WEIGHTS = {
  small: { input: 3, output: 640, cacheWrite: 9_400, cacheRead: 46_000 },
  medium: { input: 4, output: 1_180, cacheWrite: 14_800, cacheRead: 84_000 },
  large: { input: 6, output: 1_940, cacheWrite: 21_600, cacheRead: 132_000 },
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Claude Code names a project directory after the working directory, with the
 * separators flattened. The reader does not depend on the shape, but matching it
 * keeps the demo honest about where these files would really sit.
 */
function projectDirName(cwd: string): string {
  return cwd.replace(/[\\/:]+/g, '-').replace(/^-+/, '');
}

/** Deterministic, so re-running produces the same ids and a screenshot still matches. */
function idFrom(seed: string, length: number): string {
  let h = 0x811c9dc5;
  const out: string[] = [];
  for (let i = 0; out.join('').length < length; i++) {
    for (const ch of `${seed}:${i}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out.push(h.toString(16).padStart(8, '0'));
  }
  return out.join('').slice(0, length);
}

function sessionUuid(seed: string): string {
  const hex = idFrom(seed, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function transcriptFor(session: SessionSpec, repoRoot: string): string {
  const sessionId = sessionUuid(`${session.repo}/${session.changeId}/${session.date}`);
  const cwd = repoRoot;
  const changePath = `openspec/changes/${session.changeId}`;
  const scale = WEIGHTS[session.weight];
  const lines: string[] = [];

  const at = (turn: number): string => {
    const start = new Date(`${session.date}T00:00:00Z`);
    start.setUTCHours(session.startHour);
    start.setUTCMinutes(Math.round((session.minutes * turn) / Math.max(1, session.turns)));
    return start.toISOString();
  };

  // The opening prompt is what binds the session to the change.
  lines.push(
    JSON.stringify({
      type: 'user',
      sessionId,
      cwd,
      timestamp: at(0),
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Work on ${changePath}. Read ${changePath}/proposal.md first, then take the next unticked task in ${changePath}/tasks.md.`,
          },
        ],
      },
    }),
  );

  for (let turn = 1; turn <= session.turns; turn++) {
    const messageId = `msg_${idFrom(`${sessionId}:m:${turn}`, 24)}`;
    const requestId = `req_${idFrom(`${sessionId}:r:${turn}`, 24)}`;

    // Edits are spread through the session rather than all at the end.
    // Writes land every third turn, and each one takes the next file rather than
    // the same one:  is zero exactly when a write happens, so
    // indexing by it would have edited the first file over and over.
    const writesNow = session.edited.length > 0 && turn % 3 === 1;
    const edit = session.edited[Math.floor((turn - 1) / 3) % Math.max(1, session.edited.length)];
    const content: unknown[] = [
      { type: 'text', text: `Taking the next task in ${changePath}/tasks.md.` },
    ];
    if (writesNow && edit) {
      content.push({
        type: 'tool_use',
        id: `toolu_${idFrom(`${sessionId}:t:${turn}`, 20)}`,
        name: turn % 2 === 0 ? 'Write' : 'Edit',
        input: {
          file_path: path.join(cwd, edit),
          old_string: '// previous',
          new_string: '// updated',
        },
      });
    }
    // Every session ticks its boxes, which is a write inside openspec/ and must
    // never be counted as source work.
    if (turn === session.turns) {
      content.push({
        type: 'tool_use',
        id: `toolu_${idFrom(`${sessionId}:tick`, 20)}`,
        name: 'Edit',
        input: {
          file_path: path.join(cwd, 'openspec', 'changes', session.changeId, 'tasks.md'),
          old_string: '- [ ]',
          new_string: '- [x]',
        },
      });
    }

    const line = {
      type: 'assistant',
      sessionId,
      cwd,
      timestamp: at(turn),
      requestId,
      message: {
        id: messageId,
        role: 'assistant',
        model: session.model,
        content,
        usage: {
          input_tokens: scale.input,
          output_tokens: scale.output,
          cache_creation_input_tokens: scale.cacheWrite,
          cache_read_input_tokens: scale.cacheRead * turn,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: scale.cacheWrite,
          },
          service_tier: 'standard',
          speed: 'standard',
          inference_geo: 'not_available',
        },
      },
    };
    lines.push(JSON.stringify(line));
    // Streaming repeats the final entry; the reader deduplicates on
    // (message id, request id), and a demo that never exercises that is a demo
    // that would not notice if it broke.
    if (turn % 7 === 0) {
      lines.push(JSON.stringify(line));
    }
  }

  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const exists = await fs
    .stat(workspace)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    console.error(`${workspace} does not exist. Run scripts/make-demo-workspace.ts first.`);
    process.exit(1);
  }

  const home = path.join(workspace, '.claude');
  const projects = path.join(home, 'projects');
  const hasHome = await fs
    .stat(home)
    .then(() => true)
    .catch(() => false);
  if (hasHome && !force) {
    console.error(`${home} already exists. Pass --force to replace it.`);
    process.exit(1);
  }
  if (hasHome) {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  let written = 0;
  for (const session of SESSIONS) {
    const repoRoot = path.join(workspace, ...session.repo.split('/'));
    const dir = path.join(projects, projectDirName(repoRoot));
    await fs.mkdir(dir, { recursive: true });
    const sessionId = sessionUuid(`${session.repo}/${session.changeId}/${session.date}`);
    const file = path.join(dir, `${sessionId}.jsonl`);
    await fs.writeFile(file, transcriptFor(session, repoRoot), 'utf8');
    // The thirty-day skip is real, so a transcript dated months ago must carry a
    // recent modification time or the index would step over it unopened.
    const now = new Date();
    await fs.utimes(file, now, now);
    written += 1;
  }

  const changes = new Set(SESSIONS.map((s) => s.changeId));
  console.log(`Wrote ${written} transcripts covering ${changes.size} changes into ${home}`);
  console.log('\nLaunch the editor with that directory as its Claude Code home:');
  console.log(`  PowerShell:  $env:CLAUDE_CONFIG_DIR="${home}"; code "${workspace}"`);
  console.log(`  bash:        CLAUDE_CONFIG_DIR="${home}" code "${workspace}"`);
  console.log('\nThen turn on openspecLedger.claudeEvidence.enabled. Your own ~/.claude is never');
  console.log('opened while that variable is set, and nothing here came from a real session.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
