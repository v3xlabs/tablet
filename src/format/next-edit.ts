import type { RecentEdit } from "../context/recent-edits";
import type { Chunk } from "../context/ring-buffer";
import { type AssembledPrompt, renderChunks } from "./fim";
import { render } from "./template";
import { reduceToEdit, type WindowEdit } from "./window-diff";

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
];

export const NEXT_EDIT_DEFAULTS = {
  template: [
    "<|file_sep|>{{path}}",
    "{{file}}",
    "{{context}}{{changes}}<|file_sep|>original/{{path}}:{{start}}:{{end}}",
    "{{original}}",
    "<|file_sep|>current/{{path}}:{{start}}:{{end}}",
    "{{current}}",
    "<|file_sep|>updated/{{path}}:{{start}}:{{end}}",
    "",
  ].join("\n"),
  chunkTemplate: "<|file_sep|>{{path}}\n{{text}}\n",
  changeTemplate: "<|file_sep|>original/{{path}}\n{{before}}\n<|file_sep|>updated/{{path}}\n{{after}}\n",
  cursorMarker: "<|cursor|>",
  stop: ["<|endoftext|>", "<|file_sep|>"],
  maxTokens: 1024,
  temperature: 0,
  windowLines: 40,
  contextLines: 300,
  crossFileCandidates: 2,
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
  cursorMarker: string;
  contextLines: number;
  target: EditTarget;
  chunks: Chunk[];
  changes: RecentEdit[];
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

const renderChanges = (changeTemplate: string, changes: RecentEdit[]): AssembledPrompt => {
  const unknown = new Set<string>();
  const parts: string[] = [];

  for (const change of changes) {
    const result = render(changeTemplate, { path: change.path, before: change.before, after: change.after });

    if (result.ok) parts.push(result.text);
    else for (const name of result.unknown) unknown.add(name);
  }

  return unknown.size > 0 ? { ok: false, unknown: [...unknown] } : { ok: true, prompt: parts.join("") };
};

export const assembleNextEdit = (input: NextEditInput): AssembledPrompt => {
  const { target } = input;
  const fileStart = Math.max(0, target.windowStart - Math.floor(input.contextLines / 2));
  const fileEnd = Math.min(target.lines.length, fileStart + input.contextLines);

  const context = renderChunks(input.chunkTemplate, input.chunks);

  if (!context.ok) return context;

  const changes = renderChanges(input.changeTemplate, input.changes);

  if (!changes.ok) return changes;

  const current = withCursor(target, input.cursorMarker);
  const prefillEnd = target.cursor === undefined ? 0 : target.cursor.line - target.windowStart + 1;

  const result = render(input.template, {
    path: target.path,
    file: target.lines.slice(fileStart, fileEnd).join("\n"),
    context: context.prompt,
    changes: changes.prompt,
    original: (target.previousWindow ?? windowOf(target)).join("\n"),
    current: current.join("\n"),
    prefill: windowOf(target).slice(0, prefillEnd)
      .join("\n"),
    start: String(target.windowStart + 1),
    end: String(target.windowEnd),
  });

  return result.ok ? { ok: true, prompt: result.text } : { ok: false, unknown: result.unknown };
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

export const readNextEdit = (reply: string, target: EditTarget): WindowEdit | undefined => {
  const lines = withoutHeader(reply.split("\n"));

  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();

  if (lines.length === 0) return undefined;

  return reduceToEdit(windowOf(target), lines, target.windowStart);
};
