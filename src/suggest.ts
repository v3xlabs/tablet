import { type Cache, readCache, writeCache } from "./cache";
import type { Config as Config } from "./config";
import type { Diagnostic } from "./context/diagnostics";
import type { RecentEdit } from "./context/recent-edits";
import type { Chunk } from "./context/ring-buffer";
import { isSecretPath, redactSecrets } from "./context/sanitize";
import type { CompletionResult, EndpointFailure } from "./endpoint";
import { assembleFim } from "./format/fim";
import { filterCompletion } from "./format/fim-filter";
import { assembleNextEdit, type EditTarget, readNextEdit } from "./format/next-edit";
import { lineSuffixOf, type Snapshot, windowAround } from "./snapshot";

export type Suggestion
  = | { kind: "completion"; text: string; }
    | { kind: "edit"; path: string; startLine: number; startCharacter: number; endLine: number; endCharacter: number; text: string; }
    | { kind: "format"; path: string; };

export type SuggestDependencies = {
  complete: (prompt: string) => Promise<CompletionResult>;
  readFile: (path: string) => Promise<string[] | undefined>;
  diagnosticsFor: (path: string) => Diagnostic[];
  cache: Cache<Suggestion[]>;
};

export type SuggestInput = {
  configuration: Config;
  snapshot: Snapshot;
  chunks: Chunk[];
  changes: RecentEdit[];
  diagnostics: Diagnostic[];
  repo: string;
  previousByPath: ReadonlyMap<string, string[]>;
  candidatePaths: string[];
};

export type SuggestResult
  = | { kind: "suggestions"; suggestions: Suggestion[]; }
    | { kind: "none"; reason: string; }
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
    previousWindow: input.previousByPath.get(snapshot.path)?.slice(span.start, span.end),
  };
};

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
 * What the linter flags is what the reader wants fixed, and after that the
 * fix nearest the cursor beats a stray change the model made further away.
 */
const orderedByRelevance = (suggestions: Suggestion[], target: EditTarget, diagnostics: Diagnostic[]): Suggestion[] => {
  const anchor = target.cursor?.line ?? Math.floor((target.windowStart + target.windowEnd) / 2);

  const rank = (suggestion: Suggestion): number => {
    if (suggestion.kind !== "edit") return 0;

    const isFlagged = diagnostics.some(held => held.line >= suggestion.startLine && held.line <= suggestion.endLine);

    return (isFlagged ? 0 : 1000) + Math.abs(suggestion.startLine - anchor);
  };

  return suggestions.toSorted((left, right) => rank(left) - rank(right));
};

const whitespaceFixesFor = (target: EditTarget, diagnostics: Diagnostic[]): Suggestion[] => {
  const fixes: Suggestion[] = [];

  for (const diagnostic of diagnostics) {
    if (diagnostic.line < target.windowStart || diagnostic.line >= target.windowEnd) continue;

    const line = target.lines[diagnostic.line] ?? "";

    if (diagnostic.message.includes("Trailing spaces not allowed")) {
      const trimmed = line.trimEnd();

      if (trimmed.length !== line.length) {
        fixes.push({
          kind: "edit",
          path: target.path,
          startLine: diagnostic.line,
          startCharacter: trimmed.length,
          endLine: diagnostic.line,
          endCharacter: line.length,
          text: "",
        });
      }
    }
    else if (diagnostic.message.includes("Expected indentation of")) {
      const match = diagnostic.message.match(/Expected indentation of (\d+) spaces but found (\d+)/);

      if (match === null || match[1] === undefined) continue;

      const wanted = Number(match[1]);

      if (!Number.isFinite(wanted)) continue;

      const actual = line.length - line.trimStart().length;

      if (actual === wanted || line.trim().length === 0) continue;

      if (actual > wanted) {
        fixes.push({
          kind: "edit",
          path: target.path,
          startLine: diagnostic.line,
          startCharacter: wanted,
          endLine: diagnostic.line,
          endCharacter: actual,
          text: "",
        });
      }
      else {
        fixes.push({
          kind: "edit",
          path: target.path,
          startLine: diagnostic.line,
          startCharacter: actual,
          endLine: diagnostic.line,
          endCharacter: actual,
          text: " ".repeat(wanted - actual),
        });
      }
    }
    else if (diagnostic.message.includes("';' expected")) {
      const trimmed = line.trimEnd();

      if (trimmed.endsWith(";") || trimmed.length === 0) continue;

      fixes.push({
        kind: "edit",
        path: target.path,
        startLine: diagnostic.line,
        startCharacter: line.length,
        endLine: diagnostic.line,
        endCharacter: line.length,
        text: ";",
      });
    }
  }

  return uniqueBy(fixes, fix => JSON.stringify(fix));
};

