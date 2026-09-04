/**
 * Claude Code transcripts as evidence: where they live, what one session did,
 * and which changes it touched.
 *
 * design.md D9: a session is bound to a change when the text
 * `openspec/changes/<id>` appears anywhere in its transcript. Nothing is read
 * until `TranscriptIndex.scan()` is called - not on activation, not during
 * discovery - and what has been read is cached on modification time and size,
 * so the second pass over a ~100 MB corpus costs one `stat` per file (D13).
 *
 * Transcript content never leaves this module. What comes out is aggregates,
 * file paths and change ids; no prompt or response text is retained.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { MessageUsage, SessionSummary, TokenTotals } from '../model/types.ts';
import { normalizePath, pathKey } from '../model/keys.ts';
import type { FileStamp } from '../util/fsx.ts';
import { sameStamp, stamp } from '../util/fsx.ts';
import { log } from '../util/log.ts';
import { calculateMessageCost, isPricedModel } from './pricing.ts';

const MS_PER_DAY = 86_400_000;
const DEFAULT_MAX_AGE_DAYS = 30;

/** The tools whose inputs name a file they wrote. */
const FILE_WRITING_TOOLS = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'str_replace_editor',
]);

/**
 * Both separator forms, case-insensitively, over the raw line.
 *
 * Matching before `JSON.parse` catches a reference wherever it sits - a tool
 * input, a prompt, a file the agent read - and keeps a malformed line useful.
 * A Windows path arrives JSON-escaped as `openspec\\changes\\x`, which is why
 * the separator class is repeated rather than matched once.
 */
const CHANGE_PATH_RE = /openspec[\\/]+changes[\\/]+([A-Za-z0-9][A-Za-z0-9._-]*)/gi;

// ---------------------------------------------------------------------------
// Locating the data directory
// ---------------------------------------------------------------------------

/**
 * The Claude Code data directory: `CLAUDE_CONFIG_DIR` when it names a directory
 * that exists, otherwise `.claude` in the user's home. Undefined when neither
 * is there, which is a legitimate state - an API-key, Bedrock or Vertex sign-in
 * writes no transcripts - and is reported as such rather than as an error.
 *
 * Synchronous by contract: it stats two directories and opens no file.
 */
export function claudeDataDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  if (configured && isExistingDirectory(configured)) {
    return configured;
  }
  const home = homeDirectory(env);
  if (!home) {
    return undefined;
  }
  const dotClaude = path.join(home, '.claude');
  return isExistingDirectory(dotClaude) ? dotClaude : undefined;
}

function isExistingDirectory(target: string): boolean {
  try {
    return fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/**
 * `USERPROFILE` is preferred on Windows because a shell such as Git Bash sets
 * `HOME` to a POSIX path that Node cannot resolve.
 */
function homeDirectory(env: NodeJS.ProcessEnv): string | undefined {
  const candidates =
    process.platform === 'win32' ? [env.USERPROFILE, env.HOME] : [env.HOME, env.USERPROFILE];
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) {
      return candidate;
    }
  }
  const home = os.homedir();
  return home.length > 0 ? home : undefined;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface TranscriptFile {
  path: string;
  /** The file name without its extension, which is how Claude Code names sessions. */
  sessionId: string;
  mtimeMs: number;
  size: number;
}

/**
 * Every `.jsonl` file beneath `projects/`, at any depth. Unreadable directories
 * are stepped over: one project directory the user cannot read must not empty
 * the whole index. Symbolic links are not followed, so no cycle is possible.
 */
export async function listTranscripts(projectsDir: string): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) {
        continue;
      }
      const fileStamp = await stamp(full);
      if (!fileStamp) {
        // Vanished between the listing and the stat, which happens while an agent runs.
        continue;
      }
      found.push({
        path: full,
        sessionId: entry.name.slice(0, -'.jsonl'.length),
        mtimeMs: fileStamp.mtimeMs,
        size: fileStamp.size,
      });
    }
  };

  await walk(projectsDir);
  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}

// ---------------------------------------------------------------------------
// Scanning one file
// ---------------------------------------------------------------------------

/** One summary per session id found in the file. Usually exactly one. */
export interface TranscriptScan {
  sessions: SessionSummary[];
}

