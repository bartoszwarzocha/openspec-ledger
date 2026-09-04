/**
 * Root discovery through the editor's own file index (design.md D2).
 *
 * `findFiles` searches only inside the open workspace folders, which is exactly
 * the half of the problem it is used for here; `search.ts` covers the rest.
 *
 * This is the one file in `discovery/` that imports `vscode`, so everything
 * downstream of it stays testable outside an extension host.
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { pathKey } from '../model/keys.ts';
import { log } from '../util/log.ts';
import { DEFAULT_EXCLUDED_DIRS, type RootCandidate } from './search.ts';

/**
 * Cap on the second pass. One hit is enough to identify a root, but the glob
 * matches every file in every change, so an unbounded search would page in a
 * whole repository's worth of paths to learn one fact per root.
 */
const CHANGES_MAX_RESULTS = 5000;

const CONFIG_GLOB = '**/openspec/config.yaml';
const CHANGES_GLOB = '**/openspec/changes/**';
const ANY_FILE_GLOB = '**/openspec/*';

export function createWorkspaceSearcher(): (signal?: AbortSignal) => Promise<RootCandidate[]> {
  return (signal) => searchWorkspace(signal);
}

async function searchWorkspace(signal?: AbortSignal): Promise<RootCandidate[]> {
  const exclude = buildExclude();
  const source = new vscode.CancellationTokenSource();
  const onAbort = (): void => source.cancel();
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) {
    source.cancel();
  }

  const found = new Map<string, RootCandidate>();
  try {
    for (const uri of await findFiles(CONFIG_GLOB, exclude, undefined, source.token)) {
      const openspecPath = path.dirname(uri.fsPath);
      found.set(pathKey(openspecPath), { openspecPath, hasConfig: true });
    }

    // Second pass for the root that carries no `config.yaml` - a hand-made
    // layout, or a Stores-style planning repository (design.md D14).
    for (const uri of await findFiles(CHANGES_GLOB, exclude, CHANGES_MAX_RESULTS, source.token)) {
      const openspecPath = openspecDirectoryOf(uri.fsPath);
      if (openspecPath === undefined || found.has(pathKey(openspecPath))) {
        continue;
      }
      found.set(pathKey(openspecPath), { openspecPath, hasConfig: false });
    }

    // Third pass for the same root before any change has been written into it:
    // `changes/` is there but empty, so the second pass has no file to match,
    // while `project.md` or anything else beside it names the directory.
    // A root whose `openspec` directory holds no file at all stays invisible to
    // the file index - `findFiles` finds files - and only the walk in
    // `search.ts` can reach it.
    for (const uri of await findFiles(ANY_FILE_GLOB, exclude, undefined, source.token)) {
      const openspecPath = openspecDirectoryOf(uri.fsPath);
      if (openspecPath === undefined || found.has(pathKey(openspecPath))) {
        continue;
      }
      found.set(pathKey(openspecPath), { openspecPath, hasConfig: false });
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    source.dispose();
  }

  return [...found.values()];
}

async function findFiles(
  include: string,
  exclude: string | null,
  maxResults: number | undefined,
  token: vscode.CancellationToken,
): Promise<readonly vscode.Uri[]> {
  try {
    return await vscode.workspace.findFiles(include, exclude, maxResults, token);
  } catch (error) {
    // A failed search yields no roots from this pass; the other pass and the
    // configured roots still stand.
    log.error(`Searching the open folders for ${include} failed`, error);
    return [];
  }
}

/**
 * `.../openspec/changes/add-a-thing/tasks.md` -> `.../openspec`.
 *
 * The outermost `openspec` directory wins, matching the filesystem walk, which
 * treats such a directory as a leaf and so never reports a second root nested
 * inside a change. The last segment is the file's own name, so a file named
 * `openspec` does not stand in for a directory.
 */
function openspecDirectoryOf(filePath: string): string | undefined {
  const segments = filePath.split(/[\\/]/);
  for (let index = 0; index + 1 < segments.length; index++) {
    if (segments[index]?.toLowerCase() === 'openspec') {
      return segments.slice(0, index + 1).join(path.sep);
    }
  }
  return undefined;
}

/**
 * The exclude argument *replaces* the editor's defaults rather than adding to
 * them, so honouring `files.exclude` and `search.exclude` means reading both
 * settings and merging them with this extension's own list into one glob.
 *
 * Only entries set to `true` are taken: a `{ "when": ... }` sibling condition is
 * not something a root search can evaluate.
 */
function buildExclude(): string | null {
  const patterns = new Set<string>();
  for (const dir of DEFAULT_EXCLUDED_DIRS) {
    patterns.add(`**/${dir}/**`);
  }

  for (const section of ['files', 'search'] as const) {
    const configured = vscode.workspace
      .getConfiguration(section)
      .get<Record<string, unknown>>('exclude');
    if (!configured) {
      continue;
    }
    for (const [pattern, value] of Object.entries(configured)) {
      if (value !== true) {
        continue;
      }
      // The union is a single brace group, which a pattern of its own with a
      // comma in it would split into two wrong halves.
      if (pattern.includes(',')) {
        log.warn(`Exclude pattern skipped because it contains a comma: ${pattern}`);
        continue;
      }
      patterns.add(pattern);
    }
  }

  const list = [...patterns];
  if (list.length === 0) {
    return null;
  }
  return list.length === 1 ? (list[0] ?? null) : `{${list.join(',')}}`;
}
