import type { Chunk } from "../context/ring-buffer";
import { linePrefixOf, lineSuffixOf, type Snapshot } from "../snapshot";
import { clipLine, fitToBudget } from "./budget";
import { render } from "./template";

export const FIM_PLACEHOLDERS = ["prefix", "suffix", "path", "repo", "context"];

export const FIM_DEFAULTS = {
  template: "{{context}}<|fim_prefix|>{{prefix}}<|fim_suffix|>{{suffix}}<|fim_middle|>",
  chunkTemplate: "<|file_sep|>{{path}}\n{{text}}\n",
  stop: [
    "<|endoftext|>",
    "<|fim_prefix|>",
    "<|fim_suffix|>",
    "<|fim_middle|>",
    "<|fim_pad|>",
    "<|repo_name|>",
    "<|file_sep|>",
  ],
  maxTokens: 128,
  temperature: 0.1,
  prefixLines: 128,
  suffixLines: 64,
  contextBudget: 7000,
};

export type FimInput = {
  template: string;
  chunkTemplate: string;
  prefixLines: number;
  suffixLines: number;
  budget: number;
  snapshot: Snapshot;
  chunks: Chunk[];
  repo: string;
};

export type AssembledPrompt
  = | { ok: true; prompt: string; }
    | { ok: false; unknown: string[]; };

export const renderChunks = (chunkTemplate: string, chunks: Chunk[]): AssembledPrompt => {
  const unknown = new Set<string>();
  const parts: string[] = [];

  for (const chunk of chunks) {
    const result = render(chunkTemplate, { path: chunk.path, text: chunk.lines.join("\n") });

    if (result.ok) parts.push(result.text);
    else for (const name of result.unknown) unknown.add(name);
  }

  return unknown.size > 0 ? { ok: false, unknown: [...unknown] } : { ok: true, prompt: parts.join("") };
};

type FimSections = { chunks: Chunk[]; prefixLines: number; suffixLines: number; };

const SPAN_SHRINK = 0.5;

/** Chunks go first, then the suffix halves, then the prefix, which is what the cursor line needs most. */
const fimSteps: Array<(held: FimSections) => FimSections | undefined> = [
  held => (held.chunks.length > 0 ? { ...held, chunks: held.chunks.slice(1) } : undefined),
  held => (held.suffixLines > 0 ? { ...held, suffixLines: Math.floor(held.suffixLines * SPAN_SHRINK) } : undefined),
  held => (held.prefixLines > 1 ? { ...held, prefixLines: Math.max(1, Math.floor(held.prefixLines * SPAN_SHRINK)) } : undefined),
];

export const assembleFim = (input: FimInput): AssembledPrompt => {
  const { snapshot } = input;
  const unknown = new Set<string>();

  const renderSections = (sections: FimSections): string => {
    const prefixStart = Math.max(0, snapshot.cursorLine - sections.prefixLines);
    const suffixEnd = Math.min(snapshot.lines.length, snapshot.cursorLine + 1 + sections.suffixLines);

    const prefix = [
      ...snapshot.lines.slice(prefixStart, snapshot.cursorLine).map(line => `${line}\n`),
      linePrefixOf(snapshot),
    ].join("");

    const suffix = [
      lineSuffixOf(snapshot),
      ...snapshot.lines.slice(snapshot.cursorLine + 1, suffixEnd).map(line => `\n${line}`),
    ].join("");

    const context = renderChunks(input.chunkTemplate, sections.chunks.map(chunk => ({ ...chunk, lines: chunk.lines.map(clipLine) })));

    if (!context.ok) for (const name of context.unknown) unknown.add(name);

    const result = render(input.template, {
      prefix,
      suffix,
      path: snapshot.path,
      repo: input.repo,
      context: context.ok ? context.prompt : "",
    });

    if (!result.ok) for (const name of result.unknown) unknown.add(name);

    return result.ok ? result.text : "";
  };

  const fitted = fitToBudget(
    { chunks: input.chunks, prefixLines: input.prefixLines, suffixLines: input.suffixLines },
    input.budget,
    { render: renderSections, steps: fimSteps },
  );

  return unknown.size > 0 ? { ok: false, unknown: [...unknown] } : { ok: true, prompt: fitted.prompt };
};