/**
 * The session recorded by one transcript: the one whose id matches the file
 * name when it is present, otherwise the first found. Undefined when the file
 * held nothing that could be read as a session.
 */
export async function scanTranscript(file: TranscriptFile): Promise<SessionSummary | undefined> {
  const { sessions } = await scanSessions(file);
  return sessions.find((session) => session.sessionId === file.sessionId) ?? sessions[0];
}

interface SessionBuilder {
  sessionId: string;
  cwd?: string;
  firstMs?: number;
  lastMs?: number;
  models: string[];
  tokens: TokenTotals;
  messageCount: number;
  costUsd: number;
  editedFiles: string[];
  editedKeys: Set<string>;
  /** `pathKey` of the id -> the id as it was written, so the display keeps its casing. */
  changeIds: Map<string, string>;
}

/**
 * Read one transcript line by line.
 *
 * A read stream plus `readline` rather than `readFile`, because the reference
 * corpus is ~100 MB across its files and a cold scan must not hold one of them
 * in memory. A line that does not parse is skipped, not fatal: the last line of
 * a transcript being written right now is routinely half-flushed.
 */
async function scanSessions(file: TranscriptFile, signal?: AbortSignal): Promise<TranscriptScan> {
  const builders = new Map<string, SessionBuilder>();
  /** Streaming repeats entries, so a (message id, request id) pair is counted once per file. */
  const seenMessages = new Set<string>();
  let currentSessionId = file.sessionId;

  const builderFor = (sessionId: string): SessionBuilder => {
    const existing = builders.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: SessionBuilder = {
      sessionId,
      models: [],
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      messageCount: 0,
      costUsd: 0,
      editedFiles: [],
      editedKeys: new Set<string>(),
      changeIds: new Map<string, string>(),
    };
    builders.set(sessionId, created);
    return created;
  };

  let stream;
  try {
    stream = fs.createReadStream(file.path, { encoding: 'utf8' });
  } catch (error) {
    log.warn(`could not open transcript ${file.path}: ${String(error)}`);
    return { sessions: [] };
  }

  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (signal?.aborted) {
        break;
      }
      if (line.length === 0) {
        continue;
      }

      const referenced = changeIdsIn(line);

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Not JSON. Its change references still count, which is why they were
        // taken from the raw text first.
        if (referenced.size > 0) {
          mergeChangeIds(builderFor(currentSessionId), referenced);
        }
        continue;
      }

      const record = asRecord(parsed);
      if (!record) {
        continue;
      }

      const sessionId = asString(record['sessionId']) ?? asString(record['session_id']);
      if (sessionId) {
        currentSessionId = sessionId;
      }
      const builder = builderFor(currentSessionId);
      mergeChangeIds(builder, referenced);

      const cwd = asString(record['cwd']);
      if (cwd && !builder.cwd) {
        builder.cwd = cwd;
      }

      const at = parseTimestamp(record['timestamp']);
      if (at !== undefined) {
        builder.firstMs = builder.firstMs === undefined ? at : Math.min(builder.firstMs, at);
        builder.lastMs = builder.lastMs === undefined ? at : Math.max(builder.lastMs, at);
      }

      const message = asRecord(record['message']);
      if (!message) {
        continue;
      }

      collectEditedFiles(builder, message['content']);

      const rawUsage = asRecord(message['usage']);
      if (!rawUsage) {
        continue;
      }

      const messageId = asString(message['id']) ?? asString(record['uuid']) ?? '';
      const requestId =
        asString(record['requestId']) ?? asString(record['request_id']) ?? 'unknown';
      const dedupeKey = `${messageId}\u0000${requestId}`;
      if (messageId.length > 0 && seenMessages.has(dedupeKey)) {
        continue;
      }
      seenMessages.add(dedupeKey);

      const usage = extractUsage(rawUsage);
      const model =
        asString(message['model']) ?? asString(record['model']) ?? asString(rawUsage['model']);
      if (model && !model.startsWith('<') && !builder.models.includes(model)) {
        builder.models.push(model);
      }

      builder.tokens.input += usage.input_tokens;
      builder.tokens.output += usage.output_tokens;
      builder.tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      builder.tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
      builder.messageCount++;
      // Priced at the moment the message was sent, so an old transcript is
      // costed with the rates that were in force then.
      builder.costUsd += calculateMessageCost(
        usage,
        model,
        at === undefined ? undefined : new Date(at),
      );
    }
  } catch (error) {
    // A truncated or unreadable tail leaves what was already collected standing.
    log.warn(`stopped reading transcript ${file.path}: ${String(error)}`);
  } finally {
    lines.close();
    stream.destroy();
  }

  const fallbackMs = file.mtimeMs;
  // Every builder was created by a line that existed, so all of them are real
  // sessions; a file that yielded none simply held nothing readable.
  const sessions = [...builders.values()].map((builder) => finish(builder, file.path, fallbackMs));
  return { sessions };
}

