/**
 * Reading one change directory off disk.
 *
 * Everything here is deliberately forgiving: a change directory is written by
 * hand and by agents, it can vanish between being listed and being read, and a
 * root holds up to 33 of them. A document that cannot be read appends to
 * `Change.problems` and the change is still reported - only cancellation
 * escapes as an exception.
 */

import * as path from 'node:path';

import type { Change, ChangeDocuments, OpenSpecRoot, ParsedTaskFile } from './types.ts';
import { emptyProgress, pathKey } from './keys.ts';
import { parseTasks } from './parser.ts';
import * as fsx from '../util/fsx.ts';
import type { FileStamp } from '../util/fsx.ts';
import { parseYamlDate, readTopLevelScalars } from '../util/yaml.ts';
import type { YamlScalars } from '../util/yaml.ts';

const META_FILE = '.openspec.yaml';
const TASKS_FILE = 'tasks.md';
const PROPOSAL_FILE = 'proposal.md';
const DESIGN_FILE = 'design.md';
const SPECS_DIR = 'specs';

/** Directories under `changes/` that are not themselves changes. */
const ARCHIVE_DIR = 'archive';

interface CacheEntry {
  stamp: FileStamp;
  value: unknown;
}

/**
 * Parsed files kept across rebuilds, keyed by absolute path (design.md D13).
 *
 * A cached value is handed back only while the file's modification time and
 * size are both unchanged, so a rebuild after an unrelated edit reads nothing.
 * Values are shared between rebuilds and must be treated as read-only by
 * callers.
 */
export class FileCache {
  private readonly entries = new Map<string, CacheEntry>();

  /**
   * The cached value for `filePath`, or whatever `read` produces when the file
   * is new or has moved on. `read` is a parameter rather than a method so one
   * cache can hold task files and metadata side by side.
   */
  async load<T>(
    filePath: string,
    read: (filePath: string) => Promise<T | undefined>,
  ): Promise<T | undefined> {
    const key = pathKey(filePath);
    const current = await fsx.stamp(filePath);
    if (current === undefined) {
      this.entries.delete(key);
      return undefined;
    }
    const entry = this.entries.get(key);
    if (entry !== undefined && fsx.sameStamp(entry.stamp, current)) {
      return entry.value as T;
    }
    const value = await read(filePath);
    if (value === undefined) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.set(key, { stamp: current, value });
    return value;
  }

