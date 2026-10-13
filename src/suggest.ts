import { askZeta } from "./ask-zeta";
import { type Cache, readCache, writeCache } from "./cache";
import type { Config as Config } from "./config";
import type { Diagnostic } from "./context/diagnostics";
import type { RecentEdit } from "./context/recent-edits";
import { focusLine, recentFileChunks } from "./context/recent-files";
import type { Chunk } from "./context/ring-buffer";
import { isSecretPath, redactSecrets } from "./context/sanitize";
import type { CompletionResult, EndpointFailure } from "./endpoint";
import { assembleFim } from "./format/fim";
import { filterCompletion } from "./format/fim-filter";
import { assembleNextEdit, type EditTarget, finishedNextEdit, readNextEdit } from "./format/next-edit";
import { derivedRepairs, modelFirst, orderedByRelevance, uniqueBy } from "./rank";
import { lineSuffixOf, type Snapshot, windowAround } from "./snapshot";
import { diagnosticTarget, localTarget } from "./targets";

export type Suggestion
  = | { kind: "completion"; text: string; }
    | { kind: "edit"; path: string; startLine: number; startCharacter: number; endLine: number; endCharacter: number; text: string; }
    | { kind: "format"; path: string; };

export type Finish = (partial: string) => string | undefined;

/** Overrides the configuration for one ask. `finish` may end a streamed reply early. */
export type AskOptions = { finish?: Finish; maxTokens?: number | undefined; stop?: string[] | undefined; };

export type SuggestDependencies = {
  complete: (prompt: string, options?: AskOptions) => Promise<CompletionResult>;
  /** Called with the suggestions of a streamed reply's first final part, before the answer completes. */
  onPartial?: (suggestions: Suggestion[]) => void;
  readFile: (path: string) => Promise<string[] | undefined>;
  /** Diagnostics of a file, ranked by distance from the given line. */
  diagnosticsFor: (path: string, nearLine: number) => Diagnostic[];
  cache: Cache<Suggestion[]>;
};

export type SuggestInput = {
  configuration: Config;
  /** Tokens the whole prompt may hold, with the generation allowance already taken off. */
  budget: number;
  snapshot: Snapshot;
  chunks: Chunk[];
  changes: RecentEdit[];
  diagnostics: Diagnostic[];
  repo: string;
  previousByPath: ReadonlyMap<string, string[]>;
  candidatePaths: string[];
  /** Line the reader is typing on; no repair may target it yet. */
  typingLine?: number;
  isProse?: boolean;
};

export type SuggestResult
  = | { kind: "suggestions"; suggestions: Suggestion[]; }
    | { kind: "none"; reason: string; }
    | { kind: "failure"; failure: EndpointFailure; }
    | { kind: "invalid"; unknown: string[]; };

const editsFrom = (texts: string[], target: EditTarget, formatMarker: string, cursorMarker: string): Suggestion[] => {
  const edits: Suggestion[] = [];

  for (const text of texts) {
    const reply = readNextEdit(text, target, formatMarker, cursorMarker);

    if (reply.kind === "none") continue;

    if (reply.kind === "format") {
      edits.push({ kind: "format", path: target.path });

      continue;
    }

    for (const edit of reply.edits) {
      edits.push({
        kind: "edit",
        path: target.path,
        startLine: edit.startLine,
        startCharacter: edit.startCharacter,
        endLine: edit.endLine,
        endCharacter: edit.endCharacter,
        text: edit.text,
      });
    }
  }

  return uniqueBy(edits, edit => JSON.stringify(edit));
};

/**
 * Ends a streamed reply early only once its reading proposes a suggestion, and reports that to `onPartial`.
 */
export const streamedFinish = (dependencies: SuggestDependencies, finish: Finish, read: (reply: string) => Suggestion[]): Finish => (partial) => {
  const finished = finish(partial);
  const suggestions = finished === undefined ? [] : read(finished);

  if (suggestions.length === 0) return;

  dependencies.onPartial?.(suggestions);

  return finished;
};

