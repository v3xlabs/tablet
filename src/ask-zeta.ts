import { readCache, writeCache } from "./cache";
import { recentFileChunks } from "./context/recent-files";
import type { Chunk } from "./context/ring-buffer";
import type { EditTarget } from "./format/next-edit";
import { assembleZeta, readZeta } from "./format/zeta";
import { derivedRepairs, modelFirst } from "./rank";
import type { SuggestDependencies, SuggestInput, Suggestion, SuggestResult } from "./suggest";
import { diagnosticTarget, localTarget } from "./targets";

const askZetaFor = async (
  input: SuggestInput,
  dependencies: SuggestDependencies,
  target: EditTarget,
  chunks: Chunk[],
): Promise<SuggestResult> => {
  const { configuration: config } = input;

  if (config.format !== "zeta") return { kind: "none", reason: "the active configuration is for the other format" };

  const derived = derivedRepairs(target, input.changes, input.diagnostics);

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

  const answer = await dependencies.complete(assembled.prompt);

  const withoutModel = (): SuggestResult | undefined => {
    if (derived.edits.length > 0) return { kind: "suggestions", suggestions: derived.edits };

    return derived.requiresFormatter ? { kind: "suggestions", suggestions: [{ kind: "format", path: target.path }] } : undefined;
  };

  if (!answer.ok) return withoutModel() ?? { kind: "failure", failure: answer.failure };

  const modelEdits: Suggestion[] = [];

  for (const text of answer.texts) {
    const reply = readZeta(text, target, config.cursorMarker);

    if (reply.kind === "none") continue;

    for (const edit of reply.edits) modelEdits.push({ kind: "edit", path: target.path, ...edit });
  }

  if (modelEdits.length === 0) {
    const fallback = withoutModel();

    if (fallback !== undefined) return fallback;
  }

  const suggestions = modelFirst(modelEdits, derived.edits, target, input.diagnostics);

  writeCache(dependencies.cache, assembled.prompt, suggestions);

  return suggestions.length === 0
    ? { kind: "none", reason: `the model returned ${target.path} unchanged` }
    : { kind: "suggestions", suggestions };
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
