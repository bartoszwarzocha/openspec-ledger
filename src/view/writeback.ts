/**
 * The extension's only write: one checkbox marker in one line of `tasks.md`
 * (design.md D11).
 *
 * The line is re-read and compared before anything is applied. In a workspace
 * where an agent edits the same file, the file having moved underneath is the
 * normal case, so a mismatch is a routine outcome rather than an error.
 */

import * as vscode from 'vscode';
import type { TaskState } from '../model/types.ts';
import { toggleMarker } from '../model/parser.ts';
import { log } from '../util/log.ts';

export interface ToggleRequest {
  tasksPath: string;
  /** One-based line, as recorded by the parser. */
  line: number;
  /** The verbatim line text captured at parse time. */
  expectedRaw: string;
  next: TaskState;
}

export type ToggleOutcome =
  | { ok: true; newRaw: string }
  | { ok: false; reason: 'mismatch' | 'missing-line' | 'not-a-task' | 'edit-failed' };

/**
 * Whether the line on disk is still the line that was parsed.
 *
 * Trailing whitespace is ignored: a `\r` survives or is lost depending on how
 * the file was split, and a trim-on-save does not make it a different task.
 * Everything else must match exactly - that is the whole point of the check.
 */
export function linesMatch(a: string, b: string): boolean {
  return a.replace(/\s+$/, '') === b.replace(/\s+$/, '');
}

export interface CharacterSpan {
  /** Zero-based column of the first differing character. */
  start: number;
  /** Zero-based column after the last differing character. */
  end: number;
  text: string;
}

/**
 * The narrowest span that turns `before` into `after`.
 *
 * Diffing rather than recomputing the marker column keeps the edit to the
 * marker characters themselves whatever form the parser chose for them, and
 * leaves indentation, numbering and task text untouched by construction.
 * Undefined when the two are already identical.
 */
export function differingSpan(before: string, after: string): CharacterSpan | undefined {
  if (before === after) {
    return undefined;
  }
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    start: prefix,
    end: before.length - suffix,
    text: after.slice(prefix, after.length - suffix),
  };
}

export async function applyToggle(request: ToggleRequest): Promise<ToggleOutcome> {
  const uri = vscode.Uri.file(request.tasksPath);

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    log.error(`could not open ${request.tasksPath} to toggle a task`, error);
    return { ok: false, reason: 'edit-failed' };
  }

  const index = request.line - 1;
  if (index < 0 || index >= document.lineCount) {
    log.warn(`line ${request.line} is no longer inside ${request.tasksPath}`);
    return { ok: false, reason: 'missing-line' };
  }

  const current = document.lineAt(index).text;
  if (!linesMatch(current, request.expectedRaw)) {
    log.info(`line ${request.line} of ${request.tasksPath} changed since it was read`);
    return { ok: false, reason: 'mismatch' };
  }

  const newRaw = toggleMarker(current, request.next);
  if (newRaw === undefined) {
    return { ok: false, reason: 'not-a-task' };
  }

  const span = differingSpan(current, newRaw);
  if (!span) {
    // Already in the requested state; the caller's view was simply behind.
    return { ok: true, newRaw };
  }

  // A document we did not dirty is saved again below, so the file on disk keeps
  // matching what the tree shows - an agent reading `tasks.md` sees the tick.
  const wasDirty = document.isDirty;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(index, span.start, index, span.end), span.text);

  let applied = false;
  try {
    applied = await vscode.workspace.applyEdit(edit);
  } catch (error) {
    log.error(`edit of ${request.tasksPath} failed`, error);
    return { ok: false, reason: 'edit-failed' };
  }
  if (!applied) {
    log.warn(`the editor refused the toggle of line ${request.line} in ${request.tasksPath}`);
    return { ok: false, reason: 'edit-failed' };
  }

  if (!wasDirty && !(await document.save())) {
    // The edit is in the buffer and undoable; only the save did not happen.
    log.warn(`toggled line ${request.line} but could not save ${request.tasksPath}`);
  }

  return { ok: true, newRaw };
}