function finish(builder: SessionBuilder, transcriptPath: string, fallbackMs: number): SessionSummary {
  const firstMs = builder.firstMs ?? fallbackMs;
  const lastMs = builder.lastMs ?? firstMs;
  return {
    sessionId: builder.sessionId,
    transcriptPath,
    cwd: builder.cwd,
    firstActivity: new Date(firstMs),
    lastActivity: new Date(lastMs),
    models: builder.models,
    unpricedModels: builder.models.filter((model) => !isPricedModel(model)),
    tokens: builder.tokens,
    messageCount: builder.messageCount,
    costUsd: Math.round(builder.costUsd * 1_000_000) / 1_000_000,
    editedFiles: builder.editedFiles,
    changeIds: [...builder.changeIds.values()].sort((a, b) => a.localeCompare(b)),
  };
}

function mergeChangeIds(builder: SessionBuilder, referenced: ReadonlyMap<string, string>): void {
  for (const [key, id] of referenced) {
    if (!builder.changeIds.has(key)) {
      builder.changeIds.set(key, id);
    }
  }
}

/** `pathKey` of each id -> the id as written, so binding is case-insensitive where the filesystem is. */
function changeIdsIn(line: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of line.matchAll(CHANGE_PATH_RE)) {
    const id = match[1];
    if (id === undefined) {
      continue;
    }
    const key = pathKey(id);
    if (!found.has(key)) {
      found.set(key, id);
    }
  }
  return found;
}

function collectEditedFiles(builder: SessionBuilder, content: unknown): void {
  if (!Array.isArray(content)) {
    return;
  }
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block || block['type'] !== 'tool_use') {
      continue;
    }
    const name = asString(block['name']);
    if (!name || !FILE_WRITING_TOOLS.has(name.toLowerCase())) {
      continue;
    }
    const input = asRecord(block['input']);
    if (!input) {
      continue;
    }
    const target = asString(input['file_path']) ?? asString(input['notebook_path']);
    if (!target || isInsideOpenSpec(target)) {
      continue;
    }
    const key = pathKey(target);
    if (builder.editedKeys.has(key)) {
      continue;
    }
    builder.editedKeys.add(key);
    builder.editedFiles.push(target);
  }
}

/**
 * Editing the change's own documents is not evidence that the work was done, so
 * anything beneath a directory named `openspec` is left out. The name is folded
 * to lower case everywhere: a repository with an `OpenSpec` directory means the
 * same thing.
 */
function isInsideOpenSpec(target: string): boolean {
  return normalizePath(target)
    .toLowerCase()
    .split('/')
    .some((segment) => segment === 'openspec');
}

/**
 * Normalise one raw `usage` object.
 *
 * Beyond the four counters, current transcripts carry fields that materially
 * change cost: the per-TTL cache split, fast mode, US-only inference and server
 * tool calls.
 */
