import * as vscode from "vscode";

import { emptyCache } from "./cache";
import { registerCommands } from "./commands";
import { trackChange } from "./context/recent-edits";
import { createProvider } from "./provider";
import { activeConfig, cancelIdleTrigger, createRuntime, noteFile, relativePath, type Runtime, scheduleIdleTrigger } from "./runtime";
import { idleStatus, renderStatus } from "./status-bar";
import type { Suggestion } from "./suggest";

const trackDocument = (runtime: Runtime, document: vscode.TextDocument): void => {
  if (document.uri.scheme !== "file") return;

  const path = relativePath(document.uri);

  if (trackChange(runtime.tracker, document.uri.toString(), path, document.getText())) {
    noteFile(runtime, path);
  }
};

const showActive = (runtime: Runtime): void => {
  const active = activeConfig(runtime);

  if (active.configuration === undefined) {
    renderStatus(runtime.status, idleStatus(active.names, active.problems), runtime.isDev);

    return;
  }

  renderStatus(runtime.status, { kind: "idle", name: active.configuration.name, detail: "" }, runtime.isDev);
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
