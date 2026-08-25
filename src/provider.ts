import * as vscode from "vscode";

import { isLanguageEnabled, isProseLanguage, proseProfile } from "./config";
import type { Diagnostic } from "./context/diagnostics";
import { addChunk, chunksAround } from "./context/ring-buffer";
import { hasSecret, isSecretPath, redactSecrets } from "./context/sanitize";
import { complete, describeFailure } from "./endpoint";
import { describeItem, formatFallback, itemsFor, uriFor } from "./format/inline-items";
import { logDebug, logError } from "./logger";
import { activeConfig, isAutomaticEnabled, noteFile, relativePath, type Runtime } from "./runtime";
import { parseSecretSpec, resolveAll, resolveSecret, type SecretSource } from "./secret";
import type { Snapshot } from "./snapshot";
import { idleStatus, renderStatus } from "./status-bar";
import { suggest } from "./suggest";

const MOVED_FAR_ENOUGH_TO_PICK = 32;
const ERROR_LIMIT = 30;
const DIAGNOSTIC_LIMIT = 50;

const SEVERITY_NAMES = ["error", "warning", "info", "hint"];

/**
 * Every severity is passed on, because a linter hint is exactly the kind of thing worth
 * fixing next. Errors are never dropped for distance: a syntax error two hundred lines
 * away is what the reader is about to chase. Warnings and hints fill the rest of the
 * budget nearest the cursor first.
 */
const diagnosticsFor = (uri: vscode.Uri, cursorLine: number): Diagnostic[] => {
  const all = vscode.languages.getDiagnostics(uri)
    .map(entry => ({
      line: entry.range.start.line,
      character: entry.range.start.character,
      severity: SEVERITY_NAMES[entry.severity] ?? "note",
      source: entry.source,
      message: entry.message,
    }));

  const errors = all.filter(held => held.severity === "error")
    .toSorted((left, right) => left.line - right.line)
    .slice(0, ERROR_LIMIT);

  const others = all.filter(held => held.severity !== "error")
    .toSorted((left, right) => Math.abs(left.line - cursorLine) - Math.abs(right.line - cursorLine))
    .slice(0, Math.max(0, DIAGNOSTIC_LIMIT - errors.length));

  return [...errors, ...others].toSorted((left, right) => left.line - right.line);
};

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

const readFileLines = async (path: string): Promise<string[] | undefined> => {
  if (isSecretPath(path)) return undefined;

  const uri = uriFor(path);

  if (uri === undefined) return undefined;

  try {
    const document = await vscode.workspace.openTextDocument(uri);

    // a cross-file read is the one place a secret in another file would reach the
    // prompt, so the text is redacted on the way in
    return document.getText().split(/\r?\n/)
      .map(line => redactSecrets(line));
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

    // a file the reader is editing for its secrets is never sent to the model: completing
    // the next line of a .env is exactly the suggestion a secret should never get
    if (isSecretPath(relativePath(document.uri))) {
      renderStatus(runtime.status, { kind: "idle", name: config.name, detail: "secret file, refusing to suggest" }, runtime.isDev);

      return;
    }

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

    // a model that autocompletes a secret the reader is typing is worse than no help, so
    // any answer that carries one is dropped before it reaches the editor or the cache
    const safe = result.suggestions.filter((suggestion) => {
      if (suggestion.kind === "format") return true;

      return !hasSecret(suggestion.text);
    });

    runtime.lastServed = { path: snapshot.path, text: snapshotText, suggestions: safe };

    const items = await itemsFor(safe, document, position, config);

    // a suggestion the editor cannot be given is the case that looks like a silent failure
    // from outside: the server logged an answer and nothing appeared on screen
    const detail = items.length === 0
      ? `${safe.length} answer(s) came back, none of them survived as an edit`
      : `${items.length} suggestion(s)`;

    logDebug(runtime.output, `${config.name}: ${detail}`);

    for (const item of items) logDebug(runtime.output, `  handed to the editor: ${describeItem(item)}`);
    renderStatus(runtime.status, { kind: "idle", name: config.name, detail }, runtime.isDev);

    return items;
  },
});
