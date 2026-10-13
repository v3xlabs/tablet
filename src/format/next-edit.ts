import { type Diagnostic, renderDiagnostics } from "../context/diagnostics";
import type { RecentEdit } from "../context/recent-edits";
import type { Chunk } from "../context/ring-buffer";
import { clipHunk, clipLine, fitToBudget } from "./budget";
import { type AssembledPrompt, renderChunks } from "./fim";
import { render } from "./template";
import { splitIntoEdits, type WindowEdit } from "./window-diff";

export const NEXT_EDIT_PLACEHOLDERS = [
  "path",
  "file",
  "context",
  "changes",
  "original",
  "current",
  "prefill",
  "start",
  "end",
  "diagnostics",
  "format",
];

export const NEXT_EDIT_DEFAULTS = {
  template: [
    "<|file_sep|>{{path}}",
    "{{file}}",
    "{{diagnostics}}{{context}}{{changes}}{{format}}<|file_sep|>original/{{path}}:{{start}}:{{end}}",
    "{{original}}",
    "<|file_sep|>current/{{path}}:{{start}}:{{end}}",
    "{{current}}",
    "<|file_sep|>updated/{{path}}:{{start}}:{{end}}",
    "",
  ].join("\n"),
  chunkTemplate: "<|file_sep|>{{path}}\n{{text}}\n",
  // one block per changed file, named with a .diff suffix, holding literal original: and
  // updated: sections. This is the shape the sweep write up describes, and the model reacts
  // to it where it ignored the shape the model card implied.
  changeTemplate: "<|file_sep|>{{path}}.diff\noriginal:\n{{before}}\nupdated:\n{{after}}\n",
  diagnosticTemplate: "<|file_sep|>diagnostics/{{path}}\n{{text}}\n",
  formatTemplate: "<|file_sep|>instructions\nReply with {{marker}} alone to run the formatter on this file instead of proposing an edit.\n",
  cursorMarker: "<|cursor|>",
  formatMarker: "<|format|>",
  stop: ["<|endoftext|>", "<|file_sep|>"],
  maxTokens: 1024,
  temperature: 0,
  // ten lines above and below the cursor, which the sweep write up reports as its optimum
  windowLines: 21,
  contextLines: 300,
  crossFileCandidates: 2,
  contextFiles: 2,
  // the shared llama.cpp slot is 8192, and this leaves room for maxTokens plus the
  // estimate's own error
  contextBudget: 7000,
};

export type EditTarget = {
  path: string;
  lines: string[];
  windowStart: number;
  windowEnd: number;
  cursor: { line: number; character: number; } | undefined;
  previousWindow: string[] | undefined;
};

export type NextEditInput = {
  template: string;
  chunkTemplate: string;
  changeTemplate: string;
  diagnosticTemplate: string;
  formatTemplate: string;
  cursorMarker: string;
  formatMarker: string;
  contextLines: number;
  budget: number;
  target: EditTarget;
  chunks: Chunk[];
  changes: RecentEdit[];
  diagnostics: Diagnostic[];
};

export const windowOf = (target: EditTarget): string[] => target.lines.slice(target.windowStart, target.windowEnd);

const withCursor = (target: EditTarget, marker: string): string[] => {
  const window = windowOf(target);

  if (target.cursor === undefined) return window;

  const offset = target.cursor.line - target.windowStart;
  const line = window[offset];

  if (line === undefined) return window;

  const marked = `${line.slice(0, target.cursor.character)}${marker}${line.slice(target.cursor.character)}`;

  return [...window.slice(0, offset), marked, ...window.slice(offset + 1)];
};

const WORDS_RE = /[A-Za-z_$][\w$]*/g;

const wordsIn = (text: string): Set<string> => new Set(Array.from(text.matchAll(WORDS_RE), m => m[0]));

const changeAnalysis = (changes: RecentEdit[]): string => {
  const renames = new Map<string, string>();
  const transformations: Array<[string[], string[]]> = [];

  for (const change of changes) {
    const beforeWords = wordsIn(change.before);
    const afterWords = wordsIn(change.after);

    const removed = [...beforeWords].filter(w => !afterWords.has(w));
    const added = [...afterWords].filter(w => !beforeWords.has(w));

    if (removed.length > 0 || added.length > 0) transformations.push([removed, added]);

    if (removed.length === 1 && added.length === 1) renames.set(removed[0]!, added[0]!);
  }

  const lines: string[] = [];

  if (renames.size > 0) {
    lines.push(`renamed: ${[...renames].map(([from, to]) => `${from} -> ${to}`).join(", ")}`);
  }

  const patterns = new Map<string, number>();

  for (const [removed, added] of transformations) {
    const key = `${removed.join(",")} -> ${added.join(",")}`;

    patterns.set(key, (patterns.get(key) ?? 0) + 1);
  }

  for (const [key, count] of patterns) {
    if (count > 1) lines.push(`pattern: ${key} (applied ${count} time(s))`);
  }

  return lines.length === 0 ? "" : `<|file_sep|>analysis\n${lines.join("\n")}\n`;
};

