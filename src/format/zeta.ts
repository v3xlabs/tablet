import { type Diagnostic, renderDiagnostics } from "../context/diagnostics";
import type { RecentEdit } from "../context/recent-edits";
import type { Chunk } from "../context/ring-buffer";
import { clipLine, fitToBudget } from "./budget";
import { type AssembledPrompt, renderChunks } from "./fim";
import type { EditTarget } from "./next-edit";
import { windowOf } from "./next-edit";
import { render } from "./template";
import { unifiedHunk } from "./udiff";
import { splitIntoEdits, type WindowEdit } from "./window-diff";

export const ZETA_PLACEHOLDERS = ["path", "prefix", "suffix", "editable", "history", "context", "diagnostics"];

/**
 * The zeta 2.1 layout: suffix, then prefix holding related files and the file up to the
 * editable region, then the middle tag. The editable region is cut into numbered blocks
 * and the model answers with the blocks it rewrote, from the first tag it names to the
 * last. Zed's order puts the edit history ahead of the file; here it sits after the file
 * text and the file is named again before the editable region, since the history changes
 * on every keystroke and the server can then reuse its cache for everything before it.
 * The bench scores both orders the same.
 */
export const ZETA_DEFAULTS = {
  template: "<[fim-suffix]>{{suffix}}\n<[fim-prefix]>{{context}}{{diagnostics}}<filename>{{path}}\n{{prefix}}{{history}}<filename>{{path}}\n{{editable}}<[fim-middle]>",
  chunkTemplate: "<filename>{{path}}\n{{text}}\n\n",
  changeTemplate: "--- a/{{path}}\n+++ b/{{path}}\n{{diff}}\n",
  // zed's V0420 format carries a diagnostics section ahead of the related files; zeta 2.1
  // was trained without one, and the bench decides whether it stays
  diagnosticTemplate: "<filename>diagnostics\n{{text}}\n\n",
  cursorMarker: "<|user_cursor|>",
  stop: ["<[end▁of▁sentence]>"],
  maxTokens: 512,
  temperature: 0,
  // about the 350 editable tokens zed budgets for this format
  windowLines: 32,
  contextLines: 200,
  contextFiles: 2,
  contextBudget: 4096,
};

const MARKER = /<\|marker_(\d+)\|>/g;

/** What zed writes above a history entry that came from an accepted prediction. */
export const PREDICTED_MARK = "// User accepted prediction:\n";

export const markerTag = (index: number): string => `<|marker_${index}|>`;

const MIN_BLOCK_LINES = 6;
const MAX_BLOCK_LINES = 16;
const MAX_NUDGE_LINES = 5;

const STRUCTURAL_KEYWORDS: Record<string, true> = { break: true, continue: true, return: true, throw: true, end: true };

const isStructuralTail = (trimmed: string): boolean =>
  /^[)\]}]/.test(trimmed) || STRUCTURAL_KEYWORDS[trimmed.replace(/;+$/, "")] === true;

const isBlank = (line: string): boolean => line.trim() === "";

const isGoodStart = (line: string): boolean => !isBlank(line) && !isStructuralTail(line.trim());

/**
 * Block starts, as line offsets into the editable region, cut the way zed's
 * `compute_marker_offsets_v0318` cuts them, since zeta 2.1 was trained on exactly those
 * boundaries: after a blank line once six lines are in, and forced at sixteen, each
 * nudged up to five lines forward past a line that only closes something.
 */
export const blockStarts = (lines: string[]): number[] => {
  const starts = [0];
  const goodStartFrom = (from: number): number | undefined => {
    for (let index = from; index < Math.min(lines.length, from + MAX_NUDGE_LINES); index++) {
      if (isGoodStart(lines[index] ?? "")) return index;
    }

    return undefined;
  };

  let index = 0;

  while (index < lines.length) {
    const lastStart = starts[starts.length - 1] ?? 0;
    const gap = index - lastStart;
    const line = lines[index] ?? "";
    const isAfterBlank = index > 0 && isBlank(lines[index - 1] ?? "");

    if (isAfterBlank && gap >= MIN_BLOCK_LINES && !isBlank(line)) {
      const target = isGoodStart(line) ? index : goodStartFrom(index) ?? index;

      if (target > lastStart && lines.length - target >= MIN_BLOCK_LINES) {
        starts.push(target);
        index = target + 1;

        continue;
      }
    }

    if (gap >= MAX_BLOCK_LINES) {
      const target = goodStartFrom(index) ?? index;

      if (target > lastStart) {
        starts.push(target);
        index = target + 1;

        continue;
      }
    }

    index++;
  }

  return starts;
};

/**
 * The region with its tags in place. A tag sits at the start of the line that opens its
 * block, with no newline after it, which is how the model card's sample is laid out. The
 * closing tag stands on its own line after the last block.
 */
export const markedEditable = (target: EditTarget, cursorMarker: string): string => {
  const lines = windowOf(target);
  const starts = new Set(blockStarts(lines));
  let tag = 1;

  const marked = lines.map((line, offset) => {
    const isCursorLine = target.cursor !== undefined && target.cursor.line - target.windowStart === offset;
    const text = isCursorLine && target.cursor !== undefined
      ? `${line.slice(0, target.cursor.character)}${cursorMarker}${line.slice(target.cursor.character)}`
      : line;

    if (!starts.has(offset)) return text;

    const withTag = `${markerTag(tag)}${text}`;

    tag++;

    return withTag;
  });

  return `${marked.join("\n")}\n${markerTag(tag)}\n`;
};

