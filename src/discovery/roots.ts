/**
 * From candidate `openspec` directories to the root list the rest of the
 * extension works from.
 *
 * The two searches - the editor's index (design.md D2) and the filesystem walk
 * over `openspecLedger.additionalRoots` - only propose. Every candidate is
 * re-checked on disk here, because a search index can be stale and a root
 * accepted on a stale hit would show up as an empty, unexplained tree node.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { isPathInside, normalizePath, pathKey, pathsEqual } from '../model/keys.ts';
import type { OpenSpecRoot } from '../model/types.ts';
import { isDirectory, isFile, readTextSafe } from '../util/fsx.ts';
import { log } from '../util/log.ts';
import { readTopLevelScalars } from '../util/yaml.ts';
import { searchFilesystem, type RootCandidate } from './search.ts';

export interface DiscoveryInput {
  /** Absolute paths of the open folders. Empty is a normal state, not an error. */
  workspaceFolders: readonly string[];
  /** Raw `openspecLedger.additionalRoots` value. */
  additionalRoots: readonly string[];
  /** Injected so discovery runs without an extension host; omitted means no workspace search. */
  searchWorkspace?: (signal?: AbortSignal) => Promise<RootCandidate[]>;
  signal?: AbortSignal;
  /** Called once per configured path that is not a directory on disk. */
  onMissingRoot?: (path: string) => void;
}

interface Candidate {
  openspecPath: string;
  fromSettings: boolean;
}

const CONFIG_FILE = 'config.yaml';
const CHANGES_DIR = 'changes';

export async function discoverRoots(input: DiscoveryInput): Promise<OpenSpecRoot[]> {
  return log.time('Root discovery', () => discover(input));
}

async function discover(input: DiscoveryInput): Promise<OpenSpecRoot[]> {
  // The two searches touch different parts of the filesystem, so they overlap
  // rather than queue - discovery has a one-second budget (design.md D13).
  const [fromWorkspace, fromSettings] = await Promise.all([
    runWorkspaceSearch(input),
    runSettingsSearch(input),
  ]);

  const candidates = new Map<string, Candidate>();
  for (const found of fromWorkspace) {
    candidates.set(pathKey(found.openspecPath), {
      openspecPath: found.openspecPath,
      fromSettings: false,
    });
  }
  for (const found of fromSettings) {
    const key = pathKey(found.openspecPath);
    // A root reachable from an open folder stays a workspace root even when the
    // setting names it too: `fromSettings` records where the tree groups it.
    if (candidates.has(key)) {
      continue;
    }
    candidates.set(key, { openspecPath: found.openspecPath, fromSettings: true });
  }

  if (input.signal?.aborted) {
    return [];
  }

  const folders = input.workspaceFolders.map((folder) => path.resolve(folder));
  const built = await Promise.all(
    [...candidates.values()].map((candidate) => buildRoot(candidate, folders)),
  );
  const roots = built.filter((root): root is OpenSpecRoot => root !== undefined);

  roots.sort(
    (a, b) =>
      a.label.localeCompare(b.label) ||
      pathKey(a.openspecPath).localeCompare(pathKey(b.openspecPath)),
  );

  log.info(`Discovered ${roots.length} openspec ${roots.length === 1 ? 'root' : 'roots'}`);
  return roots;
}

/**
 * Read `config.yaml` for the two facts the extension uses: that it is there,
 * and its `schema`.
 *
 * A file that will not parse keeps its root. The tree exists to show work in
 * progress, and a configuration being edited is exactly when its root should
 * still be visible; the failure travels along as `configError`.
 */
export async function readRootConfig(
  openspecPath: string,
): Promise<Pick<OpenSpecRoot, 'schema' | 'hasConfig' | 'configError'>> {
  const configPath = path.join(openspecPath, CONFIG_FILE);
  if (!(await isFile(configPath))) {
    return { hasConfig: false };
  }

  const text = await readTextSafe(configPath);
  if (text === undefined) {
    return { hasConfig: true, configError: `${CONFIG_FILE} could not be read.` };
  }

  const parsed = readTopLevelScalars(text);
  const result: Pick<OpenSpecRoot, 'schema' | 'hasConfig' | 'configError'> = { hasConfig: true };

  const schema = parsed.values.get('schema');
  if (schema !== undefined && schema.length > 0) {
    result.schema = schema;
  }
  if (parsed.error !== undefined) {
    result.configError = `${CONFIG_FILE} could not be read as YAML: ${parsed.error}`;
  }
  return result;
}

