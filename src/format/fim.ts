import type { Chunk } from "../context/ring-buffer";
import { linePrefixOf, lineSuffixOf, type Snapshot } from "../snapshot";
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
};

export type FimInput = {
  template: string;
  chunkTemplate: string;
  prefixLines: number;
  suffixLines: number;
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

export const assembleFim = (input: FimInput): AssembledPrompt => {
  const { snapshot } = input;
  const prefixStart = Math.max(0, snapshot.cursorLine - input.prefixLines);
  const suffixEnd = Math.min(snapshot.lines.length, snapshot.cursorLine + 1 + input.suffixLines);

  const prefix = [
    ...snapshot.lines.slice(prefixStart, snapshot.cursorLine).map(line => `${line}\n`),
    linePrefixOf(snapshot),
  ].join("");

  const suffix = [
    lineSuffixOf(snapshot),
    ...snapshot.lines.slice(snapshot.cursorLine + 1, suffixEnd).map(line => `\n${line}`),
  ].join("");

  const context = renderChunks(input.chunkTemplate, input.chunks);

  if (!context.ok) return context;

  const result = render(input.template, {
    prefix,
    suffix,
    path: snapshot.path,
    repo: input.repo,
    context: context.prompt,
  });

  return result.ok ? { ok: true, prompt: result.text } : { ok: false, unknown: result.unknown };
};

