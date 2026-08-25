import * as vscode from "vscode";

import { type Config as Config, isLanguageEnabled, isProseLanguage, proseProfile } from "./config";
import type { Diagnostic } from "./context/diagnostics";
import { addChunk, chunksAround } from "./context/ring-buffer";
import { complete, describeFailure } from "./endpoint";
import { applyEdits } from "./format/apply-edits";
import { padEdit, reduceToEdit } from "./format/window-diff";
import { logDebug, logError } from "./logger";
import { activeConfig, isAutomaticEnabled, noteFile, relativePath, type Runtime } from "./runtime";
import { parseSecretSpec, resolveAll, resolveSecret, type SecretSource } from "./secret";
import type { Snapshot } from "./snapshot";
import { idleStatus, renderStatus } from "./status-bar";
import { suggest, type Suggestion } from "./suggest";

const MOVED_FAR_ENOUGH_TO_PICK = 32;
const DIAGNOSTIC_LIMIT = 20;

const SEVERITY_NAMES = ["error", "warning", "info", "hint"];

/**
 * Every severity is passed on, because a linter hint is exactly the kind of thing worth
 * fixing next. The budget is spent on the ones nearest the cursor, since a warning two
 * hundred lines away is not what the reader is about to work on.
 */
const diagnosticsFor = (uri: vscode.Uri, cursorLine: number): Diagnostic[] =>
  vscode.languages.getDiagnostics(uri)
    .map(entry => ({
      line: entry.range.start.line,
      character: entry.range.start.character,
      severity: SEVERITY_NAMES[entry.severity] ?? "note",
      source: entry.source,
      message: entry.message,
    }))
    .toSorted((left, right) => Math.abs(left.line - cursorLine) - Math.abs(right.line - cursorLine))
    .slice(0, DIAGNOSTIC_LIMIT)
    .toSorted((left, right) => left.line - right.line);

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

/**
 * A jump costs a keypress of its own: the first tab moves, the second accepts. That price
 * is only worth paying when the edit starts somewhere the reader cannot see. An edit
 * beginning on the cursor line, or anywhere on screen, is offered for accepting straight
 * away. A jump to the line the cursor is already on would also never resolve: the editor
 * keeps offering the jump and the reader never reaches the edit behind it.
 */
const requiresJump = (target: vscode.TextDocument, isSameFile: boolean, start: vscode.Position, cursor: vscode.Position): boolean => {
  if (!isSameFile) return true;

  if (start.line === cursor.line) return false;

  const editor = vscode.window.visibleTextEditors.find(held => held.document === target);

  return !(editor?.visibleRanges.some(range => range.contains(start)) ?? false);
};

const editItem = async (suggestion: Suggestion, document: vscode.TextDocument, config: Config, cursor: vscode.Position): Promise<vscode.InlineCompletionItem | undefined> => {
  if (suggestion.kind !== "edit") return undefined;

  const isSameFile = suggestion.path === relativePath(document.uri);
  const uri = isSameFile ? document.uri : uriFor(suggestion.path);

  if (uri === undefined) return undefined;

  // an insertion sitting exactly where the cursor is, is what the reader is typing towards,
  // so it belongs in the ordinary suggestion slot rather than as an edit with a jump
  const isEmptyRange = suggestion.startLine === suggestion.endLine
    && suggestion.startCharacter === suggestion.endCharacter;

  const isAtCursor = isSameFile
    && isEmptyRange
    && suggestion.startLine === cursor.line
    && suggestion.startCharacter === cursor.character;

  if (isAtCursor) return new vscode.InlineCompletionItem(suggestion.text, new vscode.Range(cursor, cursor));

  const target = isSameFile ? document : await vscode.workspace.openTextDocument(uri);
  const lastLine = target.lineCount - 1;

  const padded = padEdit(
    {
      startLine: Math.min(suggestion.startLine, lastLine),
      startCharacter: suggestion.startCharacter,
      endLine: Math.min(suggestion.endLine, lastLine),
      endCharacter: suggestion.endCharacter,
      text: suggestion.text,
    },
    target.getText().split(/\r?\n/),
  );

  const start = new vscode.Position(padded.startLine, padded.startCharacter);
  const end = new vscode.Position(padded.endLine, Math.min(padded.endCharacter, target.lineAt(padded.endLine).range.end.character));
  const range = new vscode.Range(start, end);

  if (target.getText(range) === padded.text) return undefined;

  const item = new vscode.InlineCompletionItem(padded.text, range);

  item.isInlineEdit = true;
  item.showInlineEditMenu = true;

  if (requiresJump(target, isSameFile, start, cursor)) item.jumpToPosition = start;

  if (isSameFile) {
    if (config.format === "next-edit") {
      // showRange hides the edit whenever the cursor is outside it, so it has to cover the
      // cursor as well as the edit: an edit offered without a jump is otherwise invisible
      // from a cursor further away than the padding
      const span = Math.max(1, config.windowLines);
      const shownFrom = Math.max(0, Math.min(start.line, cursor.line) - span);
      const shownUpto = Math.min(lastLine, Math.max(end.line, cursor.line) + span);

      item.showRange = new vscode.Range(shownFrom, 0, shownUpto, 0);
    }
  }
  else {
    item.uri = uri;
  }

  return item;
};

