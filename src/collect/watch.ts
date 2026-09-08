import * as vscode from "vscode";

import type { Resolution } from "./record";

const IDLE_MS = 1000;
const LEAVE_LINES = 50;
const GIVE_UP_MS = 60_000;

export type WatchedWindow = { startLine: number; endLine: number; text: string; };

const windowText = (document: vscode.TextDocument, window: WatchedWindow): string => {
  const last = Math.min(window.endLine, document.lineCount - 1);

  if (last < window.startLine) return "";

  return document.getText(new vscode.Range(window.startLine, 0, last, document.lineAt(last).range.end.character));
};

/**
 * After a suggestion is turned down, what the reader types into the same window is the
 * answer they wanted. The watch ends on the first of: a second of quiet after a change
 * inside the window, the cursor leaving the area or the editor changing, or a minute
 * passing. What the window holds then is the resolution.
 */
export const watchResolution = (
  document: vscode.TextDocument,
  window: WatchedWindow,
  onDone: (resolution: Resolution) => void,
): vscode.Disposable => {
  let isChanged = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let isDone = false;

  const subscriptions: vscode.Disposable[] = [];

  const finish = (): void => {
    if (isDone) return;

    isDone = true;

    if (idle !== undefined) clearTimeout(idle);

    for (const subscription of subscriptions) subscription.dispose();

    if (!isChanged) {
      onDone({ kind: "unchanged" });

      return;
    }

    const after = windowText(document, window);

    onDone(after === window.text ? { kind: "unchanged" } : { kind: "edited", after });
  };

  const giveUp = setTimeout(finish, GIVE_UP_MS);

  subscriptions.push(
    new vscode.Disposable(() => clearTimeout(giveUp)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== document) return;

      const touchesWindow = event.contentChanges.some(change =>
        change.range.end.line >= window.startLine && change.range.start.line <= window.endLine);

      if (!touchesWindow) return;

      isChanged = true;

      if (idle !== undefined) clearTimeout(idle);

      idle = setTimeout(finish, IDLE_MS);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor.document !== document) return;

      const line = event.selections[0]?.active.line ?? window.startLine;

      if (line < window.startLine - LEAVE_LINES || line > window.endLine + LEAVE_LINES) finish();
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document !== document) finish();
    }),
    vscode.workspace.onDidCloseTextDocument((closed) => {
      if (closed === document) finish();
    }),
  );

  return new vscode.Disposable(finish);
};
