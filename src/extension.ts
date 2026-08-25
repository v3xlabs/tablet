import * as vscode from "vscode";

import { emptyCache } from "./cache";
import { registerCommands } from "./commands";
import { blocksFromChange, recordEdit } from "./context/recent-edits";
import { createProvider } from "./provider";
import { activeConfig, cancelIdleTrigger, createRuntime, noteFile, relativePath, type Runtime, scheduleIdleTrigger } from "./runtime";
import { idleStatus, renderStatus } from "./status-bar";
import type { Suggestion } from "./suggest";

const CHANGE_PADDING = 2;

const trackDocument = (runtime: Runtime, document: vscode.TextDocument): void => {
  if (document.uri.scheme !== "file") return;

  const key = document.uri.toString();
  const now = document.getText();
  const previous = runtime.lastText.get(key);

  runtime.lastText.set(key, now);

  if (previous === undefined) return;

  const before = previous.split(/\r?\n/);
  const after = now.split(/\r?\n/);
  const path = relativePath(document.uri);
  const blocks = blocksFromChange(before, after, CHANGE_PADDING);

  if (blocks === undefined) return;

  runtime.previousLines = { path, lines: before };
  runtime.edits = recordEdit(runtime.edits, { path, before: blocks.before, after: blocks.after });

  noteFile(runtime, path);
};

const showActive = (runtime: Runtime): void => {
  const active = activeConfig(runtime);

  if (active.configuration === undefined) {
    renderStatus(runtime.status, idleStatus(active.names, active.problems));

    return;
  }

  renderStatus(runtime.status, { kind: "idle", name: active.configuration.name, detail: "" });
};

export const activate = (context: vscode.ExtensionContext): void => {
  const runtime = createRuntime(context);

  showActive(runtime);

  for (const document of vscode.workspace.textDocuments) trackDocument(runtime, document);

  context.subscriptions.push(
    runtime.output,
    runtime.status,
    ...registerCommands(runtime),
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      createProvider(runtime),
      { displayName: "tablet" },
    ),
    vscode.workspace.onDidChangeTextDocument(event => trackDocument(runtime, event.document)),
    vscode.workspace.onDidOpenTextDocument(document => trackDocument(runtime, document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor === undefined) return;

      trackDocument(runtime, editor.document);
      scheduleIdleTrigger(runtime, editor);
    }),
    vscode.window.onDidChangeTextEditorSelection(event => scheduleIdleTrigger(runtime, event.textEditor)),
    new vscode.Disposable(() => cancelIdleTrigger(runtime)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("tablet")) return;

      runtime.cache = emptyCache<Suggestion[]>(32);
      runtime.lastServed = undefined;
      showActive(runtime);
    }),
  );
};

export const deactivate = (): void => {
  // nothing to tear down, every disposable is in context.subscriptions
};
