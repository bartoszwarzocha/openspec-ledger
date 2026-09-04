import * as vscode from 'vscode';

import { LedgerController, setOutputChannel } from './controller.ts';
import { log, setLogSink } from './util/log.ts';

let controller: LedgerController | undefined;

/**
 * Activation does three things and nothing else: open the log, register the
 * view, and hand control to the controller *after* returning. Discovery,
 * parsing and every git call happen on the next tick, so the Ledger view is on
 * screen within the 300 ms budget even against fourteen roots (design.md D13).
 */
export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('OpenSpec Ledger');
  context.subscriptions.push(channel);
  setOutputChannel(channel);
  setLogSink((_level, line) => channel.appendLine(line));

  const instance = new LedgerController(context);
  controller = instance;
  context.subscriptions.push(instance);

  log.info(`OpenSpec Ledger activated (${context.extension.packageJSON.version ?? 'dev'})`);

  setTimeout(() => {
    void instance.start().catch((error: unknown) => log.error('start failed', error));
  }, 0);
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
  setLogSink(undefined);
}
