import * as vscode from "vscode";

import type { CollectedRecord, Exchange, Outcome } from "./collect/record";
import { appendRecord } from "./collect/store";
import { watchResolution } from "./collect/watch";
import { isLanguageEnabled, isProseLanguage, proseProfile } from "./config";
import type { Diagnostic } from "./context/diagnostics";
import { notePrediction } from "./context/recent-edits";
import { addChunk, chunksAround } from "./context/ring-buffer";
import { hasSecret, isSecretPath, redactSecrets } from "./context/sanitize";
import { scoreOf, withScore } from "./eagerness";
import { complete, describeFailure } from "./endpoint";
import { estimateTokens } from "./format/budget";
import { describeItem, formatFallback, itemsFor, uriFor } from "./format/inline-items";
import { logDebug, logError, logInfo } from "./logger";
import { definitionChunks } from "./lsp";
import { activeConfig, isAutomaticEnabled, isCollectEnabled, noteFile, type PendingRecord, promptBudget, relativePath, type Runtime, scaledDelay, statusMarks } from "./runtime";
import { parseSecretSpec, resolveAll, resolveSecret, type SecretSource } from "./secret";
import { type Snapshot, windowAround } from "./snapshot";
import { speculativeInput } from "./speculate";
import { idleStatus, renderStatus } from "./status-bar";
import { suggest, type SuggestInput, type SuggestResult } from "./suggest";

const MOVED_FAR_ENOUGH_TO_PICK = 32;
const DIAGNOSTIC_LIMIT = 12;

const SEVERITY_NAMES = ["error", "warning", "info", "hint"];

/**
 * Every severity is passed on, because a linter hint is exactly the kind of thing worth
 * fixing next. Errors take the slots first, nearest the cursor first, and warnings and
 * hints fill what is left. The limit is what keeps a file mid-refactor, with dozens of
 * type errors, from pushing the prompt past the endpoint's context.
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

  const byDistance = (left: Diagnostic, right: Diagnostic): number =>
    Math.abs(left.line - cursorLine) - Math.abs(right.line - cursorLine);

  const errors = all.filter(held => held.severity === "error").toSorted(byDistance);
  const others = all.filter(held => held.severity !== "error").toSorted(byDistance);

  return [...errors, ...others].slice(0, DIAGNOSTIC_LIMIT)
    .toSorted((left, right) => left.line - right.line);
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
  const hash = snapshot.lines.join("\n");
  const hasMovedEnough = Math.abs(snapshot.cursorLine - runtime.lastPickLine) > MOVED_FAR_ENOUGH_TO_PICK;
  const hasContentChanged = runtime.lastPickHash !== hash;

  if (!hasMovedEnough && !hasContentChanged) return;

  const settings = vscode.workspace.getConfiguration("tablet").get<Record<string, number>>("ringBuffer") ?? {};
  const picked = chunksAround(
    snapshot.path,
    snapshot.lines,
    snapshot.cursorLine,
    settings["scopeLines"] ?? 150,
    settings["chunkLines"] ?? 16,
  );

  runtime.ring = picked.reduce(addChunk, runtime.ring);
  runtime.lastPickLine = snapshot.cursorLine;
  runtime.lastPickHash = hash;
};

const outcomeOf = (reason: vscode.InlineCompletionEndOfLifeReason): Outcome => {
  switch (reason.kind) {
    case vscode.InlineCompletionEndOfLifeReasonKind.Accepted: {
      return { kind: "accepted" };
    }
    case vscode.InlineCompletionEndOfLifeReasonKind.Rejected: {
      return { kind: "rejected" };
    }
    case vscode.InlineCompletionEndOfLifeReasonKind.Ignored: {
      return { kind: "ignored", userTypingDisagreed: reason.userTypingDisagreed };
    }
  }
};

const writeRecord = async (runtime: Runtime, record: CollectedRecord): Promise<void> => {
  try {
    const file = await appendRecord(runtime.globalStoragePath, record);

    logInfo(runtime.output, `recorded ${record.outcome.kind} suggestion to ${file}`);
  }
  catch (error) {
    logError(runtime.output, `could not write a record: ${String(error)}`);
  }
};

/**
 * An accepted suggestion is its own resolution. A turned down one is only half a record
 * until the reader shows what they wanted instead, which the watch collects.
 */