const askFim = async (input: SuggestInput, dependencies: SuggestDependencies): Promise<SuggestResult> => {
  const { configuration: config, snapshot } = input;

  if (config.format !== "fim") return { kind: "none", reason: "the active configuration is for the other format" };

  const assembled = assembleFim({
    template: config.template,
    chunkTemplate: config.chunkTemplate,
    prefixLines: config.prefixLines,
    suffixLines: config.suffixLines,
    budget: input.budget,
    snapshot,
    chunks: input.chunks,
    repo: input.repo,
  });

  if (!assembled.ok) return { kind: "invalid", unknown: assembled.unknown };

  const cached = readCache(dependencies.cache, assembled.prompt);

  if (cached !== undefined) return { kind: "suggestions", suggestions: cached };

  const lineSuffix = lineSuffixOf(snapshot);
  const followingLines = snapshot.lines.slice(snapshot.cursorLine + 1, snapshot.cursorLine + 8);
  const read = (texts: string[]): Suggestion[] => uniqueBy(
    texts
      .map(completion => filterCompletion({ completion, lineSuffix, followingLines }))
      .filter((text): text is string => text !== undefined)
      .map((text): Suggestion => ({ kind: "completion", text })),
    suggestion => (suggestion.kind === "completion" ? suggestion.text : ""),
  );
  const firstLine: Finish = (partial) => {
    const newline = partial.indexOf("\n");

    return newline > 0 ? partial.slice(0, newline) : undefined;
  };

  const answer = await dependencies.complete(assembled.prompt, { finish: streamedFinish(dependencies, firstLine, reply => read([reply])) });

  if (!answer.ok) return { kind: "failure", failure: answer.failure };

  const suggestions = read(answer.texts);

  if (suggestions.length === 0) return { kind: "none", reason: "every completion was discarded as unusable" };

  writeCache(dependencies.cache, assembled.prompt, suggestions);

  return { kind: "suggestions", suggestions };
};

const askNextEditFor = async (
  input: SuggestInput,
  dependencies: SuggestDependencies,
  target: EditTarget,
): Promise<SuggestResult> => {
  const { configuration: config } = input;

  if (config.format !== "next-edit") return { kind: "none", reason: "the active configuration is for the other format" };

  const diagnostics = target.path === input.snapshot.path
    ? input.diagnostics
    : dependencies.diagnosticsFor(target.path, target.cursor?.line ?? Math.floor((target.windowStart + target.windowEnd) / 2));
  const derived = derivedRepairs(target, input.changes, diagnostics, target.path === input.snapshot.path ? input.typingLine : undefined);

  const assembled = assembleNextEdit({
    template: config.template,
    chunkTemplate: config.chunkTemplate,
    changeTemplate: config.changeTemplate,
    diagnosticTemplate: config.diagnosticTemplate,
    formatTemplate: config.formatTemplate,
    cursorMarker: config.cursorMarker,
    formatMarker: config.formatMarker,
    contextLines: config.contextLines,
    budget: input.budget,
    target,
    chunks: input.chunks.filter(chunk => chunk.path !== target.path),
    changes: input.changes,
    diagnostics,
  });

  if (!assembled.ok) return { kind: "invalid", unknown: assembled.unknown };

  const cached = readCache(dependencies.cache, assembled.prompt);

  if (cached !== undefined) {
    return cached.length === 0
      ? { kind: "none", reason: "the model had nothing to change here, remembered from a moment ago" }
      : { kind: "suggestions", suggestions: cached };
  }

  const read = (texts: string[]): Suggestion[] => orderedByRelevance(editsFrom(texts, target, config.formatMarker, config.cursorMarker), target, diagnostics);
  const finish = streamedFinish(dependencies, partial => finishedNextEdit(partial, target, config.cursorMarker), reply => read([reply]));
  const answer = await dependencies.complete(assembled.prompt, { finish });

  // the formatter is the last thing offered, never the first: it rewrites the whole file,
  // so anything more precise, from the model or from the window, outranks it
  const withoutModel = (): SuggestResult | undefined => {
    if (derived.edits.length > 0) return { kind: "suggestions", suggestions: derived.edits };

    return derived.requiresFormatter ? { kind: "suggestions", suggestions: [{ kind: "format", path: target.path }] } : undefined;
  };

  if (!answer.ok) return withoutModel() ?? { kind: "failure", failure: answer.failure };

  const modelEdits = read(answer.texts);

  if (modelEdits.length === 0) {
    const fallback = withoutModel();

    if (fallback !== undefined) return fallback;
  }

  const suggestions = modelFirst(modelEdits, derived.edits, target, diagnostics);

  // Prose with no suggestions is not cached, so the next rest asks again.
  if (suggestions.length > 0 || input.isProse !== true) writeCache(dependencies.cache, assembled.prompt, suggestions);

  return suggestions.length === 0
    ? { kind: "none", reason: `the model returned ${target.path} unchanged` }
    : { kind: "suggestions", suggestions };
};

