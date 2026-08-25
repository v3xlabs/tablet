import * as vscode from "vscode";

import { type Config as Config, isLanguageEnabled } from "./config";
import { addChunk, chunksAround } from "./context/ring-buffer";
import { complete, describeFailure } from "./endpoint";
import { logDebug, logError } from "./logger";
import { activeConfig, isAutomaticEnabled, noteFile, relativePath, type Runtime } from "./runtime";
import { parseSecretSpec, resolveAll, resolveSecret, type SecretSource } from "./secret";
import type { Snapshot } from "./snapshot";
import { renderStatus } from "./status-bar";
import { suggest, type Suggestion } from "./suggest";

const MOVED_FAR_ENOUGH_TO_PICK = 32;

const secretSource = (runtime: Runtime): SecretSource => ({
  environment: process.env,
  read: name => runtime.secrets.get(name),
});

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const snapshotOf = (document: vscode.TextDocument, position: vscode.Position): Snapshot => ({
  path: relativePath(document.uri),
  languageId: document.languageId,
  lines: document.getText().split(/\r?\n/),
  cursorLine: position.line,
  cursorCharacter: position.character,
});

const uriFor = (path: string): vscode.Uri | undefined => {
  const folder = vscode.workspace.workspaceFolders?.[0];

  return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, path);
};

const editItem = async (suggestion: Suggestion, document: vscode.TextDocument, config: Config, cursor: vscode.Position): Promise<vscode.InlineCompletionItem | undefined> => {
  if (suggestion.kind !== "edit") return undefined;

  const isSameFile = suggestion.path === relativePath(document.uri);
  const uri = isSameFile ? document.uri : uriFor(suggestion.path);

  if (uri === undefined) return undefined;

  const target = isSameFile ? document : await vscode.workspace.openTextDocument(uri);
  const startLine = Math.min(suggestion.startLine, target.lineCount - 1);
  const isPastEnd = suggestion.endLine >= target.lineCount;

  const range = isPastEnd
    ? new vscode.Range(new vscode.Position(startLine, 0), target.lineAt(target.lineCount - 1).range.end)
    : new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(suggestion.endLine, 0));

  const insertText = suggestion.text === "" ? "" : (isPastEnd ? suggestion.text : `${suggestion.text}\n`);

  if (target.getText(range) === insertText) return undefined;

  const item = new vscode.InlineCompletionItem(insertText, range);

  item.isInlineEdit = true;
  item.showInlineEditMenu = true;
  item.jumpToPosition = new vscode.Position(startLine, 0);

  if (!isSameFile) item.uri = uri;
  else if (config.format === "next-edit") {
    const span = Math.max(1, config.windowLines);

    item.showRange = new vscode.Range(
      new vscode.Position(Math.max(0, cursor.line - span), 0),
      new vscode.Position(Math.min(document.lineCount - 1, cursor.line + span), 0),
    );
  }

  return item;
};

const itemsFor = async (
  suggestions: Suggestion[],
  document: vscode.TextDocument,
  position: vscode.Position,
  config: Config,
): Promise<vscode.InlineCompletionItem[]> => {
  const items: vscode.InlineCompletionItem[] = [];

  for (const suggestion of suggestions) {
    if (suggestion.kind === "completion") {
      items.push(new vscode.InlineCompletionItem(suggestion.text, new vscode.Range(position, position)));

      continue;
    }

    const item = await editItem(suggestion, document, config, position);

    if (item !== undefined) items.push(item);
  }

  return items;
};

const readFileLines = async (path: string): Promise<string[] | undefined> => {
  const uri = uriFor(path);

  if (uri === undefined) return undefined;

  try {
    const document = await vscode.workspace.openTextDocument(uri);

    return document.getText().split(/\r?\n/);
  }
  catch {
    return undefined;
  }
};

