import * as vscode from "vscode";

import type { Exchange } from "./collect/record";
import type { Config } from "./config";
import { isSecretPath, redactSecrets } from "./context/sanitize";
import { diagnosticsFor } from "./editor-diagnostics";
import { complete, type CompletionResult, describeFailure } from "./endpoint";
import { estimateTokens } from "./format/budget";
import { uriFor } from "./format/inline-items";
import { logDebug, logInfo } from "./logger";
import { abortedCompletion } from "./requests";
import { type Ahead, promptBudget, type Runtime } from "./runtime";
import { type AskOptions, type Finish, suggest, type SuggestInput, type Suggestion, type SuggestResult } from "./suggest";
import type { AskTiming, Outcome } from "./timing";

const readFileLines = async (path: string): Promise<string[] | undefined> => {
  if (isSecretPath(path)) return undefined;

  const uri = uriFor(path);

  if (uri === undefined) return undefined;

  try {
    const document = await vscode.workspace.openTextDocument(uri);

    // Redacted here: a cross-file read is the one path where another file's secret reaches the prompt.
    return document.getText().split(/\r?\n/)
      .map(line => redactSecrets(line));
  }
  catch {
    return undefined;
  }
};

export type AskContext = {
  runtime: Runtime;
  config: Config;
  apiKey: string;
  headers: Record<string, string>;
  timeoutMs: number;
  controller: AbortController;
  isCurrent: () => boolean;
  clock: AskTiming;
  preparedFrom: number;
  isEarlyStop: boolean;
};

export type Ask = {
  run: (input: SuggestInput) => Promise<SuggestResult>;
  fromAhead: (input: SuggestInput, asked: Ahead) => Promise<SuggestResult>;
  speculate: (input: SuggestInput) => Ahead;
  /** Never settles when the reply has no final part. */
  partial: Promise<Suggestion[]>;
  exchanges: Exchange[];
  outcome: () => Extract<Outcome, "joined" | "cached" | "asked">;
};

export const createAsk = (context: AskContext): Ask => {
  const { runtime, config, clock, controller, isCurrent } = context;
  const exchanges: Exchange[] = [];
  let isJoined = false;
  let hasPartial = false;
  let resolvePartial: ((suggestions: Suggestion[]) => void) | undefined;
  // ES2023 target: Promise.withResolvers is not available.
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
  const partial = new Promise<Suggestion[]>((resolve) => {
    resolvePartial = resolve;
  });
  const notePartial = (suggestions: Suggestion[]): void => {
    if (hasPartial) return;

    hasPartial = true;
    resolvePartial?.(suggestions);
  };

  // Once a part is shown, read the stream to its end unless this ask may stop early.
  const streamed = (finish: Finish | undefined): Finish | undefined => (finish === undefined
    ? undefined
    : (text) => {
        if (hasPartial && !context.isEarlyStop) return;

        const finished = finish(text);

        return context.isEarlyStop ? finished : undefined;
      });

  const request = (prompt: string, signal: AbortSignal, isAhead: boolean, isRelevant: () => boolean, options: AskOptions = {}): Promise<CompletionResult> => {
    const finish = options.finish;

    const scheduledAt = Date.now();

    return runtime.replies.join(prompt, signal, isAhead, isRelevant, (scheduledSignal) => {
      if (!isAhead) clock.steps.queue = (clock.steps.queue ?? 0) + Date.now() - scheduledAt;

      return complete({
        endpoint: config.endpoint,
        apiKey: context.apiKey,
        headers: context.headers,
        model: config.model,
        prompt,
        maxTokens: options.maxTokens ?? config.maxTokens,
        temperature: config.temperature,
        stop: options.stop ?? config.stop,
        extraBody: config.extraBody,
        timeoutMs: context.timeoutMs,
        signal: scheduledSignal,
        ...(finish !== undefined && { finish }),
      });
    });
  };

  const completeForeground = async (prompt: string, options: AskOptions = {}): Promise<CompletionResult> => {
    if (!isCurrent()) return abortedCompletion();

    clock.steps.prepare ??= Date.now() - context.preparedFrom;
    logInfo(runtime.output, `asking ${config.name}, ${estimateTokens(prompt)} estimated tokens`);
    logDebug(runtime.output, `prompt for ${config.name}:\n${prompt}`);

    const isShared = runtime.replies.isRunning(prompt);
    const startedAt = Date.now();
    const finish = streamed(options.finish);
    const reply = request(prompt, controller.signal, false, isCurrent, { ...options, ...(finish !== undefined && { finish }) });

    // A request shared with this ask survives the abort below.
    runtime.ahead?.controller.abort();
    runtime.ahead = undefined;

    if (isShared) {
      isJoined = true;
      logInfo(runtime.output, `${config.name}: joined a request already running for the same prompt`);
    }

    let answer = await reply;

    // A shared request may be speculation skipped for want of a slot, so this ask cannot reuse it.
    if (isShared && !answer.ok && answer.failure.kind === "aborted" && isCurrent()) answer = await request(prompt, controller.signal, false, isCurrent, { maxTokens: options.maxTokens, stop: options.stop });

    logDebug(runtime.output, answer.ok
      ? `reply for ${config.name}:\n${answer.texts.join("\n---\n")}`
      : `reply for ${config.name}: ${describeFailure(answer.failure)}`);

    exchanges.push({
      prompt,
      reply: answer.ok ? { ok: true, texts: answer.texts } : { ok: false, failure: describeFailure(answer.failure) },
      ms: Date.now() - startedAt,
    });

    return answer;
  };

  const ask = (input: SuggestInput, budget: number): Promise<SuggestResult> => suggest({ ...input, budget }, {
    complete: completeForeground,
    onPartial: notePartial,
    readFile: readFileLines,
    diagnosticsFor: (path, nearLine) => {
      const uri = uriFor(path);

      return uri === undefined ? [] : diagnosticsFor(uri, nearLine);
    },
    cache: runtime.cache,
  });

  const run = async (input: SuggestInput): Promise<SuggestResult> => {
    const first = await ask(input, input.budget);

    if (!isCurrent() || first.kind !== "failure" || first.failure.kind !== "context") return first;

    // The endpoint names its real context size in the refusal; ask again within it.
    runtime.contextLimit = first.failure.contextSize;
    logInfo(runtime.output, `${config.name}: ${describeFailure(first.failure)}, asking again within ${promptBudget(runtime, config)} tokens`);

    return ask(input, promptBudget(runtime, config));
  };

  return {
    run,
    fromAhead: async (input, asked) => {
      isJoined = true;

      const answer = await asked.result;

      logInfo(runtime.output, `${config.name}: answered by the request asked ahead`);

      return answer.kind === "failure" && isCurrent() ? run(input) : answer;
    },
    speculate: (input) => {
      const aheadController = new AbortController();
      const isWanted = (): boolean => !aheadController.signal.aborted;
      const answer = async (): Promise<SuggestResult> => {
        try {
          return await suggest(input, {
            complete: (prompt, options) => request(prompt, aheadController.signal, true, isWanted, { maxTokens: options?.maxTokens, stop: options?.stop }),
            readFile: readFileLines,
            diagnosticsFor: () => [],
            cache: runtime.cache,
          });
        }
        catch {
          aheadController.abort();

          return { kind: "failure", failure: { kind: "aborted" } };
        }
      };

      return { controller: aheadController, path: input.snapshot.path, text: input.snapshot.lines.join("\n"), result: answer() };
    },
    partial,
    exchanges,
    outcome: () => {
      if (isJoined) return "joined";

      return exchanges.length === 0 ? "cached" : "asked";
    },
  };
};
