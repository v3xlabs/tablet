import * as vscode from "vscode";

import { createAsk } from "./ask";
import { holdRecord, outcomeOf, settle } from "./collect/settle";
import { isLanguageEnabled, isProseLanguage, proseProfile } from "./config";
import { notePrediction } from "./context/recent-edits";
import { hasSecret } from "./context/sanitize";
import { scoreOf, withScore } from "./eagerness";
import { diagnosticsFor, withoutUnfinished } from "./editor-diagnostics";
import { describeFailure } from "./endpoint";
import { describeItem, formatFallback, itemsFor } from "./format/inline-items";
import { logError, logInfo } from "./logger";
import { type QuickFix, rankedWithFixes, withFixTitles } from "./quickfix";
import { carriedFrom, rebaseSuggestions } from "./rebase";
import { activeConfig, isAutomaticEnabled, isCollectEnabled, isSnoozed, noteFile, noteLanded, promptBudget, relativePath, type Runtime, scaledDelay, statusMarks, syncConfig, typingLine, updateRing } from "./runtime";
import { parseSecretSpec, resolveAll, resolveSecret, type SecretSource } from "./secret";
import { type Snapshot } from "./snapshot";
import { speculativeInput } from "./speculate";
import { idleStatus, renderStatus } from "./status-bar";
import { type SuggestInput, type Suggestion } from "./suggest";
import { finishAsk, startAsk } from "./timing";

