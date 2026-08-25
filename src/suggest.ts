import { type Cache, readCache, writeCache } from "./cache";
import type { Config as Config } from "./config";
import type { RecentEdit } from "./context/recent-edits";
import type { Chunk } from "./context/ring-buffer";
import type { CompletionResult, EndpointFailure } from "./endpoint";
import { assembleFim } from "./format/fim";
import { filterCompletion } from "./format/fim-filter";
import { assembleNextEdit, type EditTarget, readNextEdit } from "./format/next-edit";
import { lineSuffixOf, type Snapshot, windowAround } from "./snapshot";

export type Suggestion
  = | { kind: "completion"; text: string; }
    | { kind: "edit"; path: string; startLine: number; endLine: number; text: string; };

export type SuggestDependencies = {
  complete: (prompt: string) => Promise<CompletionResult>;
  readFile: (path: string) => Promise<string[] | undefined>;
  cache: Cache<Suggestion[]>;
};

export type SuggestInput = {
  configuration: Config;
  snapshot: Snapshot;
  chunks: Chunk[];
  changes: RecentEdit[];
  repo: string;
  previousLines: string[] | undefined;
  candidatePaths: string[];
};

export type SuggestResult
  = | { kind: "suggestions"; suggestions: Suggestion[]; }
    | { kind: "none"; }
    | { kind: "failure"; failure: EndpointFailure; }
    | { kind: "invalid"; unknown: string[]; };

const WORD = /[A-Za-z_$][\w$]*/g;

const wordsIn = (text: string): Set<string> => new Set(text.match(WORD));

/**
 * A rename leaves the old identifier behind in every file that has not caught up yet, so
 * the line holding it is the place worth showing the model in a file the cursor is not in.
 */
export const focusLine = (lines: string[], changes: RecentEdit[]): number => {
  const removed = new Set<string>();

  for (const change of changes) {
    const after = wordsIn(change.after);

    for (const word of wordsIn(change.before)) {
      if (!after.has(word)) removed.add(word);
    }
  }

  if (removed.size === 0) return 0;

  const hit = lines.findIndex(line => [...wordsIn(line)].some(word => removed.has(word)));

  return hit === -1 ? 0 : hit;
};

const uniqueBy = <T>(items: T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();

  return items.filter((item) => {
    const signature = key(item);

    if (seen.has(signature)) return false;

    seen.add(signature);

    return true;
  });
};

const localTarget = (input: SuggestInput, windowLines: number): EditTarget => {
  const { snapshot } = input;
  const span = windowAround(snapshot.lines.length, snapshot.cursorLine, windowLines);

  return {
    path: snapshot.path,
    lines: snapshot.lines,
    windowStart: span.start,
    windowEnd: span.end,
    cursor: { line: snapshot.cursorLine, character: snapshot.cursorCharacter },
    previousWindow: input.previousLines?.slice(span.start, span.end),
  };
};

const editsFrom = (texts: string[], target: EditTarget): Suggestion[] => {
  const edits: Suggestion[] = [];

  for (const text of texts) {
    const edit = readNextEdit(text, target);

    if (edit === undefined) continue;

    edits.push({
      kind: "edit",
      path: target.path,
      startLine: edit.startLine,
      endLine: edit.endLine,
      text: edit.text,
    });
  }

  return uniqueBy(edits, edit => JSON.stringify(edit));
};

const askFim = async (input: SuggestInput, dependencies: SuggestDependencies): Promise<SuggestResult> => {
  const { configuration: config, snapshot } = input;

  if (config.format !== "fim") return { kind: "none" };

  const assembled = assembleFim({
    template: config.template,
    chunkTemplate: config.chunkTemplate,
    prefixLines: config.prefixLines,
    suffixLines: config.suffixLines,
    snapshot,
    chunks: input.chunks,
    repo: input.repo,
  });

  if (!assembled.ok) return { kind: "invalid", unknown: assembled.unknown };

  const cached = readCache(dependencies.cache, assembled.prompt);

  if (cached !== undefined) return { kind: "suggestions", suggestions: cached };

  const answer = await dependencies.complete(assembled.prompt);

  if (!answer.ok) return { kind: "failure", failure: answer.failure };

  const lineSuffix = lineSuffixOf(snapshot);
  const followingLines = snapshot.lines.slice(snapshot.cursorLine + 1, snapshot.cursorLine + 8);

  const suggestions = uniqueBy(
    answer.texts
      .map(completion => filterCompletion({ completion, lineSuffix, followingLines }))
      .filter((text): text is string => text !== undefined)
      .map((text): Suggestion => ({ kind: "completion", text })),
    suggestion => (suggestion.kind === "completion" ? suggestion.text : ""),
  );

  if (suggestions.length === 0) return { kind: "none" };

  writeCache(dependencies.cache, assembled.prompt, suggestions);

  return { kind: "suggestions", suggestions };
};

const askNextEditFor = async (
  input: SuggestInput,
  dependencies: SuggestDependencies,
  target: EditTarget,
): Promise<SuggestResult> => {
  const { configuration: config } = input;

  if (config.format !== "next-edit") return { kind: "none" };

  const assembled = assembleNextEdit({
    template: config.template,
    chunkTemplate: config.chunkTemplate,
    changeTemplate: config.changeTemplate,
    cursorMarker: config.cursorMarker,
    contextLines: config.contextLines,
    target,
    chunks: input.chunks.filter(chunk => chunk.path !== target.path),
    changes: input.changes,
  });

  if (!assembled.ok) return { kind: "invalid", unknown: assembled.unknown };

  const cached = readCache(dependencies.cache, assembled.prompt);

  if (cached !== undefined) {
    return cached.length === 0 ? { kind: "none" } : { kind: "suggestions", suggestions: cached };
  }

  const answer = await dependencies.complete(assembled.prompt);

  if (!answer.ok) return { kind: "failure", failure: answer.failure };

  const suggestions = editsFrom(answer.texts, target);

  writeCache(dependencies.cache, assembled.prompt, suggestions);

  return suggestions.length === 0 ? { kind: "none" } : { kind: "suggestions", suggestions };
};

const askNextEdit = async (input: SuggestInput, dependencies: SuggestDependencies): Promise<SuggestResult> => {
  const { configuration: config } = input;

  if (config.format !== "next-edit") return { kind: "none" };

  const local = await askNextEditFor(input, dependencies, localTarget(input, config.windowLines));

  if (local.kind !== "none") return local;

  const candidates = input.candidatePaths
    .filter(path => path !== input.snapshot.path)
    .slice(0, Math.max(0, config.crossFileCandidates));

  for (const path of candidates) {
    const lines = await dependencies.readFile(path);

    if (lines === undefined) continue;

    const span = windowAround(lines.length, focusLine(lines, input.changes), config.windowLines);

    const elsewhere = await askNextEditFor(input, dependencies, {
      path,
      lines,
      windowStart: span.start,
      windowEnd: span.end,
      cursor: undefined,
      previousWindow: undefined,
    });

    if (elsewhere.kind !== "none") return elsewhere;
  }

  return { kind: "none" };
};

export const suggest = async (input: SuggestInput, dependencies: SuggestDependencies): Promise<SuggestResult> =>
  (input.configuration.format === "fim" ? askFim(input, dependencies) : askNextEdit(input, dependencies));

