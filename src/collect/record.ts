import type { Format } from "../config";
import type { Diagnostic } from "../context/diagnostics";
import type { RecentEdit } from "../context/recent-edits";
import type { Chunk } from "../context/ring-buffer";
import { redactSecrets } from "../context/sanitize";
import type { Suggestion } from "../suggest";

export type Exchange = {
  prompt: string;
  reply: { ok: true; texts: string[]; } | { ok: false; failure: string; };
  ms: number;
};

export type Outcome
  = | { kind: "accepted"; }
    | { kind: "rejected"; }
    | { kind: "ignored"; userTypingDisagreed: boolean; }
    | { kind: "unresolved"; };

/**
 * What the reader did with the window after the suggestion ended. `after` is the window
 * text once they moved on, so a rejection followed by their own edit is a preference
 * pair: the model's text against theirs.
 */
export type Resolution
  = | { kind: "unchanged"; }
    | { kind: "edited"; after: string; };

export type CollectedRecord = {
  recordId: string;
  timestamp: string;
  workspace: string;
  path: string;
  languageId: string;
  config: string;
  format: Format;
  cursor: { line: number; character: number; };
  window: { startLine: number; endLine: number; text: string; };
  events: RecentEdit[];
  diagnostics: Diagnostic[];
  chunks: Chunk[];
  exchanges: Exchange[];
  suggestions: Suggestion[];
  outcome: Outcome;
  resolution: Resolution;
};

const redactSuggestion = (suggestion: Suggestion): Suggestion =>
  (suggestion.kind === "format" ? suggestion : { ...suggestion, text: redactSecrets(suggestion.text) });

/** Every string that came from a file goes through the same redaction the prompt gets. */
export const redactRecord = (record: CollectedRecord): CollectedRecord => ({
  ...record,
  window: { ...record.window, text: redactSecrets(record.window.text) },
  events: record.events.map(event => ({ ...event, before: redactSecrets(event.before), after: redactSecrets(event.after) })),
  chunks: record.chunks.map(chunk => ({ ...chunk, lines: chunk.lines.map(line => redactSecrets(line)) })),
  exchanges: record.exchanges.map(exchange => ({
    ...exchange,
    prompt: redactSecrets(exchange.prompt),
    reply: exchange.reply.ok ? { ok: true, texts: exchange.reply.texts.map(text => redactSecrets(text)) } : exchange.reply,
  })),
  suggestions: record.suggestions.map(redactSuggestion),
  resolution: record.resolution.kind === "edited" ? { kind: "edited", after: redactSecrets(record.resolution.after) } : record.resolution,
});
