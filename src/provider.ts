import * as vscode from "vscode";

import type { Exchange } from "./collect/record";
import { outcomeOf, settle } from "./collect/settle";
import { isLanguageEnabled, isProseLanguage, proseProfile } from "./config";
import type { Diagnostic } from "./context/diagnostics";
import { notePrediction } from "./context/recent-edits";
import { addChunk, chunksAround } from "./context/ring-buffer";
import { hasSecret, isSecretPath, redactSecrets } from "./context/sanitize";
import { scoreOf, withScore } from "./eagerness";
import { complete, type CompletionResult, describeFailure } from "./endpoint";
import { estimateTokens } from "./format/budget";
import { describeItem, formatFallback, itemsFor, uriFor } from "./format/inline-items";
import { logDebug, logError, logInfo } from "./logger";
import { definitionChunks } from "./lsp";
import { carriedFrom, rebaseSuggestions } from "./rebase";
import { activeConfig, isAutomaticEnabled, isCollectEnabled, isSnoozed, noteFile, type PendingRecord, promptBudget, relativePath, type Runtime, scaledDelay, statusMarks } from "./runtime";
import { parseSecretSpec, resolveAll, resolveSecret, type SecretSource } from "./secret";
import { type Snapshot, windowAround } from "./snapshot";
import { speculativeInput } from "./speculate";
import { idleStatus, renderStatus } from "./status-bar";
import { suggest, type SuggestInput, type Suggestion, type SuggestResult } from "./suggest";

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

const RECORD_WINDOW_LINES = 21;

/**
 * A model that autocompletes a secret the reader is typing is worse than no help, so any
 * answer that carries one is dropped before it reaches the editor or the cache.
 */
const withoutSecrets = (suggestions: Suggestion[]): Suggestion[] =>
  suggestions.filter(suggestion => suggestion.kind === "format" || !hasSecret(suggestion.text));

