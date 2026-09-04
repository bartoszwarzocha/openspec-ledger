/**
 * Diagnostics. Every module logs through here; `extension.ts` attaches the
 * output channel as the sink. Keeping `vscode` out of this file means the rest
 * of the codebase can be unit-tested outside an extension host.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export type LogSink = (level: LogLevel, line: string) => void;

let sink: LogSink | undefined;

/** Lines emitted before the output channel existed, replayed once it does. */
const pending: Array<[LogLevel, string]> = [];
const PENDING_LIMIT = 500;

export function setLogSink(next: LogSink | undefined): void {
  sink = next;
  if (!next) {
    return;
  }
  for (const [level, line] of pending.splice(0, pending.length)) {
    next(level, line);
  }
}

function emit(level: LogLevel, message: string): void {
  const stamp = new Date().toISOString().slice(11, 23);
  const line = `${stamp} ${level === 'info' ? ' ' : level === 'warn' ? '!' : 'x'} ${message}`;
  if (sink) {
    sink(level, line);
  } else if (pending.length < PENDING_LIMIT) {
    pending.push([level, line]);
  }
}

export const log = {
  info(message: string): void {
    emit('info', message);
  },
  warn(message: string): void {
    emit('warn', message);
  },
  error(message: string, error?: unknown): void {
    emit('error', error === undefined ? message : `${message}: ${describeError(error)}`);
  },
  /** Times an async operation and logs its duration, so the budgets in design.md are observable. */
  async time<T>(label: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await run();
    } finally {
      emit('info', `${label} took ${Date.now() - started} ms`);
    }
  },
};

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