async function runWorkspaceSearch(input: DiscoveryInput): Promise<RootCandidate[]> {
  if (!input.searchWorkspace) {
    return [];
  }
  try {
    return await input.searchWorkspace(input.signal);
  } catch (error) {
    // One failing search must not empty a tree the settings roots could still fill.
    log.error('Searching the open folders for openspec roots failed', error);
    return [];
  }
}

async function runSettingsSearch(input: DiscoveryInput): Promise<RootCandidate[]> {
  const dirs: string[] = [];
  const seen = new Set<string>();

  for (const raw of input.additionalRoots) {
    if (raw.trim().length === 0) {
      continue;
    }
    const resolved = resolveConfiguredPath(raw, input.workspaceFolders);
    if (resolved === undefined) {
      reportMissing(input, raw.trim());
      continue;
    }
    if (seen.has(pathKey(resolved))) {
      continue;
    }
    seen.add(pathKey(resolved));

    if (!(await isDirectory(resolved))) {
      reportMissing(input, resolved);
      continue;
    }
    dirs.push(resolved);
  }

  if (dirs.length === 0) {
    return [];
  }
  return searchFilesystem(dirs, { signal: input.signal });
}

/**
 * A configured path that is not there is a setting to correct, not a failure.
 *
 * The spec asks for one line per missing path, so a caller that takes the
 * callback owns the wording; the log is what is left when nobody does.
 */
function reportMissing(input: DiscoveryInput, target: string): void {
  if (input.onMissingRoot) {
    input.onMissingRoot(target);
    return;
  }
  log.warn(`Configured additional root was not found: ${target}`);
}

function resolveConfiguredPath(raw: string, folders: readonly string[]): string | undefined {
  const trimmed = raw.trim();
  const home = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\');
  const expanded = home ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;

  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  // The setting asks for absolute paths. A relative one is read against the
  // first open folder, the only base the user could have meant; with no folder
  // open there is no such base and the path is reported as missing.
  const base = folders[0];
  return base === undefined ? undefined : path.resolve(base, expanded);
}

async function buildRoot(
  candidate: Candidate,
  folders: readonly string[],
): Promise<OpenSpecRoot | undefined> {
  const openspecPath = path.resolve(candidate.openspecPath);
  const [config, hasChanges] = await Promise.all([
    readRootConfig(openspecPath),
    isDirectory(path.join(openspecPath, CHANGES_DIR)),
  ]);

  if (!config.hasConfig && !hasChanges) {
    return undefined;
  }

  const rootPath = path.dirname(openspecPath);
  const workspaceFolder = containingFolder(openspecPath, folders);

  const root: OpenSpecRoot = {
    path: rootPath,
    openspecPath,
    label: labelFor(rootPath, workspaceFolder),
    hasConfig: config.hasConfig,
    fromSettings: candidate.fromSettings,
  };
  if (workspaceFolder !== undefined) {
    root.workspaceFolder = workspaceFolder;
  }
  if (config.schema !== undefined) {
    root.schema = config.schema;
  }
  if (config.configError !== undefined) {
    root.configError = config.configError;
  }
  return root;
}

/** The innermost open folder containing the root, for nested or overlapping folders. */
function containingFolder(openspecPath: string, folders: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const folder of folders) {
    if (!isPathInside(openspecPath, folder)) {
      continue;
    }
    if (best === undefined || folder.length > best.length) {
      best = folder;
    }
  }
  return best;
}

/**
 * What the tree shows for a root.
 *
 * The path relative to the open folder is what tells nine sibling repositories
 * apart; the folder's own name reads better than an empty string when the root
 * sits at its top; and a root from the setting has no folder to be relative to,
 * so it is named after its own directory.
 */
function labelFor(rootPath: string, workspaceFolder: string | undefined): string {
  if (workspaceFolder !== undefined) {
    if (pathsEqual(rootPath, workspaceFolder)) {
      return path.basename(workspaceFolder) || normalizePath(workspaceFolder);
    }
    const relative = path.relative(workspaceFolder, rootPath);
    if (relative.length > 0 && !relative.startsWith('..')) {
      return normalizePath(relative);
    }
  }
  return path.basename(rootPath) || normalizePath(rootPath);
}