export const createProvider = (runtime: Runtime): vscode.InlineCompletionItemProvider => ({
  handleEndOfLifetime: (item, reason) => {
    const pending = runtime.pending.get(item) ?? runtime.lastPending;
    const score = scoreOf(outcomeOf(reason));

    // a suggestion hidden by a snooze was in the way of editing, not wrong, so it does
    // not count against the eagerness
    if (score !== undefined && !isSnoozed(runtime)) runtime.scores = withScore(runtime.scores, score);

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

    if (isAutomatic && (!isAutomaticEnabled(runtime) || isSnoozed(runtime))) return;

    const active = activeConfig(runtime);

    if (active.configuration === undefined) {
      renderStatus(runtime.status, idleStatus(active.names, active.problems), statusMarks(runtime));

      return;
    }

    if (!isLanguageEnabled(settings.get<Record<string, boolean>>("languages") ?? {}, document.languageId)) {
      return;
    }

    const path = relativePath(document.uri);
    const text = document.getText();

    // the answer the reader turned down is still in the prompt cache, so the next cursor
    // rest would bring it straight back. Nothing is offered until the text changes or
    // the reader asks by hand, which clears the refusal
    const declined = runtime.declined;

    if (declined !== undefined && declined.path === path && declined.text === text) return;

    const isProse = isProseLanguage(settings.get<string[]>("proseLanguages") ?? [], document.languageId);

    // prose gets a bounded profile: the model answers a sentence, not a paragraph
    const config = isProse ? proseProfile(active.configuration) : active.configuration;

    // typing what the suggestion on screen proposes, or accepting one of several edits,
    // leaves the rest of the answer standing, so it is carried over the change instead of
    // asked for again. Typing anything else asks afresh
    const shown = runtime.lastServed;

    if (shown !== undefined && shown.path === path && shown.text !== text) {
      const carried = rebaseSuggestions(shown.suggestions, path, shown.text, text);

      runtime.lastServed = carried.isAgreed && carried.suggestions.length > 0
        ? { path, text, suggestions: carried.suggestions }
        : undefined;
    }

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
    if (remembered !== undefined && isNearRemembered && remembered.path === path && remembered.text === text) {
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

    // the request before this one keeps running past the keystroke that cancelled its
    // call: its answer may still fit once carried over the typing, the way zed reuses a
    // late prediction. It is dropped once this call is cancelled in turn, so at most two
    // requests hold a server slot
    const previous = runtime.inFlight;

    if (previous !== undefined && previous.path !== path) previous.controller.abort();

    const controller = new AbortController();

    token.onCancellationRequested(() => previous?.controller.abort());

    const snapshot = snapshotOf(document, position);
    const snapshotText = text;

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

    const request = (prompt: string, signal: AbortSignal): Promise<CompletionResult> => complete({
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
      signal,
    });

    const ask = (budget: number): Promise<SuggestResult> => suggest(
      { ...suggestInput, budget },
      {
        complete: async (prompt) => {
          logInfo(runtime.output, `asking ${config.name}, ${estimateTokens(prompt)} estimated tokens`);
          logDebug(runtime.output, `prompt for ${config.name}:\n${prompt}`);

          // an accept lands on the state that was asked ahead, so the request already
          // running for it is awaited instead of asked again. Any other prompt means the
          // reader went elsewhere, and the guess stops holding a server slot
          const joined = runtime.ahead?.replies.get(prompt);

          if (joined === undefined) runtime.ahead?.controller.abort();
          else logInfo(runtime.output, `${config.name}: joined the request asked ahead`);

          const startedAt = Date.now();
          const answer = await (joined ?? request(prompt, controller.signal));

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

    const run = async (): Promise<SuggestResult> => {
      const first = await ask(suggestInput.budget);

      if (first.kind !== "failure" || first.failure.kind !== "context") return first;

      // the endpoint named its real context size in the refusal, so one more ask with the
      // budget cut to fit is worth more than reporting the refusal
      runtime.contextLimit = first.failure.contextSize;
      logInfo(runtime.output, `${config.name}: ${describeFailure(first.failure)}, asking again within ${promptBudget(runtime, config)} tokens`);

      return ask(promptBudget(runtime, config));
    };

    const running = run();

    runtime.inFlight = { controller, path, text: snapshotText, result: running };

    const carried = previous === undefined || previous.path !== path
      ? undefined
      : await carriedFrom(previous, running, path, snapshotText);
    const late = withoutSecrets(carried ?? []);

    if (late.length > 0 && !token.isCancellationRequested) {
      // the older answer already fits what is on screen, so the newer request only holds a slot
      controller.abort();
      runtime.inFlight = undefined;
      runtime.lastServed = { path, text: snapshotText, suggestions: late };
      runtime.lastPending = undefined;

      const items = await itemsFor(late, document, position, config);

      logInfo(runtime.output, `${config.name}: carried ${items.length} suggestion(s) from the answer to the text before the last keystroke`);
      renderStatus(runtime.status, { kind: "idle", name: config.name, detail: `${items.length} suggestion(s)` }, statusMarks(runtime));

      return items;
    }

    const result = await running;

    // the answer was computed from snapshotText: if the document moved on while the
    // model was thinking, the edits no longer describe what is on screen. The request
    // stays in runtime.inFlight, where the next ask can still carry it over the typing
    if (document.getText() !== snapshotText) {
      logInfo(runtime.output, `${config.name}: document changed during the request, leaving the answer to the next ask`);

      return;
    }

    if (runtime.inFlight?.result === running) runtime.inFlight = undefined;

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
      const fallback = !isProse && config.format !== "fim" ? await formatFallback(document, position) : undefined;

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

    const safe = withoutSecrets(result.suggestions);

    runtime.lastServed = { path: snapshot.path, text: snapshotText, suggestions: safe };

    const items = await itemsFor(safe, document, position, config);

    // the answer to "and after this one?" is asked while this one is still on screen, so
    // an accept finds the next suggestion already in the cache
    const leading = safe[0];
    const ahead = leading === undefined || items.length === 0 ? undefined : speculativeInput(suggestInput, leading);

    if (ahead !== undefined) {
      logInfo(runtime.output, `${config.name}: asking ahead as if the first suggestion were accepted`);

      runtime.ahead?.controller.abort();

      const asked = { controller: new AbortController(), replies: new Map<string, Promise<CompletionResult>>() };

      runtime.ahead = asked;

      void suggest(ahead, {
        complete: (prompt) => {
          const reply = request(prompt, asked.controller.signal);

          asked.replies.set(prompt, reply);

          return reply;
        },
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
