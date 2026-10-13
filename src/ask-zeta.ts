import { readCache, writeCache } from "./cache";
import { recentFileChunks } from "./context/recent-files";
import type { Chunk } from "./context/ring-buffer";
import { filterCompletion } from "./format/fim-filter";
import type { EditTarget } from "./format/next-edit";
import { assembleContinuation, assembleZeta, finishedZeta, readZeta } from "./format/zeta";
import { derivedRepairs, modelFirst } from "./rank";
import { lineSuffixOf } from "./snapshot";
import { streamedFinish, type SuggestDependencies, type SuggestInput, type Suggestion, type SuggestResult } from "./suggest";
import { diagnosticTarget, localTarget } from "./targets";

const askZetaFor = async (
  input: SuggestInput,
  dependencies: SuggestDependencies,
  target: EditTarget,
  chunks: Chunk[],
): Promise<SuggestResult> => {
  const { configuration: config } = input;

  if (config.format !== "zeta") return { kind: "none", reason: "the active configuration is for the other format" };

  const derived = derivedRepairs(target, input.changes, input.diagnostics, input.typingLine);

  const assembled = assembleZeta({
    template: config.template,
    chunkTemplate: config.chunkTemplate,
    changeTemplate: config.changeTemplate,
    diagnosticTemplate: config.diagnosticTemplate,
    cursorMarker: config.cursorMarker,
    contextLines: config.contextLines,
    budget: input.budget,
    target,
    chunks: chunks.filter(chunk => chunk.path !== target.path),
    changes: input.changes,
    diagnostics: input.diagnostics,
  });

  if (!assembled.ok) return { kind: "invalid", unknown: assembled.unknown };

  const cached = readCache(dependencies.cache, assembled.prompt);

  if (cached !== undefined) {
    return cached.length === 0
      ? { kind: "none", reason: "the model had nothing to change here, remembered from a moment ago" }
      : { kind: "suggestions", suggestions: cached };
  }

  const read = (texts: string[]): Suggestion[] => texts.flatMap((text) => {
    const reply = readZeta(text, target, config.cursorMarker);

    return reply.kind === "none" ? [] : reply.edits.map((edit): Suggestion => ({ kind: "edit", path: target.path, ...edit }));
  });
  const answer = await dependencies.complete(assembled.prompt, { finish: streamedFinish(dependencies, finishedZeta, reply => read([reply])) });

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

  const suggestions = modelFirst(modelEdits, derived.edits, target, input.diagnostics);

  // Prose with no suggestions is not cached, so the next rest asks again.
  if (suggestions.length > 0 || input.isProse !== true) writeCache(dependencies.cache, assembled.prompt, suggestions);

  return suggestions.length === 0
    ? { kind: "none", reason: `the model returned ${target.path} unchanged` }
    : { kind: "suggestions", suggestions };
};

const CONTINUATION_TOKENS = 24;
const CONTINUATION_CONTEXT_LINES = 60;
const WORD_END = /[\p{L}\p{N}_$]$/u;
// zeta sometimes answers this prompt with its edit-task markers, which mean "no change" here
// and are never text to insert
const EDIT_TOKENS = ["<|marker_", "<|user_cursor|>"];

/**
 * zeta returns a half-typed word unchanged when asked for block rewrites, so this asks for the
 * text at the cursor instead.
 */
const askContinuation = async (input: SuggestInput, dependencies: SuggestDependencies): Promise<SuggestResult | undefined> => {
  const { snapshot } = input;
  const line = snapshot.lines[snapshot.cursorLine] ?? "";

  if (!WORD_END.test(line.slice(0, snapshot.cursorCharacter))) return undefined;

  const prompt = assembleContinuation(snapshot, CONTINUATION_CONTEXT_LINES);
  const cached = readCache(dependencies.cache, prompt);

  if (cached !== undefined) return { kind: "suggestions", suggestions: cached };

  const answer = await dependencies.complete(prompt, { maxTokens: CONTINUATION_TOKENS, stop: ["\n", ...EDIT_TOKENS, ...input.configuration.stop] });

  if (!answer.ok) return undefined;

  const lineSuffix = lineSuffixOf(snapshot);
  const followingLines = snapshot.lines.slice(snapshot.cursorLine + 1, snapshot.cursorLine + 8);
  const suggestions = answer.texts
    .map(completion => filterCompletion({ completion, lineSuffix, followingLines }))
    .filter(text => text !== undefined)
    .map((text): Suggestion => ({ kind: "completion", text }));

  if (suggestions.length === 0) return undefined;

  writeCache(dependencies.cache, prompt, suggestions);

  return { kind: "suggestions", suggestions };
};

/**
 * Zeta rewrites the blocks around a cursor, so the first ask is at the reader's cursor.
 * When that comes back empty and the linter flags a line elsewhere, a second ask puts
 * the cursor marker on the flagged position, which is what zed does when a diagnostic
 * arrives after an edit: the fix is offered where the error is.
 */
export const askZeta = async (input: SuggestInput, dependencies: SuggestDependencies): Promise<SuggestResult> => {
  const { configuration: config } = input;

  if (config.format !== "zeta") return { kind: "none", reason: "the active configuration is for the other format" };

  const continued = await askContinuation(input, dependencies);

  if (continued !== undefined) return continued;

  const nearby = await recentFileChunks(input, dependencies, config.contextFiles, config.windowLines);
  const chunks = [...input.chunks, ...nearby];
  const local = await askZetaFor(input, dependencies, localTarget(input, config.windowLines), chunks);

  if (local.kind !== "none") return local;

  const flagged = diagnosticTarget(input, config.windowLines);

  if (flagged === undefined) return local;

  const there = await askZetaFor(input, dependencies, {
    ...flagged.target,
    cursor: { line: flagged.diagnostic.line, character: flagged.diagnostic.character },
  }, chunks);

  return there.kind === "none" ? local : there;
};
