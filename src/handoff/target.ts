/**
 * The decisions behind handoff delivery, kept out of the two files in this
 * directory that import `vscode` so they can be exercised without an extension
 * host.
 *
 * Two things live here: which surface a prompt is delivered to, and how the
 * archive command line is spelled. Both are choices a reader can disagree with,
 * and the second is one character away from being wrong in a way only a shell
 * would notice - which is why it is a function with tests rather than a
 * template literal at the call site.
 */

// ---------------------------------------------------------------------------
// Handoff target
// ---------------------------------------------------------------------------

export type HandoffTarget = 'terminal' | 'chat' | 'clipboard';

export const HANDOFF_TARGETS: readonly HandoffTarget[] = ['terminal', 'chat', 'clipboard'];

/**
 * The terminal stays the default (design.md D12): the prompt is written for
 * Claude Code, which runs as a terminal process. Chat exists because a reader
 * who has only Copilot has no `claude` CLI, and for them the terminal path
 * delivers a prompt to a shell that does not understand it.
 */
export const DEFAULT_HANDOFF_TARGET: HandoffTarget = 'terminal';

/** What this host can deliver to, beyond the two targets that always work. */
export interface HandoffAvailability {
  /** A chat surface that will hold a prompt without submitting it. */
  chat: boolean;
}

export function resolveTarget(
  configured: string | undefined,
  available: HandoffAvailability,
): HandoffTarget {
  const requested = asTarget(configured);
  if (requested === 'chat' && !available.chat) {
    // Opening nothing is indistinguishable from the command having failed. A
    // clipboard copy is at least something the reader can paste into whatever
    // chat they do have.
    return 'clipboard';
  }
  return requested;
}

/**
 * An unrecognised value is the default rather than an error. The setting can
 * hold a target from a later version, or a typo, and neither is a reason to
 * refuse to hand a task off.
 */
function asTarget(configured: string | undefined): HandoffTarget {
  const value = configured?.trim().toLowerCase();
  return HANDOFF_TARGETS.find((target) => target === value) ?? DEFAULT_HANDOFF_TARGET;
}

// ---------------------------------------------------------------------------
// Archive command line
// ---------------------------------------------------------------------------

export const DEFAULT_ARCHIVE_COMMAND = 'openspec archive';

/**
 * Characters a change directory normally uses, none of which any shell reads as
 * syntax. Everything outside this set is quoted.
 */
const BARE_ARGUMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The line the user will read before pressing Enter.
 *
 * A blank command falls back to the default rather than producing a line that
 * starts with the change id: emptying the setting is how a user clears a field,
 * not how they ask for `add-lookup-provider` to be run as a program.
 */
export function archiveCommandLine(command: string, changeId: string): string {
  const base = command.trim();
  return `${base === '' ? DEFAULT_ARCHIVE_COMMAND : base} ${quoteArgument(changeId.trim())}`;
}

/**
 * Several changes archived in one go, chained with `&&`.
 *
 * One line rather than one line per change, because the prompt is written to the
 * terminal WITHOUT a trailing newline so the user reads it and presses Enter:
 * separate lines would submit all but the last of them unread. `&&` also stops
 * the run at the first failure, which is the right behaviour when the CLI is
 * rewriting `openspec/specs/` as it goes - a later archive built on a merge that
 * did not happen is worse than a run that halts.
 */
export function archiveChainCommandLine(command: string, changeIds: readonly string[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const changeId of changeIds) {
    const trimmed = changeId.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    lines.push(archiveCommandLine(command, trimmed));
  }
  return lines.join(' && ');
}

/**
 * Single quotes are literal in POSIX shells and in PowerShell alike, so they
 * are the one form that survives whichever shell the terminal opened with.
 *
 * A quote inside the value is doubled, which is PowerShell's escape; a POSIX
 * shell reads the pair as concatenation and drops it. That case is a change
 * directory with an apostrophe in its name, and it is why the line is written
 * without a newline: the reader sees the command before it runs.
 */
function quoteArgument(value: string): string {
  return BARE_ARGUMENT.test(value) ? value : `'${value.replaceAll("'", "''")}'`;
}