const updateRing = (runtime: Runtime, snapshot: Snapshot): void => {
  if (Math.abs(snapshot.cursorLine - runtime.lastPickLine) <= MOVED_FAR_ENOUGH_TO_PICK) return;

  const settings = vscode.workspace.getConfiguration("tablet").get<Record<string, number>>("ringBuffer") ?? {};
  const picked = chunksAround(
    snapshot.path,
    snapshot.lines,
    snapshot.cursorLine,
    settings["scopeLines"] ?? 1024,
    settings["chunkLines"] ?? 16,
  );

  runtime.ring = picked.reduce(addChunk, runtime.ring);
  runtime.lastPickLine = snapshot.cursorLine;
};

export const createProvider = (runtime: Runtime): vscode.InlineCompletionItemProvider => ({
  provideInlineCompletionItems: async (document, position, context, token) => {
    const settings = vscode.workspace.getConfiguration("tablet");
    const isAutomatic = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;

    if (isAutomatic && !isAutomaticEnabled(runtime)) return;

    const active = activeConfig(runtime);

    if (active.configuration === undefined) {
      const detail = active.problems.length > 0
        ? active.problems.join("\n")
        : "no configuration defined, add one under tablet.configurations";

      renderStatus(runtime.status, { kind: "unconfigured", detail });

      return;
    }

    if (!isLanguageEnabled(settings.get<Record<string, boolean>>("languages") ?? {}, document.languageId)) {
      return;
    }

    const config = active.configuration;

    if (isAutomatic) {
      await delay(settings.get<number>("debounceMs") ?? 150);

      if (token.isCancellationRequested) return;
    }

    runtime.inFlight?.abort();

    const controller = new AbortController();

    runtime.inFlight = controller;
    token.onCancellationRequested(() => controller.abort());

    const snapshot = snapshotOf(document, position);

    noteFile(runtime, snapshot.path);

    const key = await resolveSecret(parseSecretSpec(config.apiKey), secretSource(runtime));

    if (!key.ok) {
      renderStatus(runtime.status, { kind: "problem", name: config.name, detail: key.problem });

      return;
    }

    const headers = await resolveAll(config.headers, secretSource(runtime));

    if (!headers.ok) {
      renderStatus(runtime.status, { kind: "problem", name: config.name, detail: headers.problem });

      return;
    }

    renderStatus(runtime.status, { kind: "working", name: config.name });

    const result = await suggest(
      {
        configuration: config,
        snapshot,
        chunks: runtime.ring.chunks,
        changes: runtime.edits.edits,
        repo: vscode.workspace.workspaceFolders?.[0]?.name ?? "",
        previousLines: runtime.previousLines?.path === snapshot.path ? runtime.previousLines.lines : undefined,
        candidatePaths: runtime.candidatePaths,
      },
      {
        complete: (prompt) => {
          logDebug(runtime.output, `prompt for ${config.name}:\n${prompt}`);

          return complete({
            endpoint: config.endpoint,
            apiKey: key.value,
            headers: headers.values,
            model: config.model,
            prompt,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
            stop: config.stop,
            extraBody: config.extraBody,
            timeoutMs: settings.get<number>("requestTimeoutMs") ?? 3000,
            signal: controller.signal,
          });
        },
        readFile: readFileLines,
        cache: runtime.cache,
      },
    );

    updateRing(runtime, snapshot);

    if (result.kind === "failure") {
      const detail = describeFailure(result.failure);

      runtime.lastProblem = detail;

      if (result.failure.kind !== "aborted") logError(runtime.output, `${config.name}: ${detail}`);

      renderStatus(runtime.status, { kind: "problem", name: config.name, detail });

      return;
    }

    if (result.kind === "invalid") {
      const detail = `template names ${result.unknown.join(", ")}, which tablet cannot fill`;

      logError(runtime.output, `${config.name}: ${detail}`);
      renderStatus(runtime.status, { kind: "problem", name: config.name, detail });

      return;
    }

    renderStatus(runtime.status, { kind: "idle", name: config.name });

    if (result.kind === "none") return;

    return itemsFor(result.suggestions, document, position, config);
  },
});
