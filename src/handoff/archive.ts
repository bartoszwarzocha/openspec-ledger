/**
 * Archiving a completed change.
 *
 * `openspec archive <name>` is documented as archiving the change *and updating
 * the main specs*: it folds the change's spec deltas into `openspec/specs/`.
 * Moving the directory from here would skip that and leave the project's spec
 * state wrong in a way nothing would report. So this file never touches the
 * filesystem - it hands the documented command to a terminal and stops there.
 *
 * The line is written without a newline, exactly like a task handoff (D12): the
 * user reads the command and presses Enter.
 */

import * as vscode from 'vscode';
import { describeError, log } from '../util/log.ts';
import { archiveChainCommandLine, archiveCommandLine } from './target.ts';

export { archiveCommandLine, archiveChainCommandLine, DEFAULT_ARCHIVE_COMMAND } from './target.ts';

/**
 * Deliberately not the handoff terminal: a session already running `claude`
 * would read this line as a prompt rather than run it.
 */
const TERMINAL_NAME = 'OpenSpec archive';

export interface ArchiveRequest {
  /** Working directory for the command: the directory that contains `openspec`. */
  rootPath: string;
  changeId: string;
  /** `openspecLedger.archive.command`; blank falls back to the default. */
  command: string;
}

/**
 * Offer the archive command in a terminal.
 *
 * `started` says the line is sitting in a terminal awaiting Enter - not that
 * anything has been archived. Nothing here can know that: the command has not
 * run yet, and it is `openspec` that decides whether it succeeds.
 */
export async function archiveChange(
  request: ArchiveRequest,
): Promise<{ started: boolean; reason?: string }> {
  const changeId = request.changeId.trim();
  if (changeId === '') {
    return { started: false, reason: 'No change was named.' };
  }

  const line = archiveCommandLine(request.command, changeId);
  try {
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      cwd: request.rootPath,
    });
    // Focus, not just reveal: the user is the one who presses Enter.
    terminal.show();
    // `false` withholds the newline, so the command sits there for review.
    terminal.sendText(line, false);
    log.info(`archive: offered "${line}" in ${request.rootPath}`);
    return { started: true };
  } catch (error) {
    const reason = `No terminal could be opened (${describeError(error)}).`;
    log.warn(`archive: ${reason}`);
    return { started: false, reason };
  }
}

export interface ArchiveManyRequest {
  rootPath: string;
  changeIds: readonly string[];
  command: string;
}

/**
 * Offer several archives at once, as one chained command in one terminal.
 *
 * Grouped by root by the caller, because `openspec archive` reads the project it
 * is standing in. Still nothing runs: the chain is written without a newline and
 * waits for the user, who can read the whole list before committing to it.
 */
export async function archiveChanges(
  request: ArchiveManyRequest,
): Promise<{ started: boolean; reason?: string }> {
  const line = archiveChainCommandLine(request.command, request.changeIds);
  if (line === '') {
    return { started: false, reason: 'No change was named.' };
  }

  try {
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      cwd: request.rootPath,
    });
    terminal.show();
    terminal.sendText(line, false);
    log.info(`archive: offered ${request.changeIds.length} archive(s) in ${request.rootPath}`);
    return { started: true };
  } catch (error) {
    const reason = `No terminal could be opened (${describeError(error)}).`;
    log.warn(`archive: ${reason}`);
    return { started: false, reason };
  }
}