  /** Forget one file, or every file beneath it when a directory is named. */
  invalidate(filePath: string): void {
    const key = pathKey(filePath);
    this.entries.delete(key);
    const prefix = `${key}/`;
    for (const existing of this.entries.keys()) {
      if (existing.startsWith(prefix)) {
        this.entries.delete(existing);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface ReadChangeOptions {
  tabWidth?: number;
  cache?: FileCache;
  signal?: AbortSignal;
}

/** Immediate subdirectories of `openspec/changes/`, sorted, without `archive`. */
export async function listChangeIds(root: OpenSpecRoot): Promise<string[]> {
  const dir = path.join(root.openspecPath, 'changes');
  const names = await fsx.listDirectories(dir);
  // Case-insensitively, because on Windows and macOS `Archive` is the same directory.
  return names.filter((name) => name.toLowerCase() !== ARCHIVE_DIR);
}

export async function readChange(
  root: OpenSpecRoot,
  changeId: string,
  options: ReadChangeOptions = {},
): Promise<Change> {
  options.signal?.throwIfAborted();

  const dir = path.join(root.openspecPath, 'changes', changeId);
  const problems: string[] = [];
  const [files, directories] = await Promise.all([fsx.listFiles(dir), fsx.listDirectories(dir)]);

  const documents: ChangeDocuments = {
    proposal: files.includes(PROPOSAL_FILE),
    design: files.includes(DESIGN_FILE),
    tasks: files.includes(TASKS_FILE),
    specs: directories.includes(SPECS_DIR),
  };

  if (files.length === 0 && directories.length === 0 && !(await fsx.isDirectory(dir))) {
    problems.push('the change directory could not be read');
  }

  const change: Change = {
    id: changeId,
    path: dir,
    rootPath: root.path,
    documents,
    createdInferred: false,
    // D5: an absent task list is a state of its own, not zero progress.
    undecomposed: !documents.tasks,
    problems,
  };

  if (files.includes(META_FILE)) {
    const meta = await readMetadata(path.join(dir, META_FILE), options.cache, problems);
    if (meta !== undefined) {
      const schema = meta.values.get('schema');
      if (schema !== undefined && schema.length > 0) {
        change.schema = schema;
      }
      if (meta.error !== undefined) {
        problems.push(`${META_FILE} could not be read as YAML: ${meta.error}`);
      }
      const declared = meta.values.get('created');
      const parsed = parseYamlDate(declared);
      if (parsed !== undefined) {
        change.created = parsed;
      } else if (declared !== undefined) {
        problems.push(
          `${META_FILE} has created: ${declared}, which is not a date this reads; using file times instead`,
        );
      }
    }
  }

  if (change.created === undefined) {
    const inferred = await earliestDocumentTime(dir, files);
    if (inferred !== undefined) {
      change.created = inferred;
      change.createdInferred = true;
    }
  }

  if (documents.tasks) {
    const tasksPath = path.join(dir, TASKS_FILE);
    change.tasksPath = tasksPath;
    change.taskFile = await readTaskFile(tasksPath, options, problems);
  }

  return change;
}

// ---------------------------------------------------------------------------

async function readMetadata(
  file: string,
  cache: FileCache | undefined,
  problems: string[],
): Promise<YamlScalars | undefined> {
  const read = async (target: string): Promise<YamlScalars | undefined> => {
    const text = await fsx.readTextSafe(target);
    return text === undefined ? undefined : readTopLevelScalars(text);
  };
  const scalars = cache ? await cache.load(file, read) : await read(file);
  if (scalars === undefined) {
    problems.push(`${META_FILE} was listed but could not be opened`);
  }
  return scalars;
}

async function readTaskFile(
  file: string,
  options: ReadChangeOptions,
  problems: string[],
): Promise<ParsedTaskFile> {
  const read = async (target: string): Promise<ParsedTaskFile | undefined> => {
    const text = await fsx.readTextSafe(target);
    return text === undefined ? undefined : parseTasks(text, { tabWidth: options.tabWidth });
  };
  const parsed = options.cache ? await options.cache.load(file, read) : await read(file);
  if (parsed !== undefined) {
    // What the parser stepped over silently would otherwise leave a change
    // looking further along than its file says it is.
    for (const problem of parsed.problems ?? []) {
      problems.push(`${TASKS_FILE}: ${problem}`);
    }
    return parsed;
  }
  problems.push(`${TASKS_FILE} was listed but could not be opened, so no tasks are shown`);
  return { sections: [], progress: emptyProgress(), all: [], leaves: [] };
}

/**
 * Earliest modification time among the change's own documents, used when
 * `.openspec.yaml` declares no creation date.
 *
 * The `specs/` tree is not walked: a change is created with its metadata and
 * proposal, so those carry the earlier time, and walking would cost a readdir
 * per capability on every rebuild.
 */
async function earliestDocumentTime(dir: string, files: readonly string[]): Promise<Date | undefined> {
  const known = [META_FILE, PROPOSAL_FILE, DESIGN_FILE, TASKS_FILE].filter((name) =>
    files.includes(name),
  );
  const stats = await Promise.all(known.map((name) => fsx.statSafe(path.join(dir, name))));

  let earliest: number | undefined;
  for (const entry of stats) {
    if (entry !== undefined && (earliest === undefined || entry.mtimeMs < earliest)) {
      earliest = entry.mtimeMs;
    }
  }
  if (earliest === undefined) {
    // A change that is only a `specs/` tree still has a directory time.
    earliest = (await fsx.statSafe(dir))?.mtimeMs;
  }
  return earliest === undefined ? undefined : new Date(earliest);
}
