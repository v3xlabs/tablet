import { readCache, writeCache } from "./cache";
import { recentFileChunks } from "./context/recent-files";
import type { EditTarget } from "./format/next-edit";
import { assembleZeta, readZeta } from "./format/zeta";
import { derivedRepairs, modelFirst } from "./rank";
import { windowAround } from "./snapshot";
import type { SuggestDependencies, SuggestInput, Suggestion, SuggestResult } from "./suggest";

/**
 * Zeta rewrites the blocks around the cursor and nothing else, so there is one target
 * and one ask. The repairs the extension derives for itself still come first, and still
 * skip the request when they land on the cursor line.
 */
export const askZeta = async (input: SuggestInput, dependencies: SuggestDependencies): Promise<SuggestResult> => {
  const { configuration: config, snapshot } = input;

  if (config.format !== "zeta") return { kind: "none", reason: "the active configuration is for the other format" };

  const span = windowAround(snapshot.lines.length, snapshot.cursorLine, config.windowLines);
  const target: EditTarget = {
    path: snapshot.path,
    lines: snapshot.lines,
    windowStart: span.start,
    windowEnd: span.end,
    cursor: { line: snapshot.cursorLine, character: snapshot.cursorCharacter },
    previousWindow: undefined,
  };

  const derived = derivedRepairs(target, input.changes, input.diagnostics);

  const nearby = await recentFileChunks(input, dependencies, config.contextFiles, config.windowLines);

  const assembled = assembleZeta({
    template: config.template,
    chunkTemplate: config.chunkTemplate,
    changeTemplate: config.changeTemplate,
    diagnosticTemplate: config.diagnosticTemplate,
    cursorMarker: config.cursorMarker,
    contextLines: config.contextLines,
    budget: input.budget,
    target,
    chunks: [...input.chunks, ...nearby].filter(chunk => chunk.path !== target.path),
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