const secretSource = (runtime: Runtime): SecretSource => ({
  environment: process.env,
  read: name => runtime.secrets.get(name),
});

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

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
    runtime.landed = undefined;
  },

  provideInlineCompletionItems: async (document, position, context, token) => {
    const settings = vscode.workspace.getConfiguration("tablet");
    const isAutomatic = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;

    if (isAutomatic && (!isAutomaticEnabled(runtime) || isSnoozed(runtime))) return;

    const active = activeConfig(runtime);

    syncConfig(runtime, active);

    if (active.configuration === undefined) {
      renderStatus(runtime.status, idleStatus(active.names, active.problems), statusMarks(runtime));

      return;
    }

    if (!isLanguageEnabled(settings.get<Record<string, boolean>>("languages") ?? {}, document.languageId)) {
      return;
    }

    const path = relativePath(document.uri);
    const text = document.getText();
    const version = document.version;
    const owner = runtime.foreground.begin(path);
    const controller = owner.controller;
    const retained = runtime.foreground.previous();
    const previous = retained !== undefined && runtime.inFlight?.controller === retained.controller ? runtime.inFlight : undefined;
    const cancellation = token.onCancellationRequested(() => runtime.foreground.cancel(owner));
    const clock = startAsk();
    const identity = runtime.configIdentity;
    const isCurrent = (): boolean => runtime.foreground.owns(owner)
      && !token.isCancellationRequested && !document.isClosed && document.version === version
      && identity === runtime.configIdentity
      && (!isAutomatic || (isAutomaticEnabled(runtime) && !isSnoozed(runtime)));

    try {
      if (!isCurrent()) return;

      const declined = runtime.declined;
      const longRest = runtime.longRest;
      const isLongRest = longRest?.uri === document.uri.toString() && longRest.version === version;

      runtime.longRest = undefined;

      if (isLongRest) runtime.declined = undefined;
      else if (declined !== undefined && declined.path === path && declined.text === text) return;

      const isProse = isProseLanguage(settings.get<string[]>("proseLanguages") ?? [], document.languageId);

      const config = isProse ? proseProfile(active.configuration) : active.configuration;

      const shown = runtime.lastServed;

      if (shown !== undefined && shown.path === path && shown.text !== text) {
        const carried = rebaseSuggestions(shown.suggestions, path, shown.text, text);

        runtime.lastServed = carried.isAgreed && carried.suggestions.length > 0
          ? { path, text, suggestions: carried.suggestions }
          : undefined;
      }

      const snapshot: Snapshot = {
        path,
        languageId: document.languageId,
        lines: text.split(/\r?\n/),
        cursorLine: position.line,
        cursorCharacter: position.character,
      };
      const snapshotText = text;
      const offset = snapshot.lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;

      const remembered = runtime.lastServed;
      const reach = config.format === "fim" ? 0 : config.windowLines;
      const reservable = remembered?.suggestions.filter(held => (held.kind === "completion" ? remembered.offset === offset : true)) ?? [];
      const isNearRemembered = reservable.some(held =>
        held.kind === "completion" || (held.kind === "edit" && Math.abs(held.startLine - position.line) <= reach));

      if (remembered !== undefined && isNearRemembered && remembered.path === path && remembered.text === text) {
        const items = await itemsFor(reservable, document, position, config);

        if (!isCurrent()) return;

        if (items.length > 0) {
          logInfo(runtime.output, `${config.name}: re-served ${items.length} remembered suggestion(s)`);
          finishAsk(runtime.timing, clock, "reserved");

          return items;
        }
      }

      const landed = runtime.landed;
      const rebasedLanded = landed === undefined || landed.path !== path || landed.text === text
        ? undefined
        : rebaseSuggestions(landed.suggestions, path, landed.text, text, landed.offset);
      const carriedLate = rebasedLanded?.isAgreed === true ? withoutSecrets(rebasedLanded.suggestions) : [];

      if (carriedLate.length > 0) {
        const items = await itemsFor(carriedLate, document, position, config);

        if (!isCurrent()) return;

        if (items.length > 0) {
          runtime.lastServed = { path, text, suggestions: carriedLate };
          runtime.lastPending = undefined;
          logInfo(runtime.output, `${config.name}: carried ${items.length} suggestion(s) from an answer to an earlier text`);
          finishAsk(runtime.timing, clock, "carried");

          return items;
        }
      }

      const ahead = runtime.ahead;
      const aheadHit = ahead !== undefined && ahead.path === path && ahead.text === text.replaceAll("\r\n", "\n") ? ahead : undefined;

      if (aheadHit !== undefined) {
        runtime.ahead = undefined;
        controller.signal.addEventListener("abort", () => aheadHit.controller.abort(), { once: true });
      }

      const debounceMs = scaledDelay(runtime, settings.get<number>("debounceMs") ?? 150);
      const typing = typingLine(runtime, document, position.line, isAutomatic);
      const fixLookup = aheadHit === undefined ? runtime.quickFixes.near(document, path, position.line, reach, typing) : Promise.resolve([]);
      const debounce = isAutomatic && aheadHit === undefined ? delay(debounceMs) : Promise.resolve();

      const serveFix = async (fixes: QuickFix[] | undefined): Promise<vscode.InlineCompletionItem[] | undefined> => {
        const fix = fixes?.find(held => held.line === position.line);

        if (fix === undefined) return undefined;

        const items = await itemsFor([fix.edit], document, position, config);

        if (!isCurrent() || items.length === 0) return undefined;

        runtime.lastServed = { path, text, suggestions: [fix.edit] };
        logInfo(runtime.output, `${config.name}: offered the language server's quick fix "${fix.title}"`);
        renderStatus(runtime.status, { kind: "idle", name: config.name, detail: "quick fix" }, statusMarks(runtime));
        finishAsk(runtime.timing, clock, "quickfix");

        return items;
      };

      const waited = async (): Promise<undefined> => {
        await debounce;
      };
      const early = await serveFix(await Promise.race([fixLookup, waited()]));

      if (early !== undefined || !isCurrent()) return early;

      await debounce;

      if (!isCurrent()) return;

      const fixes = await fixLookup;

      if (!isCurrent()) return;

      const fixed = await serveFix(fixes);

      if (fixed !== undefined || !isCurrent()) return fixed;

      clock.steps.debounce = Date.now() - clock.startedAt;

      const preparedFrom = Date.now();

      noteFile(runtime, snapshot.path);

      const key = await resolveSecret(parseSecretSpec(config.apiKey), secretSource(runtime));

      if (!isCurrent()) return;

      if (!key.ok) {
        renderStatus(runtime.status, { kind: "problem", name: config.name, detail: key.problem }, statusMarks(runtime));

        return;
      }

      const headers = await resolveAll(config.headers, secretSource(runtime));

      if (!isCurrent()) return;

      if (!headers.ok) {
        renderStatus(runtime.status, { kind: "problem", name: config.name, detail: headers.problem }, statusMarks(runtime));

        return;
      }

      renderStatus(runtime.status, { kind: "working", name: config.name }, statusMarks(runtime));

      const reported = runtime.diagnostics.adjust(document, diagnosticsFor(document.uri, position.line));
      const diagnostics = withFixTitles(withoutUnfinished(reported, typing), fixes);
      const definitions = isProse ? [] : runtime.definitions.read(document, position);

      logInfo(runtime.output, `${config.name}: ready in ${Date.now() - clock.startedAt} ms (debounce ${clock.steps.debounce} ms), ${definitions.length} cached definition excerpt(s)`);

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
        ...(typing !== undefined && { typingLine: typing }),
        isProse,
      };

      const ask = createAsk({
        runtime,
        config,
        apiKey: key.value,
        headers: headers.values,
        timeoutMs: settings.get<number>("requestTimeoutMs") ?? 10_000,
        controller,
        isCurrent,
        clock,
        preparedFrom,
        isEarlyStop: settings.get<boolean>("earlyStop") ?? false,
      });

      owner.started = true;

      const running = aheadHit === undefined ? ask.run(suggestInput) : ask.fromAhead(suggestInput, aheadHit);

      runtime.inFlight = { controller, path, text: snapshotText, offset, result: running };
      void noteLanded(runtime, { path, text: snapshotText, offset }, running);

      const carried = previous === undefined || previous.path !== path
        ? undefined
        : await carriedFrom(previous, running, path, snapshotText);

      if (!isCurrent()) {
        finishAsk(runtime.timing, clock, "obsolete");

        return;
      }

      const late = withoutSecrets(carried ?? []);

      if (late.length > 0) {
        const items = await itemsFor(late, document, position, config);

        if (!isCurrent()) return;

        controller.abort();

        if (runtime.inFlight?.result === running) runtime.inFlight = undefined;

        runtime.lastServed = { path, text: snapshotText, suggestions: late };
        runtime.lastPending = undefined;

        logInfo(runtime.output, `${config.name}: carried ${items.length} suggestion(s) from the answer to the text before the last keystroke`);
        finishAsk(runtime.timing, clock, "carried");
        renderStatus(runtime.status, { kind: "idle", name: config.name, detail: `${items.length} suggestion(s)` }, statusMarks(runtime));

        return items;
      }

      const speculateFrom = (leading: Suggestion | undefined): void => {
        const aheadInput = leading === undefined ? undefined : speculativeInput(suggestInput, leading);

        if (aheadInput === undefined) return;

        logInfo(runtime.output, `${config.name}: asking ahead as if the first suggestion were accepted`);
        runtime.ahead?.controller.abort();
        runtime.ahead = ask.speculate(aheadInput);
      };

      const isProgressive = settings.get<boolean>("progressive") ?? true;
      const earliest = isProgressive ? await Promise.race([running, ask.partial]) : undefined;

      if (Array.isArray(earliest) && isCurrent()) {
        const partial = withoutSecrets(earliest);
        const items = await itemsFor(partial, document, position, config);

        if (!isCurrent()) return;

        if (items.length > 0) {
          const served = { path, text, offset, suggestions: partial };
          const upgrade = async (): Promise<void> => {
            const result = await running;

            if (runtime.lastServed !== served || document.version !== version || result.kind !== "suggestions") return;

            const whole = withoutSecrets(rankedWithFixes(result.suggestions, fixes));

            clock.steps.response = ask.exchanges.reduce((sum, held) => sum + held.ms, 0);
            finishAsk(runtime.timing, clock, ask.outcome());
            speculateFrom(whole[0]);

            if (JSON.stringify(whole) === JSON.stringify(partial)) return;

            runtime.lastServed = { path, text, offset, suggestions: whole };
            await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
          };

          runtime.lastServed = served;
          clock.steps.partial = Date.now() - clock.startedAt;
          logInfo(runtime.output, `${config.name}: showed the first final part of the reply after ${clock.steps.partial} ms`);
          void upgrade();

          return items;
        }
      }

      const result = await running;

      if (!isCurrent()) {
        finishAsk(runtime.timing, clock, "obsolete");

        return;
      }

      clock.steps.response = ask.exchanges.reduce((sum, held) => sum + held.ms, 0);

      if (runtime.inFlight?.result === running) runtime.inFlight = undefined;

      updateRing(runtime, snapshot);

      if (result.kind === "failure") {
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

      const answered = rankedWithFixes(result.kind === "suggestions" ? result.suggestions : [], fixes);

      if (result.kind === "none" && answered.length === 0) {
        const fallback = typing === undefined && !isProse && config.format !== "fim" ? await formatFallback(document, position) : undefined;

        if (!isCurrent()) return;

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

      const safe = withoutSecrets(answered);
      const renderedFrom = Date.now();
      const items = await itemsFor(safe, document, position, config);

      if (!isCurrent()) return;

      clock.steps.render = Date.now() - renderedFrom;

      runtime.lastServed = { path: snapshot.path, text: snapshotText, offset, suggestions: safe };

      if (items.length > 0) speculateFrom(safe[0]);

      const detail = items.length === 0
        ? `${safe.length} answer(s) came back, none of them survived as an edit`
        : `${items.length} suggestion(s)`;

      logInfo(runtime.output, `${config.name}: ${detail} after ${ask.exchanges.length} request(s), ${clock.steps.response} ms endpoint, ${Date.now() - clock.startedAt} ms total`);

      if (items.length > 0) finishAsk(runtime.timing, clock, ask.outcome());

      for (const item of items) logInfo(runtime.output, `  handed to the editor: ${describeItem(item)}`);
      renderStatus(runtime.status, { kind: "idle", name: config.name, detail }, statusMarks(runtime));

      if (items.length > 0 && isCollectEnabled()) {
        holdRecord(runtime, items, document, snapshot, config.format === "fim" ? undefined : config.windowLines, {
          config: config.name,
          format: config.format,
          events: runtime.tracker.log.edits,
          diagnostics,
          chunks: runtime.ring.chunks,
          exchanges: ask.exchanges,
          suggestions: safe,
        });
      }

      return items;
    }
    finally {
      cancellation.dispose();
    }
  },
});