export type ZetaInput = {
  template: string;
  chunkTemplate: string;
  changeTemplate: string;
  diagnosticTemplate: string;
  cursorMarker: string;
  contextLines: number;
  budget: number;
  target: EditTarget;
  chunks: Chunk[];
  changes: RecentEdit[];
  diagnostics: Diagnostic[];
};

const renderHistory = (changeTemplate: string, changes: RecentEdit[]): AssembledPrompt => {
  if (changes.length === 0) return { ok: true, prompt: "" };

  const unknown = new Set<string>();
  const parts: string[] = [];

  for (const change of changes) {
    const result = render(changeTemplate, { path: change.path, diff: unifiedHunk(change) });

    if (result.ok) parts.push(change.isPredicted ? `${PREDICTED_MARK}${result.text}` : result.text);
    else for (const name of result.unknown) unknown.add(name);
  }

  if (unknown.size > 0) return { ok: false, unknown: [...unknown] };

  return { ok: true, prompt: `<filename>edit_history\n${parts.join("\n")}\n` };
};

type Sections = { contextLines: number; chunks: Chunk[]; changes: RecentEdit[]; };

const CONTEXT_SHRINK = 0.75;

const trimSteps: Array<(held: Sections) => Sections | undefined> = [
  held => (held.chunks.length > 0 ? { ...held, chunks: held.chunks.slice(1) } : undefined),
  held => (held.contextLines > 0 ? { ...held, contextLines: Math.floor(held.contextLines * CONTEXT_SHRINK) } : undefined),
  held => (held.changes.length > 0 ? { ...held, changes: held.changes.slice(1) } : undefined),
];

export type AssembledZeta
  = | { ok: true; prompt: string; tokens: number; }
    | { ok: false; unknown: string[]; };

export const assembleZeta = (input: ZetaInput): AssembledZeta => {
  const { target } = input;
  const unknown = new Set<string>();
  const editable = markedEditable(target, input.cursorMarker);

  const renderSections = (sections: Sections): string => {
    const half = Math.floor(sections.contextLines / 2);
    const prefixLines = target.lines.slice(Math.max(0, target.windowStart - half), target.windowStart).map(clipLine);
    const suffixLines = target.lines.slice(target.windowEnd, target.windowEnd + half).map(clipLine);

    const context = renderChunks(input.chunkTemplate, sections.chunks.map(chunk => ({ ...chunk, lines: chunk.lines.map(clipLine) })));
    const history = renderHistory(input.changeTemplate, sections.changes);
    const diagnostics = renderDiagnostics(input.diagnosticTemplate, target.path, input.diagnostics);

    for (const part of [context, history, diagnostics]) {
      if (!part.ok) for (const name of part.unknown) unknown.add(name);
    }

    const result = render(input.template, {
      path: target.path,
      prefix: prefixLines.length === 0 ? "" : `${prefixLines.join("\n")}\n`,
      suffix: suffixLines.join("\n"),
      editable,
      context: context.ok ? context.prompt : "",
      history: history.ok ? history.prompt : "",
      diagnostics: diagnostics.ok ? diagnostics.prompt : "",
    });

    if (!result.ok) for (const name of result.unknown) unknown.add(name);

    return result.ok ? result.text : "";
  };

  const fitted = fitToBudget(
    { contextLines: input.contextLines, chunks: input.chunks, changes: input.changes },
    input.budget,
    { render: renderSections, steps: trimSteps },
  );

  return unknown.size > 0 ? { ok: false, unknown: [...unknown] } : { ok: true, prompt: fitted.prompt, tokens: fitted.tokens };
};

export type ZetaReply
  = | { kind: "edits"; edits: WindowEdit[]; }
    | { kind: "none"; };

/**
 * The reply names the first and last block it touched and carries the new text between
 * them. The same tag twice means nothing changed. A reply spanning several blocks
 * repeats the tags between them, often moved to a line of their own, so the span is
 * read as the bytes between consecutive tags joined, which is how zed reads it.
 * Everything outside the named span is the region as it was, so the whole window is
 * rebuilt and diffed against itself.
 */
export const readZeta = (reply: string, target: EditTarget, cursorMarker: string): ZetaReply => {
  const tags = Array.from(reply.matchAll(MARKER));
  const first = tags[0];
  const last = tags[tags.length - 1];

  if (first === undefined || last === undefined || first.index === last.index) return { kind: "none" };

  const from = Number(first[1]);
  const upto = Number(last[1]);

  // tags that skip or go back mean the reply lost track of the region, and reading it
  // anyway would replace blocks the model never wrote out
  const isInOrder = tags.every((tag, index) => {
    const step = index === 0 ? 0 : Number(tag[1]) - Number(tags[index - 1]?.[1]);

    return step === 0 || step === 1;
  });

  if (!isInOrder || from >= upto) return { kind: "none" };

  const lines = windowOf(target);
  const starts = blockStarts(lines);
  const startLine = starts[from - 1];

  if (startLine === undefined || upto > starts.length + 1) return { kind: "none" };

  const endLine = starts[upto - 1] ?? lines.length;

  const content = reply.slice(first.index + first[0].length, last.index)
    .replaceAll(MARKER, "")
    .replaceAll(cursorMarker, "");
  const middle = content.split("\n");

  if (middle[middle.length - 1] === "") middle.pop();

  const rebuilt = [...lines.slice(0, startLine), ...middle, ...lines.slice(endLine)];
  const edits = splitIntoEdits(lines, rebuilt, target.windowStart);

  return edits.length === 0 ? { kind: "none" } : { kind: "edits", edits };
};