function extractUsage(raw: Record<string, unknown>): MessageUsage {
  const usage: MessageUsage = {
    input_tokens: asNumber(raw['input_tokens']),
    output_tokens: asNumber(raw['output_tokens']),
    cache_creation_input_tokens: asNumber(raw['cache_creation_input_tokens']),
    cache_read_input_tokens: asNumber(raw['cache_read_input_tokens']),
  };

  const cacheCreation = asRecord(raw['cache_creation']);
  if (cacheCreation) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: asNumber(cacheCreation['ephemeral_5m_input_tokens']),
      ephemeral_1h_input_tokens: asNumber(cacheCreation['ephemeral_1h_input_tokens']),
    };
  }

  const speed = asString(raw['speed']);
  if (speed) {
    usage.speed = speed;
  }
  const geo = asString(raw['inference_geo']);
  if (geo) {
    usage.inference_geo = geo;
  }
  const tier = asString(raw['service_tier']);
  if (tier) {
    usage.service_tier = tier;
  }

  const serverToolUse = asRecord(raw['server_tool_use']);
  if (serverToolUse) {
    usage.server_tool_use = {
      web_search_requests: asNumber(serverToolUse['web_search_requests']),
      web_fetch_requests: asNumber(serverToolUse['web_fetch_requests']),
      code_execution_requests: asNumber(serverToolUse['code_execution_requests']),
    };
  }

  return usage;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseTimestamp(value: unknown): number | undefined {
  const text = asString(value);
  if (!text) {
    return undefined;
  }
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

export interface TranscriptScanResult {
  /** Files read from disk this pass. */
  scanned: number;
  /** Files passed over as too old to be relevant, without being opened. */
  skipped: number;
  /** Files answered from the cache because their stamp had not moved. */
  cached: number;
  /** Set when there is no Claude Code data directory on this machine. */
  unavailable?: 'no-data-directory';
}

export interface TranscriptIndexOptions {
  env?: NodeJS.ProcessEnv;
  /** Transcripts untouched for longer than this are skipped unopened. Default 30. */
  maxAgeDays?: number;
}

export interface TranscriptScanOptions {
  /** Read every transcript regardless of age or cached stamp. */
  fullRescan?: boolean;
  signal?: AbortSignal;
}

interface CacheEntry {
  stamp: FileStamp;
  /** Only sessions bound to at least one change are kept; the rest are never asked for. */
  sessions: SessionSummary[];
}

/**
 * The lazy, cached view over every transcript on this machine.
 *
 * Constructing one touches no disk at all - that is what keeps transcripts off
 * the activation path (D9). `scan()` is the only thing that reads, and two
 * scans never run at once, because one agent reply rewrites a transcript many
 * times a second.
 */
export class TranscriptIndex {
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxAgeDays: number;
  private readonly cache = new Map<string, CacheEntry>();
  private inFlight: Promise<TranscriptScanResult> | undefined;
  /** Identifies the pass that owns `inFlight`, so a later one does not clear it. */
  private scanGeneration = 0;
  private lastScanAt: Date | undefined;

  constructor(options?: TranscriptIndexOptions) {
    this.env = options?.env ?? process.env;
    const requested = options?.maxAgeDays;
    this.maxAgeDays =
      typeof requested === 'number' && requested > 0 ? requested : DEFAULT_MAX_AGE_DAYS;
  }

  /** When the last scan finished; undefined while nothing has been read. */
  get lastScan(): Date | undefined {
    return this.lastScanAt;
  }

  scan(options?: TranscriptScanOptions): Promise<TranscriptScanResult> {
    const full = options?.fullRescan === true;
    if (this.inFlight && !full) {
      // A concurrent caller wants the same answer the running pass will produce.
      return this.inFlight;
    }
    const previous = this.inFlight;
    const generation = ++this.scanGeneration;
    // The in-flight promise is cleared inside the run, before it settles, so a
    // caller that awaits one scan and immediately starts another gets a fresh
    // pass rather than the answer that just came back.
    const run = (async (): Promise<TranscriptScanResult> => {
      if (previous) {
        await previous.catch(() => undefined);
      }
      try {
        return await this.runScan(options);
      } finally {
        if (this.scanGeneration === generation) {
          this.inFlight = undefined;
        }
      }
    })();
    this.inFlight = run;
    return run;
  }

  /**
   * The bound records for one change, earliest first.
   *
   * Identity here is the TRANSCRIPT, not the session id, and that distinction
   * is the whole of this method. Claude Code writes a subagent's work to its
   * own file while stamping it with the PARENT session's id, so on this machine
   * one id covers 321 files. Keying by session id and keeping the longest
   * record - which is what this did - threw away everything the subagents cost
   * and every file they edited: measured against the real corpus, $35 reported
   * against $84 spent, and 35 of 69 edited files lost.
   *
   * The spec asks for summed tokens, summed cost and the union of edited files,
   * so nothing may be discarded. Two records for the same transcript AND the
   * same id are the only pair that can safely merge, and they are merged rather
   * than dropped.
   */
  forChange(changeId: string): SessionSummary[] {
    const wanted = pathKey(changeId);
    const byRecord = new Map<string, SessionSummary>();
    for (const entry of this.cache.values()) {
      for (const session of entry.sessions) {
        if (!session.changeIds.some((id) => pathKey(id) === wanted)) {
          continue;
        }
        const key = `${pathKey(session.transcriptPath)}\u0000${pathKey(session.sessionId)}`;
        const existing = byRecord.get(key);
        byRecord.set(key, existing ? mergeSessions(existing, session) : session);
      }
    }
    return [...byRecord.values()].sort(
      (a, b) => a.firstActivity.getTime() - b.firstActivity.getTime(),
    );
  }

  clear(): void {
    this.cache.clear();
    this.lastScanAt = undefined;
  }

  /** Test seam: how many transcript records the cache is holding. */
  get size(): number {
    return this.cache.size;
  }

  private async runScan(options?: TranscriptScanOptions): Promise<TranscriptScanResult> {
    const started = Date.now();
    const signal = options?.signal;
    const fullRescan = options?.fullRescan === true;

    const dataDirectory = claudeDataDirectory(this.env);
    if (!dataDirectory) {
      return { scanned: 0, skipped: 0, cached: 0, unavailable: 'no-data-directory' };
    }

    const files = await listTranscripts(path.join(dataDirectory, 'projects'));
    const cutoff = started - this.maxAgeDays * MS_PER_DAY;
    const present = new Set<string>();
    let scanned = 0;
    let skipped = 0;
    let cached = 0;

    for (const file of files) {
      if (signal?.aborted) {
        break;
      }
      const key = pathKey(file.path);
      present.add(key);
      const current: FileStamp = { mtimeMs: file.mtimeMs, size: file.size };
      const entry = this.cache.get(key);

      if (!fullRescan && file.mtimeMs < cutoff) {
        // Not opened at all. Anything already cached for it stays valid.
        skipped++;
        continue;
      }
      if (!fullRescan && entry && sameStamp(entry.stamp, current)) {
        cached++;
        continue;
      }

      const { sessions } = await scanSessions(file, signal);
      this.cache.set(key, {
        stamp: current,
        sessions: sessions.filter((session) => session.changeIds.length > 0),
      });
      scanned++;
    }

    if (!signal?.aborted) {
      for (const key of [...this.cache.keys()]) {
        if (!present.has(key)) {
          this.cache.delete(key);
        }
      }
    }

    this.lastScanAt = new Date();
    log.info(
      `transcript scan: ${scanned} read, ${cached} cached, ${skipped} skipped in ${Date.now() - started} ms`,
    );
    return { scanned, skipped, cached };
  }
}

/**
 * Combine two records of the same transcript.
 *
 * Only reached when one file yields two builders for the same session id, which
 * the reader avoids but the format does not forbid. Summing rather than picking
 * is what the change-level rollup requires: the spec asks for summed tokens,
 * a summed cost and the union of edited files.
 */
function mergeSessions(a: SessionSummary, b: SessionSummary): SessionSummary {
  return {
    ...a,
    firstActivity: a.firstActivity <= b.firstActivity ? a.firstActivity : b.firstActivity,
    lastActivity: a.lastActivity >= b.lastActivity ? a.lastActivity : b.lastActivity,
    models: unique([...a.models, ...b.models]),
    unpricedModels: unique([...a.unpricedModels, ...b.unpricedModels]),
    tokens: {
      input: a.tokens.input + b.tokens.input,
      output: a.tokens.output + b.tokens.output,
      cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite,
      cacheRead: a.tokens.cacheRead + b.tokens.cacheRead,
    },
    messageCount: a.messageCount + b.messageCount,
    costUsd: a.costUsd + b.costUsd,
    editedFiles: unique([...a.editedFiles, ...b.editedFiles]),
    changeIds: unique([...a.changeIds, ...b.changeIds]),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