const HUNK_LINE_LIMIT = 12;

const renderChanges = (changeTemplate: string, changes: RecentEdit[]): AssembledPrompt => {
  const unknown = new Set<string>();
  const parts: string[] = [];

  for (const change of changes) {
    const result = render(changeTemplate, {
      path: change.path,
      before: clipHunk(change.before, HUNK_LINE_LIMIT),
      after: clipHunk(change.after, HUNK_LINE_LIMIT),
    });

    if (result.ok) parts.push(result.text);
    else for (const name of result.unknown) unknown.add(name);
  }

  if (unknown.size > 0) return { ok: false, unknown: [...unknown] };

  const analysis = changeAnalysis(changes);

  if (analysis !== "") parts.push(analysis);

  return { ok: true, prompt: parts.join("") };
};

/**
 * An empty marker means the reader wants nothing to do with the formatter, so the whole
 * instruction leaves the prompt rather than staying behind naming an empty token.
 */
const renderFormatInstruction = (template: string, marker: string): AssembledPrompt => {
  if (marker === "") return { ok: true, prompt: "" };

  const result = render(template, { marker });

  return result.ok ? { ok: true, prompt: result.text } : { ok: false, unknown: result.unknown };
};

type Sections = {
  contextLines: number;
  chunks: Chunk[];
  changes: RecentEdit[];
  near: Diagnostic[];
  far: Diagnostic[];
};

const CONTEXT_SHRINK = 0.75;

const withoutFarthest = (diagnostics: Diagnostic[], anchor: number): Diagnostic[] | undefined => {
  if (diagnostics.length === 0) return undefined;

  const farthest = diagnostics.reduce((held, entry) =>
    (Math.abs(entry.line - anchor) > Math.abs(held.line - anchor) ? entry : held));

  return diagnostics.filter(entry => entry !== farthest);
};

/**
 * What leaves first is what the model needs least: a cross file chunk, then a diagnostic
 * away from the window, then the file excerpt shrinking toward the window, then the
 * oldest change, and last a diagnostic on the window itself. The windows never shrink,
 * because the edit has to land in text the model saw whole.
 */
const trimSteps = (windowLines: number, anchor: number): Array<(held: Sections) => Sections | undefined> => [
  held => (held.chunks.length > 0 ? { ...held, chunks: held.chunks.slice(1) } : undefined),
  (held) => {
    const far = withoutFarthest(held.far, anchor);

    return far === undefined ? undefined : { ...held, far };
  },
  (held) => {
    if (held.contextLines <= windowLines) return;

    return { ...held, contextLines: Math.max(windowLines, Math.floor(held.contextLines * CONTEXT_SHRINK)) };
  },
  held => (held.changes.length > 0 ? { ...held, changes: held.changes.slice(1) } : undefined),
  (held) => {
    const near = withoutFarthest(held.near, anchor);

    return near === undefined ? undefined : { ...held, near };
  },
];

export type AssembledNextEdit
  = | { ok: true; prompt: string; tokens: number; }
    | { ok: false; unknown: string[]; };

export const assembleNextEdit = (input: NextEditInput): AssembledNextEdit => {
  const { target } = input;
  const windowLines = target.windowEnd - target.windowStart;
  const anchor = target.cursor?.line ?? Math.floor((target.windowStart + target.windowEnd) / 2);

  const instruction = renderFormatInstruction(input.formatTemplate, input.formatMarker);

  if (!instruction.ok) return instruction;

  const current = withCursor(target, input.cursorMarker);
  const prefillEnd = target.cursor === undefined ? 0 : target.cursor.line - target.windowStart + 1;
  const fixed = {
    path: target.path,
    original: (target.previousWindow ?? windowOf(target)).join("\n"),
    current: current.join("\n"),
    prefill: windowOf(target).slice(0, prefillEnd)
      .join("\n"),
    format: instruction.prompt,
    start: String(target.windowStart + 1),
    end: String(target.windowEnd),
  };

  const unknown = new Set<string>();

  const renderSections = (sections: Sections): string => {
    const fileStart = Math.max(0, target.windowStart - Math.floor((sections.contextLines - windowLines) / 2));
    const fileEnd = Math.min(target.lines.length, fileStart + sections.contextLines);

    const context = renderChunks(input.chunkTemplate, sections.chunks.map(chunk => ({ ...chunk, lines: chunk.lines.map(clipLine) })));
    const changes = renderChanges(input.changeTemplate, sections.changes);
    const diagnostics = renderDiagnostics(input.diagnosticTemplate, target.path, [...sections.near, ...sections.far].toSorted((left, right) => left.line - right.line));

    for (const part of [context, changes, diagnostics]) {
      if (!part.ok) for (const name of part.unknown) unknown.add(name);
    }

    const result = render(input.template, {
      ...fixed,
      file: target.lines.slice(fileStart, fileEnd).map(clipLine)
        .join("\n"),
      context: context.ok ? context.prompt : "",
      changes: changes.ok ? changes.prompt : "",
      diagnostics: diagnostics.ok ? diagnostics.prompt : "",
    });

    if (!result.ok) for (const name of result.unknown) unknown.add(name);

    return result.ok ? result.text : "";
  };

  const isNear = (entry: Diagnostic): boolean => entry.line >= target.windowStart && entry.line < target.windowEnd;

  const fitted = fitToBudget(
    {
      contextLines: Math.max(windowLines, input.contextLines),
      chunks: input.chunks,
      changes: input.changes,
      near: input.diagnostics.filter(isNear),
      far: input.diagnostics.filter(entry => !isNear(entry)),
    },
    input.budget,
    { render: renderSections, steps: trimSteps(windowLines, anchor) },
  );

  return unknown.size > 0 ? { ok: false, unknown: [...unknown] } : { ok: true, prompt: fitted.prompt, tokens: fitted.tokens };
};