/**
 * How a file ends is policy, not prediction: exactly one final newline. The model is
 * never asked about it, and the fix is offered only after everything else has settled.
 */
const finalNewlineFix = (snapshot: Snapshot): Suggestion | undefined => {
  const { lines } = snapshot;
  const last = lines[lines.length - 1];

  if (last === undefined) return undefined;

  if (last !== "") {
    return {
      kind: "edit",
      path: snapshot.path,
      startLine: lines.length - 1,
      startCharacter: last.length,
      endLine: lines.length - 1,
      endCharacter: last.length,
      text: "\n",
    };
  }

  let firstBlank = lines.length - 1;

  while (firstBlank > 0 && lines[firstBlank - 1] === "") firstBlank--;

  // an entirely blank file is left alone, and one final newline is already right
  if (firstBlank === 0 || firstBlank === lines.length - 1) return undefined;

  return {
    kind: "edit",
    path: snapshot.path,
    startLine: firstBlank,
    startCharacter: 0,
    endLine: lines.length - 1,
    endCharacter: 0,
    text: "",
  };
};

const askNextEdit = async (input: SuggestInput, dependencies: SuggestDependencies): Promise<SuggestResult> => {
  const { configuration: config } = input;

  if (config.format !== "next-edit") return { kind: "none", reason: "the active configuration is for the other format" };

  const nearby = await recentFileChunks(input, dependencies, config.contextFiles, config.windowLines);
  const withContext = { ...input, chunks: [...input.chunks, ...nearby] };
  const local = await askNextEditFor(withContext, dependencies, localTarget(input, config.windowLines));

  if (local.kind !== "none") return local;

  const atDiagnostic = diagnosticTarget(input, config.windowLines);

  if (atDiagnostic !== undefined) {
    const there = await askNextEditFor(withContext, dependencies, atDiagnostic.target);

    if (there.kind !== "none") return there;
  }

  const candidates = input.candidatePaths
    .filter(path => path !== input.snapshot.path)
    .filter(path => !isSecretPath(path))
    .slice(0, Math.max(0, config.crossFileCandidates));
  const asked = candidates.length;

  if (asked > 0) {
    const elsewhere = await Promise.allSettled(candidates.map(async (path) => {
      const read = await dependencies.readFile(path);

      if (read === undefined) return;

      const lines = read.map(line => redactSecrets(line));
      const focus = focusLine(lines, input.changes);
      const flagged = dependencies.diagnosticsFor(path, focus);
      const worst = flagged.find(diagnostic => diagnostic.severity === "error") ?? flagged[0];
      const span = windowAround(lines.length, focus === 0 ? worst?.line ?? 0 : focus, config.windowLines);

      return askNextEditFor(withContext, dependencies, {
        path,
        lines,
        windowStart: span.start,
        windowEnd: span.end,
        cursor: undefined,
        previousWindow: input.previousByPath.get(path)?.slice(span.start, span.end),
      });
    }));

    for (const result of elsewhere) {
      if (result.status === "fulfilled" && result.value !== undefined && result.value.kind !== "none") {
        return result.value;
      }
    }
  }

  const tail = finalNewlineFix(input.snapshot);

  if (tail !== undefined) return { kind: "suggestions", suggestions: [tail] };

  const reason = asked === 0
    ? local.reason
    : `${local.reason}, and none of the ${asked} candidate file(s) needed changes either`;

  return { kind: "none", reason };
};

export const suggest = async (input: SuggestInput, dependencies: SuggestDependencies): Promise<SuggestResult> => {
  // the prompt is assembled below this line, so the file that must never reach a prompt is
  // refused here rather than at each caller: completing the next line of a .env is exactly
  // the suggestion a secret should never get
  if (isSecretPath(input.snapshot.path)) return { kind: "none", reason: "the file holds secrets, so nothing was sent" };

  switch (input.configuration.format) {
    case "fim": {
      return askFim(input, dependencies);
    }
    case "next-edit": {
      return askNextEdit(input, dependencies);
    }
    case "zeta": {
      return askZeta(input, dependencies);
    }
  }
};