const askFim = async (input: SuggestInput, dependencies: SuggestDependencies): Promise<SuggestResult> => {
  const { configuration: config, snapshot } = input;

  if (config.format !== "fim") return { kind: "none", reason: "the active configuration is for the other format" };

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

  const diagnostics = target.path === input.snapshot.path ? input.diagnostics : dependencies.diagnosticsFor(target.path);
  const whitespaceFixes = whitespaceFixesFor(target, diagnostics);
  const assembled = assembleNextEdit({
    template: config.template,
    chunkTemplate: config.chunkTemplate,
    changeTemplate: config.changeTemplate,
    diagnosticTemplate: config.diagnosticTemplate,
    formatTemplate: config.formatTemplate,
    cursorMarker: config.cursorMarker,
    formatMarker: config.formatMarker,
    contextLines: config.contextLines,
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

  const answer = await dependencies.complete(assembled.prompt);

  if (!answer.ok) {
    return whitespaceFixes.length > 0
      ? { kind: "suggestions", suggestions: orderedByRelevance(whitespaceFixes, target, diagnostics) }
      : { kind: "failure", failure: answer.failure };
  }

  const modelEdits = orderedByRelevance(editsFrom(answer.texts, target, config.formatMarker, config.cursorMarker), target, diagnostics);

  if (modelEdits.length === 0 && whitespaceFixes.length > 0) {
    return { kind: "suggestions", suggestions: orderedByRelevance(whitespaceFixes, target, diagnostics) };
  }

  const combined = uniqueBy([...whitespaceFixes, ...modelEdits], item => JSON.stringify(item));
  const suggestions = orderedByRelevance(combined, target, diagnostics);

  writeCache(dependencies.cache, assembled.prompt, suggestions);

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

/**
 * The linter already knows where the file is broken, and the model proposes edits close to
 * the cursor marker far more readily than away from it. When the nearest diagnostic is not
 * where the cursor is, a second window centred on the diagnostic and free of the marker is
 * what turns "the lsp is failing on line 60" into a suggestion.
 */
const diagnosticTarget = (input: SuggestInput, windowLines: number): EditTarget | undefined => {
  const { snapshot } = input;
  const outside = input.diagnostics.filter(held => Math.abs(held.line - snapshot.cursorLine) > 2);
  const errors = outside.filter(held => held.severity === "error");

  const chosen = (errors.length > 0 ? errors : outside)
    .toSorted((left, right) => Math.abs(left.line - snapshot.cursorLine) - Math.abs(right.line - snapshot.cursorLine))[0];

  if (chosen === undefined) return undefined;

  const span = windowAround(snapshot.lines.length, chosen.line, windowLines);

  return {
    path: snapshot.path,
    lines: snapshot.lines,
    windowStart: span.start,
    windowEnd: span.end,
    cursor: undefined,
    previousWindow: input.previousByPath.get(snapshot.path)?.slice(span.start, span.end),
  };
};

/**
 * Renaming something in one file and moving to another leaves the model with a change it
 * can see and a file it cannot. A window of each recently touched file, taken around the
 * identifier the change removed, is the smallest thing that closes that gap.
 */
const recentFileChunks = async (
  input: SuggestInput,
  dependencies: SuggestDependencies,
  budget: number,
  span: number,
): Promise<Chunk[]> => {
  const paths = input.candidatePaths
    .filter(path => path !== input.snapshot.path)
    .filter(path => !isSecretPath(path))
    .slice(0, Math.max(0, budget));

  const reads = await Promise.all(paths.map(path => dependencies.readFile(path)));
  const chunks: Chunk[] = [];

  for (const [index, read] of reads.entries()) {
    if (read === undefined) continue;

    const path = paths[index] ?? "";
    const lines = read.map(line => redactSecrets(line));
    const around = windowAround(lines.length, focusLine(lines, input.changes), span);

    chunks.push({ path, startLine: around.start, lines: lines.slice(around.start, around.end) });
  }

  return chunks;
};

const askNextEdit = async (input: SuggestInput, dependencies: SuggestDependencies): Promise<SuggestResult> => {
  const { configuration: config } = input;

  if (config.format !== "next-edit") return { kind: "none", reason: "the active configuration is for the other format" };

  const nearby = await recentFileChunks(input, dependencies, config.contextFiles, config.windowLines);
  const withContext = { ...input, chunks: [...input.chunks, ...nearby] };
  const isEmpty = input.diagnostics.length === 0
    && input.changes.length === 0
    && input.candidatePaths.length === 0;
  let localReason: string | undefined;

  if (!isEmpty) {
    const local = await askNextEditFor(withContext, dependencies, localTarget(input, config.windowLines));

    if (local.kind !== "none") return local;

    localReason = local.reason;
    const atDiagnostic = diagnosticTarget(input, config.windowLines);

    if (atDiagnostic !== undefined) {
      const there = await askNextEditFor(withContext, dependencies, atDiagnostic);

      if (there.kind !== "none") return there;
    }
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
      const flagged = dependencies.diagnosticsFor(path)[0]?.line;
      const span = windowAround(lines.length, focus === 0 ? flagged ?? 0 : focus, config.windowLines);

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

  if (isEmpty) return { kind: "none", reason: "no diagnostics, changes, or candidates to act on" };

  const reason = asked === 0
    ? (localReason ?? "nothing to fix")
    : `${localReason ?? "nothing to fix locally"}, and none of the ${asked} candidate file(s) needed changes either`;

  return { kind: "none", reason };
};

export const suggest = async (input: SuggestInput, dependencies: SuggestDependencies): Promise<SuggestResult> =>
  (input.configuration.format === "fim" ? askFim(input, dependencies) : askNextEdit(input, dependencies));
