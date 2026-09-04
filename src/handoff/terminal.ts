/**
 * Delivery of a handoff prompt to a Claude Code terminal, with the clipboard as
 * the fallback (design.md D12).
 *
 * This is the only file in `handoff/` that touches `vscode`; the prompt text
 * itself is built in `prompt.ts`, which stays pure. `pickTerminal` is kept free
 * of side effects and reads only two properties of a terminal, so it can be
 * exercised against plain objects.
 */

import * as vscode from 'vscode';
import { isPathInside } from '../model/keys.ts';
import { describeError, log } from '../util/log.ts';

export type DeliveryMode = 'terminal' | 'clipboard';

export interface DeliveryOptions {
  /** Working directory a terminal must match, and the cwd of a new one. */
  cwd: string;
  /** `openspecLedger.handoff.command`, run when a new terminal has to be created. */
  command: string;
  /** The explicit copy command: no terminal is created, revealed or written to. */
  preferClipboard?: boolean;
}

/**
 * Named so the next handoff finds this terminal by name even after shell
 * integration has gone away, or before it has reported a working directory.
 */
const NEW_TERMINAL_NAME = 'Claude Code';

/**
 * Claude Code has to start and attach to the terminal before it accepts input;
 * text typed into the shell in the meantime would be lost or, worse, run.
 */
const NEW_TERMINAL_WARMUP_MS = 800;

/**
 * Deliver the prompt, resolving with how it was delivered.
 *
 * Rejects only when the clipboard fallback itself fails, since at that point
 * there is nothing left to report but the error.
 */
export async function deliverPrompt(
  prompt: string,
  options: DeliveryOptions,
): Promise<{ mode: DeliveryMode; reason?: string }> {
  if (options.preferClipboard) {
    await vscode.env.clipboard.writeText(prompt);
    return { mode: 'clipboard' };
  }

  try {
    const terminal = await establishTerminal(options);
    // Focus, not just reveal: the user is the one who presses Enter.
    terminal.show();
    // `false` withholds the newline, so the prompt sits there for review (D12).
    terminal.sendText(prompt, false);
    return { mode: 'terminal' };
  } catch (error) {
    const reason = `No terminal could be established (${describeError(error)}).`;
    log.warn(`handoff: falling back to the clipboard. ${reason}`);
    await vscode.env.clipboard.writeText(prompt);
    return { mode: 'clipboard', reason };
  }
}

/**
 * The terminal a prompt for `cwd` belongs in, or undefined when none of the
 * open terminals is a candidate and one has to be created.
 *
 * A terminal whose shell integration reports a directory at or beneath `cwd`
 * wins, because that is evidence about where the session actually is; a name
 * containing `claude` is the weaker signal, since a name is only a label.
 */
export function pickTerminal(
  terminals: readonly vscode.Terminal[],
  cwd: string,
): vscode.Terminal | undefined {
  const live = terminals.filter((terminal) => terminal.exitStatus === undefined);

  for (const terminal of live) {
    const dir = shellCwd(terminal);
    if (dir && isPathInside(dir, cwd)) {
      return terminal;
    }
  }

  return live.find((terminal) => (terminal.name ?? '').toLowerCase().includes('claude'));
}

async function establishTerminal(options: DeliveryOptions): Promise<vscode.Terminal> {
  const existing = pickTerminal(vscode.window.terminals, options.cwd);
  if (existing) {
    log.info(`handoff: using the open terminal "${existing.name}"`);
    return existing;
  }

  const created = vscode.window.createTerminal({ name: NEW_TERMINAL_NAME, cwd: options.cwd });
  const command = options.command.trim();
  if (command.length > 0) {
    log.info(`handoff: created a terminal in ${options.cwd} running ${command}`);
    created.sendText(command, true);
    await delay(NEW_TERMINAL_WARMUP_MS);
  }
  return created;
}

/**
 * `shellIntegration.cwd` is a `Uri`, but this reads it defensively so the
 * function also works against a plain object in a test.
 */
function shellCwd(terminal: vscode.Terminal): string | undefined {
  const cwd: unknown = terminal.shellIntegration?.cwd;
  if (typeof cwd === 'string') {
    return cwd;
  }
  if (typeof cwd === 'object' && cwd !== null && 'fsPath' in cwd) {
    const fsPath: unknown = cwd.fsPath;
    return typeof fsPath === 'string' ? fsPath : undefined;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