const settle = (runtime: Runtime, pending: PendingRecord, reason: vscode.InlineCompletionEndOfLifeReason): void => {
  if (pending.record.outcome.kind !== "unresolved") return;

  const record = { ...pending.record, outcome: outcomeOf(reason) };

  pending.record = record;

  if (record.outcome.kind === "accepted") {
    void writeRecord(runtime, record);

    return;
  }

  // a watch still open from the previous suggestion writes what it has and steps aside
  runtime.watcher?.dispose();
  runtime.watcher = watchResolution(pending.document, record.window, (resolution) => {
    runtime.watcher = undefined;
    void writeRecord(runtime, { ...record, resolution });
  });
};

const RECORD_WINDOW_LINES = 21;

export const createProvider = (runtime: Runtime): vscode.InlineCompletionItemProvider => ({
  handleEndOfLifetime: (item, reason) => {
    const pending = runtime.pending.get(item) ?? runtime.lastPending;
    const score = scoreOf(outcomeOf(reason));

    if (score !== undefined) runtime.scores = withScore(runtime.scores, score);

    if (reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Accepted) {
      const accepted = runtime.lastServed?.suggestions.find(held => held.kind === "edit");

      if (accepted?.kind === "edit") notePrediction(runtime.tracker, accepted.path, accepted.text);
    }

    if (pending !== undefined) settle(runtime, pending, reason);

    // a rejection is the reader saying no to this document state, so the remembered answer
    // must not come back on the next cursor rest, and nothing else is volunteered for the
    // same state either
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
      renderStatus(runtime.status, idleStatus(active.names, active.problems), statusMarks(runtime));

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
    const reach = config.format === "fim" ? 0 : config.windowLines;
    const isNearRemembered = remembered !== undefined && remembered.suggestions.some(held =>
      held.kind === "edit" && Math.abs(held.startLine - position.line) <= reach);

    // a cursor that has moved further than the window from every remembered edit is
    // looking at something else, and gets a fresh ask
    if (remembered !== undefined
      && isNearRemembered
      && remembered.path === relativePath(document.uri)
      && remembered.text === document.getText()) {
      const items = await itemsFor(remembered.suggestions.filter(held => held.kind !== "completion"), document, position, config);

      if (items.length > 0) {
        logInfo(runtime.output, `${config.name}: re-served ${items.length} remembered suggestion(s)`);

        return items;
      }
    }

    if (isAutomatic) {
      await delay(scaledDelay(runtime, settings.get<number>("debounceMs") ?? 150));

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
      renderStatus(runtime.status, { kind: "problem", name: config.name, detail: key.problem }, statusMarks(runtime));

      return;
    }

    const headers = await resolveAll(config.headers, secretSource(runtime));

    if (!headers.ok) {
      renderStatus(runtime.status, { kind: "problem", name: config.name, detail: headers.problem }, statusMarks(runtime));

      return;
    }

    renderStatus(runtime.status, { kind: "working", name: config.name }, statusMarks(runtime));

    const exchanges: Exchange[] = [];
    const diagnostics = diagnosticsFor(document.uri, position.line);
    const definitions = await definitionChunks(document, position, snapshot);

    if (definitions.length > 0) logInfo(runtime.output, `${config.name}: ${definitions.length} definition excerpt(s) from the language server`);

    const suggestInput: SuggestInput = {
      configuration: config,
      budget: promptBudget(runtime, config),
      snapshot,
      chunks: [...runtime.ring.chunks, ...definitions],
      changes: runtime.tracker.log.edits,
      diagnostics,
      repo: vscode.workspace.workspaceFolders?.[0]?.name ?? "",
      previousByPath: runtime.tracker.previousByPath,
      candidatePaths: runtime.candidatePaths,
    };

    const ask = (): Promise<SuggestResult> => suggest(
      suggestInput,
      {
        complete: async (prompt) => {
          logInfo(runtime.output, `asking ${config.name}, ${estimateTokens(prompt)} estimated tokens`);
          logDebug(runtime.output, `prompt for ${config.name}:\n${prompt}`);

          const startedAt = Date.now();
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

          exchanges.push({
            prompt,
            reply: answer.ok ? { ok: true, texts: answer.texts } : { ok: false, failure: describeFailure(answer.failure) },
            ms: Date.now() - startedAt,
          });

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

    const first = await ask();

    // the endpoint named its real context size in the refusal, so one more ask with the
    // budget cut to fit is worth more than reporting the refusal
    if (first.kind === "failure" && first.failure.kind === "context") {
      runtime.contextLimit = first.failure.contextSize;
      logInfo(runtime.output, `${config.name}: ${describeFailure(first.failure)}, asking again within ${promptBudget(runtime, config)} tokens`);
    }

    const result = first.kind === "failure" && first.failure.kind === "context" ? await ask() : first;

    // the answer was computed from snapshotText: if the document moved on while the
    // model was thinking, the edits no longer describe what is on screen
    if (document.getText() !== snapshotText) {
      logInfo(runtime.output, `${config.name}: document changed during the request, discarding the answer`);

      return;
    }

    updateRing(runtime, snapshot);

    if (result.kind === "failure") {
      // a later keystroke cancelled this request, which is not a fault to report
      if (result.failure.kind === "aborted") return;

      const detail = describeFailure(result.failure);

      logError(runtime.output, `${config.name}: ${detail}`);

      renderStatus(runtime.status, { kind: "problem", name: config.name, detail }, statusMarks(runtime));

      return;
    }

    if (result.kind === "invalid") {
      const detail = `template names ${result.unknown.join(", ")}, which tablet cannot fill`;

      logError(runtime.output, `${config.name}: ${detail}`);
      renderStatus(runtime.status, { kind: "problem", name: config.name, detail }, statusMarks(runtime));

      return;
    }

    if (result.kind === "none") {
      const fallback = !isProse && config.format !== "fim" ? await formatFallback(runtime, document, position) : undefined;

      if (fallback !== undefined) {
        runtime.lastServed = { path: snapshot.path, text: snapshotText, suggestions: [{ kind: "format", path: snapshot.path }] };
        logInfo(runtime.output, `${config.name}: ${result.reason}, offering the formatter for a flagged line instead`);
        renderStatus(runtime.status, { kind: "idle", name: config.name, detail: "offered the formatter" }, statusMarks(runtime));

        return [fallback];
      }

      logInfo(runtime.output, `${config.name}: no suggestion, ${result.reason}`);
      renderStatus(runtime.status, { kind: "idle", name: config.name, detail: result.reason }, statusMarks(runtime));

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

    // the answer to "and after this one?" is asked while this one is still on screen, so
    // an accept finds the next suggestion already in the cache
    const leading = safe[0];
    const ahead = leading === undefined || items.length === 0 ? undefined : speculativeInput(suggestInput, leading);

    if (ahead !== undefined) {
      logInfo(runtime.output, `${config.name}: asking ahead as if the first suggestion were accepted`);

      void suggest(ahead, {
        complete: prompt => complete({
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
          signal: new AbortController().signal,
        }),
        readFile: readFileLines,
        diagnosticsFor: () => [],
        cache: runtime.cache,
      });
    }

    // a suggestion the editor cannot be given is the case that looks like a silent failure
    // from outside: the server logged an answer and nothing appeared on screen
    const detail = items.length === 0
      ? `${safe.length} answer(s) came back, none of them survived as an edit`
      : `${items.length} suggestion(s)`;

    logInfo(runtime.output, `${config.name}: ${detail} after ${exchanges.length} request(s), ${exchanges.reduce((sum, held) => sum + held.ms, 0)} ms`);

    for (const item of items) logInfo(runtime.output, `  handed to the editor: ${describeItem(item)}`);
    renderStatus(runtime.status, { kind: "idle", name: config.name, detail }, statusMarks(runtime));

    if (items.length > 0 && isCollectEnabled()) {
      const span = windowAround(snapshot.lines.length, position.line, config.format === "fim" ? RECORD_WINDOW_LINES : config.windowLines);
      const pending: PendingRecord = {
        document,
        record: {
          recordId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? "no-workspace",
          path: snapshot.path,
          languageId: snapshot.languageId,
          config: config.name,
          format: config.format,
          cursor: { line: position.line, character: position.character },
          window: { startLine: span.start, endLine: span.end - 1, text: snapshot.lines.slice(span.start, span.end).join("\n") },
          events: runtime.tracker.log.edits,
          diagnostics,
          chunks: runtime.ring.chunks,
          exchanges,
          suggestions: safe,
          outcome: { kind: "unresolved" },
          resolution: { kind: "unchanged" },
        },
      };

      for (const item of items) runtime.pending.set(item, pending);

      runtime.lastPending = pending;
    }

    return items;
  },
});
