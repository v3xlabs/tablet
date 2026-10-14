import * as vscode from "vscode";

import { emptyCache } from "./cache";
import { countRecords } from "./collect/store";
import { registerCommands } from "./commands";
import { isLanguageEnabled, isProseLanguage } from "./config";
import { trackChange } from "./context/recent-edits";
import { createProvider } from "./provider";
import { cancelIdleTrigger, cancelRequests, createRuntime, isAutomaticEnabled, isSnoozed, noteFile, refreshStatus, relativePath, type Runtime, scheduleIdleTrigger, showActive } from "./runtime";
import type { Suggestion } from "./suggest";

const DIAGNOSTIC_REACH = 10;

const trackDocument = (runtime: Runtime, document: vscode.TextDocument): void => {
  if (document.uri.scheme !== "file") return;

  const path = relativePath(document.uri);

  if (trackChange(runtime.tracker, document.uri.toString(), path, document.getText())) {
    noteFile(runtime, path);
  }
};

const warmDefinitions = (runtime: Runtime, editor: vscode.TextEditor | undefined): void => {
  if (editor === undefined || !editor.selection.isEmpty || editor.document.uri.scheme !== "file") return;

  if (!isAutomaticEnabled(runtime) || isSnoozed(runtime)) return;

  const document = editor.document;
  const settings = vscode.workspace.getConfiguration("tablet");

  if (isProseLanguage(settings.get<string[]>("proseLanguages") ?? [], document.languageId)
    || !isLanguageEnabled(settings.get<Record<string, boolean>>("languages") ?? {}, document.languageId)) return;

  runtime.definitions.read(document, editor.selection.active);
};

export const activate = (context: vscode.ExtensionContext): void => {
  const runtime = createRuntime(context);

  showActive(runtime);
  void countRecords(runtime.globalStoragePath).then((count) => {
    runtime.recordCount = count;
    refreshStatus(runtime);
  });

  for (const document of vscode.workspace.textDocuments) trackDocument(runtime, document);

  warmDefinitions(runtime, vscode.window.activeTextEditor);

  context.subscriptions.push(
    runtime.output,
    runtime.status,
    ...registerCommands(runtime),
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      createProvider(runtime),
      { displayName: "tablet" },
    ),
    // the hover chart is an image drawn in fixed colors chosen for the theme kind
    vscode.window.onDidChangeActiveColorTheme(() => refreshStatus(runtime)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      // Virtual documents such as output channels change as tablet logs and hold no definitions.
      if (event.document.uri.scheme !== "file") return;

      runtime.definitions.invalidate(event.document.uri.toString());
      runtime.diagnostics.noteChange(event);
      trackDocument(runtime, event.document);
      warmDefinitions(runtime, vscode.window.activeTextEditor);

      const editor = vscode.window.activeTextEditor;

      // An edit that leaves the cursor in place fires no selection change, yet still starts a rest.
      if (editor?.document === event.document) scheduleIdleTrigger(runtime, editor);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      runtime.definitions.invalidate(document.uri.toString());

      if (runtime.foreground.current()?.path === relativePath(document.uri)) cancelRequests(runtime);
    }),
    vscode.workspace.onDidOpenTextDocument(document => trackDocument(runtime, document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      cancelIdleTrigger(runtime);
      cancelRequests(runtime);

      if (editor === undefined) return;

      trackDocument(runtime, editor.document);
      warmDefinitions(runtime, editor);
      scheduleIdleTrigger(runtime, editor);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      warmDefinitions(runtime, event.textEditor);
      scheduleIdleTrigger(runtime, event.textEditor);
    }),
    vscode.languages.onDidChangeDiagnostics((event) => {
      runtime.diagnostics.noteDiagnostics(event.uris);

      const editor = vscode.window.activeTextEditor;

      if (editor === undefined || event.uris.every(uri => uri.toString() !== editor.document.uri.toString())) return;

      // A report landing after typing stopped has no keystroke to ask on, so a nearby problem schedules the ask.
      const cursorLine = editor.selection.active.line;
      const isNear = vscode.languages.getDiagnostics(editor.document.uri)
        .some(diagnostic => Math.abs(diagnostic.range.start.line - cursorLine) <= DIAGNOSTIC_REACH);

      if (isNear) scheduleIdleTrigger(runtime, editor);
    }),
    new vscode.Disposable(() => {
      cancelIdleTrigger(runtime);
      cancelRequests(runtime);
      runtime.requests.dispose();
      runtime.definitions.dispose();

      if (runtime.snooze !== undefined) clearTimeout(runtime.snooze.timer);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("tablet")) return;

      cancelRequests(runtime);
      runtime.cache = emptyCache<Suggestion[]>(32);
      runtime.lastServed = undefined;
      runtime.landed = undefined;
      showActive(runtime);
    }),
  );
};

export const deactivate = (): void => {
  // nothing to tear down, every disposable is in context.subscriptions
};
