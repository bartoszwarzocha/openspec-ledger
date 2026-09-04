/**
 * Delivery of a handoff prompt to the editor's chat.
 *
 * design.md D12 rejected the chat API as the *default* because it addresses
 * Copilot rather than Claude Code, and that reasoning still holds. It was never
 * a reason to leave a reader who has only Copilot with a command that appears
 * to do nothing, so chat is offered as a target the user chooses.
 *
 * The rule the terminal path follows holds here too (D12): the prompt is typed,
 * not sent. The user reads it and presses Enter.
 */

import * as vscode from 'vscode';
import { describeError, log } from '../util/log.ts';

/** The documented entry point. Its presence is checked, never assumed. */
const CHAT_OPEN_COMMAND = 'workbench.action.chat.open';

/**
 * `isPartialQuery` is the flag that leaves the prompt in the chat input instead
 * of sending it. Hosts older than this read the same call as "ask this now",
 * and submitting a prompt the user has not read is the one outcome worth
 * refusing outright - the clipboard is better. The extension's own engine floor
 * is far above 1.86, so this only ever fires on a fork reporting an older base.
 */
const MIN_PARTIAL_QUERY_VERSION = [1, 86] as const;

/** True only when a prompt can be placed in chat *and* left unsent. */
export async function isChatAvailable(): Promise<boolean> {
  return (await unavailableReason()) === undefined;
}

/**
 * Open chat with the prompt typed into it.
 *
 * `reason` is a sentence for the user, written to follow whatever the caller
 * says about its own fallback, so it states the fact and claims no action.
 */
export async function sendToChat(prompt: string): Promise<{ ok: boolean; reason?: string }> {
  const unavailable = await unavailableReason();
  if (unavailable !== undefined) {
    log.info(`handoff: chat is not usable here. ${unavailable}`);
    return { ok: false, reason: unavailable };
  }

  try {
    await vscode.commands.executeCommand(CHAT_OPEN_COMMAND, {
      query: prompt,
      isPartialQuery: true,
    });
    log.info('handoff: the prompt was placed in the chat input, unsent');
    return { ok: true };
  } catch (error) {
    const reason = `The chat panel did not accept the prompt (${describeError(error)}).`;
    log.warn(`handoff: ${reason}`);
    return { ok: false, reason };
  }
}

/** The user-facing sentence explaining why chat cannot be used, or undefined. */
async function unavailableReason(): Promise<string | undefined> {
  if (!supportsPartialQuery()) {
    return 'This editor would send the prompt to chat before you could read it.';
  }
  if (!(await hasChatCommand())) {
    return 'No chat panel is available in this editor.';
  }
  return undefined;
}

/**
 * A missing command means chat is not installed, which is an ordinary state for
 * this host and not an error to report.
 */
async function hasChatCommand(): Promise<boolean> {
  try {
    const commands = await vscode.commands.getCommands(true);
    return commands.includes(CHAT_OPEN_COMMAND);
  } catch (error) {
    // A host that cannot list its own commands is not one to guess about.
    log.warn(`handoff: the chat command could not be looked up (${describeError(error)}).`);
    return false;
  }
}

function supportsPartialQuery(): boolean {
  const parsed = /^(\d+)\.(\d+)/.exec(vscode.version);
  const major = Number(parsed?.[1]);
  const minor = Number(parsed?.[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    // An unreadable version string is not evidence of an old host - forks stamp
    // their own. The command check is the honest signal in that case.
    return true;
  }
  const [minMajor, minMinor] = MIN_PARTIAL_QUERY_VERSION;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}