const HEADER = /^\S+:\d+:\d+$/;

/**
 * A template that stops before the path lets the model write the header itself, so the
 * first line of the reply is not always code.
 */
const withoutHeader = (lines: string[]): string[] => {
  const first = lines[0];

  return first !== undefined && HEADER.test(first.trim()) ? lines.slice(1) : lines;
};

/**
 * Only the final newline is dropped, never a run of blank lines. Trimming them all would
 * turn a window that legitimately ends in blank lines into a deletion the model never
 * proposed, and deleting stray whitespace is one of the things the model is for.
 */
const withoutFinalNewline = (lines: string[]): string[] =>
  (lines.length > 1 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines);

const withoutTrailingBlanks = (lines: string[]): string[] => {
  let end = lines.length;

  while (end > 0 && lines[end - 1] === "") end--;

  return lines.slice(0, end);
};

// window lines a streamed rewrite must repeat before the hunk above is final; fewer
// let a repeated closing brace finish it early
const RESYNC_LINES = 3;

/**
 * Finished once the rewrite has changed a window line and then copied the window's own
 * lines again: the hunk above is final from there. Only whole lines are read, so a
 * half-written line never reaches the reader.
 */
export const finishedNextEdit = (partial: string, target: EditTarget, cursorMarker = ""): string | undefined => {
  const cleaned = cursorMarker === "" ? partial : partial.replaceAll(cursorMarker, "");
  const complete = cleaned.slice(0, Math.max(0, cleaned.lastIndexOf("\n")));
  const lines = withoutHeader(complete.split("\n"));
  const window = windowOf(target);
  let same = 0;

  while (same < lines.length && same < window.length && lines[same] === window[same]) same++;

  const tailStart = lines.length - RESYNC_LINES;
  const tail = lines.slice(tailStart);

  if (tailStart < same || same === lines.length || tail.every(line => line.trim() === "")) return undefined;

  for (let at = same; at + RESYNC_LINES <= window.length; at++) {
    if (tail.every((line, index) => window[at + index] === line)) return `${[...lines.slice(0, tailStart), ...window.slice(at)].join("\n")}\n`;
  }

  return undefined;
};

export type NextEditReply
  = | { kind: "edits"; edits: WindowEdit[]; }
    | { kind: "format"; }
    | { kind: "none"; };

export const readNextEdit = (reply: string, target: EditTarget, formatMarker: string, cursorMarker = ""): NextEditReply => {
  // a model that echoes the cursor marker back must not end up inserting it as text
  const cleaned = cursorMarker === "" ? reply : reply.replaceAll(cursorMarker, "");
  const lines = withoutFinalNewline(withoutHeader(cleaned.split("\n")));

  if (lines.length === 0) return { kind: "none" };

  const first = lines.find(line => line.trim() !== "");

  if (formatMarker !== "" && first?.trim() === formatMarker) return { kind: "format" };

  // a reply that is entirely blank blanks the window, which no model means on purpose
  if (first === undefined) return { kind: "none" };

  // how the file's tail is newline-terminated is harness policy, never something to
  // infer from how many newlines the model happened to emit before the stop token
  const isAtFileEnd = target.windowEnd === target.lines.length;
  const window = isAtFileEnd ? withoutTrailingBlanks(windowOf(target)) : windowOf(target);

  if (window.length === 0) return { kind: "none" };

  const edits = splitIntoEdits(window, isAtFileEnd ? withoutTrailingBlanks(lines) : lines, target.windowStart);

  return edits.length === 0 ? { kind: "none" } : { kind: "edits", edits };
};