/**
 * The model only says that formatting is what it wants. What formatting means is the
 * language's own formatter, so its edits are what gets offered, never a guess at them.
 */
const formatItem = async (document: vscode.TextDocument, cursor: vscode.Position): Promise<vscode.InlineCompletionItem | undefined> => {
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>(
    "vscode.executeFormatDocumentProvider",
    document.uri,
    { tabSize: 2, insertSpaces: true },
  );

  if (edits === undefined || edits.length === 0) return undefined;

  const before = document.getText();

  const after = applyEdits(before, edits.map(edit => ({
    startLine: edit.range.start.line,
    startCharacter: edit.range.start.character,
    endLine: edit.range.end.line,
    endCharacter: edit.range.end.character,
    text: edit.newText,
  })));

  const reduced = reduceToEdit(before.split(/\r?\n/), after.split(/\r?\n/), 0);

  if (reduced === undefined) return undefined;

  const padded = padEdit({ ...reduced, endLine: Math.min(reduced.endLine, document.lineCount - 1) }, before.split(/\r?\n/));
  const endCharacter = Math.min(padded.endCharacter, document.lineAt(padded.endLine).range.end.character);
  const start = new vscode.Position(padded.startLine, padded.startCharacter);
  const end = new vscode.Position(padded.endLine, endCharacter);
  const item = new vscode.InlineCompletionItem(padded.text, new vscode.Range(start, end));

  item.isInlineEdit = true;
  item.showInlineEditMenu = true;

  if (requiresJump(document, true, start, cursor)) item.jumpToPosition = start;

  return item;
};

/**
 * The model never asks for the formatter by itself and leaves pure whitespace faults
 * alone. When it has nothing to say and the formatter would change a line the linter is
 * flagging, the formatter offer is made here instead of waiting for the model to make it.
 */
const formatFallback = async (runtime: Runtime, document: vscode.TextDocument, cursor: vscode.Position): Promise<vscode.InlineCompletionItem | undefined> => {
  const declined = runtime.declined;

  if (declined !== undefined && declined.path === relativePath(document.uri) && declined.text === document.getText()) {
    return undefined;
  }

  const flagged = vscode.languages.getDiagnostics(document.uri).map(entry => entry.range.start.line);

  if (flagged.length === 0) return undefined;

  const item = await formatItem(document, cursor);
  const range = item?.range;

  if (item === undefined || range === undefined) return undefined;

  return flagged.some(line => line >= range.start.line && line <= range.end.line) ? item : undefined;
};

/** What the editor was actually handed, which is the last place a suggestion can go missing. */
const describeItem = (item: vscode.InlineCompletionItem): string => {
  const where = item.range === undefined
    ? "at the cursor"
    : `${item.range.start.line}:${item.range.start.character} to ${item.range.end.line}:${item.range.end.character}`;

  // an inline edit only renders when the editor was started with enable-proposed-api, and
  // there is no way to ask it whether that happened, so the reminder rides along here
  const kind = item.isInlineEdit === true ? "edit, needs enable-proposed-api to render," : "completion";

  return `${kind} ${where} ${JSON.stringify(String(item.insertText).slice(0, 60))}`;
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

    if (suggestion.kind === "format") {
      const formatted = await formatItem(document, position);

      if (formatted !== undefined) items.push(formatted);

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
  // a rejection is the reader saying no to this document state, so the remembered answer
  // must not come back on the next cursor rest, and nothing else is volunteered for the
  // same state either
  handleEndOfLifetime: (_item, reason) => {
    if (reason.kind !== vscode.InlineCompletionEndOfLifeReasonKind.Rejected) return;

    const served = runtime.lastServed;

    if (served !== undefined) runtime.declined = { path: served.path, text: served.text };

    runtime.lastServed = undefined;
  },

  provideInlineCompletionItems: async (document, position, context, token) => {
    const settings = vscode.workspace.getConfiguration("tablet");
    const isAutomatic = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;

    if (isAutomatic && !isAutomaticEnabled(runtime)) return;

    const active = activeConfig(runtime);

    if (active.configuration === undefined) {
      renderStatus(runtime.status, idleStatus(active.names, active.problems), runtime.isDev);

      return;
    }

    if (!isLanguageEnabled(settings.get<Record<string, boolean>>("languages") ?? {}, document.languageId)) {
      return;
    }

    const isProse = isProseLanguage(settings.get<string[]>("proseLanguages") ?? [], document.languageId);

    // prose gets a bounded profile: the model answers a sentence, not a paragraph
    const config = isProse ? proseProfile(active.configuration) : active.configuration;

    // a jump to an edit moves the cursor, which re-asks this provider. While the document
    // has not changed, the answer has not either, so the held suggestions are re-served
    // rather than replaced by a fresh request the model may answer differently. A plain
    // completion is anchored to the cursor it was made for and is not re-servable
    const remembered = runtime.lastServed;

    if (remembered !== undefined
      && remembered.path === relativePath(document.uri)
      && remembered.text === document.getText()) {
      const items = await itemsFor(remembered.suggestions.filter(held => held.kind !== "completion"), document, position, config);

      if (items.length > 0) {
        logDebug(runtime.output, `${config.name}: re-served ${items.length} remembered suggestion(s)`);

        return items;
      }
    }

    if (isAutomatic) {
      await delay(settings.get<number>("debounceMs") ?? 150);

      if (token.isCancellationRequested) return;
    }

    runtime.inFlight?.abort();

    const controller = new AbortController();

    runtime.inFlight = controller;
    token.onCancellationRequested(() => controller.abort());

    const snapshot = snapshotOf(document, position);
    const snapshotText = document.getText();

    noteFile(runtime, snapshot.path);

    const key = await resolveSecret(parseSecretSpec(config.apiKey), secretSource(runtime));

    if (!key.ok) {
      renderStatus(runtime.status, { kind: "problem", name: config.name, detail: key.problem }, runtime.isDev);

      return;
    }

    const headers = await resolveAll(config.headers, secretSource(runtime));

    if (!headers.ok) {
      renderStatus(runtime.status, { kind: "problem", name: config.name, detail: headers.problem }, runtime.isDev);

      return;
    }

    renderStatus(runtime.status, { kind: "working", name: config.name }, runtime.isDev);

    const result = await suggest(
      {
        configuration: config,
        snapshot,
        chunks: runtime.ring.chunks,
        changes: runtime.tracker.log.edits,
        diagnostics: diagnosticsFor(document.uri, position.line),
        repo: vscode.workspace.workspaceFolders?.[0]?.name ?? "",
        previousByPath: runtime.tracker.previousByPath,
        candidatePaths: runtime.candidatePaths,
      },
      {
        complete: async (prompt) => {
          logDebug(runtime.output, `prompt for ${config.name}:\n${prompt}`);

          const answer = await complete({
            endpoint: config.endpoint,
            apiKey: key.value,
            headers: headers.values,
            model: config.model,
            prompt,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
            stop: config.stop,
            extraBody: config.extraBody,
            timeoutMs: settings.get<number>("requestTimeoutMs") ?? 10_000,
            signal: controller.signal,
          });

          logDebug(runtime.output, answer.ok
            ? `reply for ${config.name}:\n${answer.texts.join("\n---\n")}`
            : `reply for ${config.name}: ${describeFailure(answer.failure)}`);

          return answer;
        },
        readFile: readFileLines,
        diagnosticsFor: (path) => {
          const uri = uriFor(path);

          return uri === undefined ? [] : diagnosticsFor(uri, 0);
        },
        cache: runtime.cache,
      },
    );

    // the answer was computed from snapshotText: if the document moved on while the
    // model was thinking, the edits no longer describe what is on screen
    if (document.getText() !== snapshotText) {
      logDebug(runtime.output, `${config.name}: document changed during the request, discarding the answer`);

      return;
    }

    updateRing(runtime, snapshot);

    if (result.kind === "failure") {
      // a later keystroke cancelled this request, which is not a fault to report
      if (result.failure.kind === "aborted") return;

      const detail = describeFailure(result.failure);

      logError(runtime.output, `${config.name}: ${detail}`);

      renderStatus(runtime.status, { kind: "problem", name: config.name, detail }, runtime.isDev);

      return;
    }

    if (result.kind === "invalid") {
      const detail = `template names ${result.unknown.join(", ")}, which tablet cannot fill`;

      logError(runtime.output, `${config.name}: ${detail}`);
      renderStatus(runtime.status, { kind: "problem", name: config.name, detail }, runtime.isDev);

      return;
    }

    if (result.kind === "none") {
      const fallback = !isProse && config.format === "next-edit" ? await formatFallback(runtime, document, position) : undefined;

      if (fallback !== undefined) {
        runtime.lastServed = { path: snapshot.path, text: snapshotText, suggestions: [{ kind: "format", path: snapshot.path }] };
        logDebug(runtime.output, `${config.name}: ${result.reason}, offering the formatter for a flagged line instead`);
        renderStatus(runtime.status, { kind: "idle", name: config.name, detail: "offered the formatter" }, runtime.isDev);

        return [fallback];
      }

      logDebug(runtime.output, `${config.name}: no suggestion, ${result.reason}`);
      renderStatus(runtime.status, { kind: "idle", name: config.name, detail: result.reason }, runtime.isDev);

      return;
    }

    runtime.lastServed = { path: snapshot.path, text: snapshotText, suggestions: result.suggestions };

    const items = await itemsFor(result.suggestions, document, position, config);

    // a suggestion the editor cannot be given is the case that looks like a silent failure
    // from outside: the server logged an answer and nothing appeared on screen
    const detail = items.length === 0
      ? `${result.suggestions.length} answer(s) came back, none of them survived as an edit`
      : `${items.length} suggestion(s)`;

    logDebug(runtime.output, `${config.name}: ${detail}`);

    for (const item of items) logDebug(runtime.output, `  handed to the editor: ${describeItem(item)}`);
    renderStatus(runtime.status, { kind: "idle", name: config.name, detail }, runtime.isDev);

    return items;
  },
});
