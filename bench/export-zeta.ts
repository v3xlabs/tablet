import { readFileSync, writeFileSync } from "node:fs";

import type { CollectedRecord } from "../src/collect/record";
import { applyEdits } from "../src/format/apply-edits";
import { unifiedHunk } from "../src/format/udiff";

/**
 * Maps collected records onto the five columns of the zed-industries/zeta dataset, so a
 * local set can sit beside the public one. What zeta has no column for rides along
 * under a tablet_ prefix. Usage: jiti bench/export-zeta.ts <records.jsonl> <out.jsonl>
 */

const [input, output] = process.argv.slice(2);

if (input === undefined || output === undefined) throw new Error("usage: export-zeta.ts <records.jsonl> <out.jsonl>");

const EDITABLE_START = "<|editable_region_start|>";
const EDITABLE_END = "<|editable_region_end|>";
const CURSOR = "<|user_cursor_is_here|>";

const excerpt = (record: CollectedRecord, body: string): string => `\`\`\`${record.path}\n${EDITABLE_START}\n${body}\n${EDITABLE_END}\n\`\`\``;

const withCursor = (record: CollectedRecord): string => {
  const lines = record.window.text.split("\n");
  const offset = record.cursor.line - record.window.startLine;
  const line = lines[offset];

  if (line === undefined) return record.window.text;

  return [...lines.slice(0, offset), `${line.slice(0, record.cursor.character)}${CURSOR}${line.slice(record.cursor.character)}`, ...lines.slice(offset + 1)].join("\n");
};

const modelText = (record: CollectedRecord): string | undefined => {
  const edits = record.suggestions.flatMap(suggestion => (suggestion.kind === "edit" && suggestion.path === record.path ? [suggestion] : []));

  if (edits.length === 0) return undefined;

  const local = edits
    .filter(edit => edit.startLine >= record.window.startLine && edit.endLine <= record.window.endLine)
    .map(edit => ({
      ...edit,
      startLine: edit.startLine - record.window.startLine,
      endLine: edit.endLine - record.window.startLine,
    }));

  return local.length === 0 ? undefined : applyEdits(record.window.text, local);
};

const events = (record: CollectedRecord): string =>
  record.events.map(event => `User edited "${event.path}":\n\n\`\`\`diff\n${unifiedHunk(event)}\n\`\`\``).join("\n\n");

type ZetaRow = {
  events: string;
  input: string;
  output: string;
  rejected: string;
  assertions: string;
  tablet_outcome: string;
  tablet_format: string;
  tablet_language: string;
  tablet_diagnostics: string;
  tablet_latency_ms: number;
};

const toRow = (record: CollectedRecord): ZetaRow | undefined => {
  const proposed = modelText(record);

  if (proposed === undefined) return undefined;

  const chosen = record.outcome.kind === "accepted"
    ? proposed
    : (record.resolution.kind === "edited" ? record.resolution.after : record.window.text);

  return {
    events: events(record),
    input: excerpt(record, withCursor(record)),
    output: excerpt(record, chosen),
    rejected: record.outcome.kind === "accepted" ? "" : excerpt(record, proposed),
    assertions: "",
    tablet_outcome: record.outcome.kind,
    tablet_format: record.format,
    tablet_language: record.languageId,
    tablet_diagnostics: record.diagnostics.map(entry => `${entry.line + 1}:${entry.character + 1} ${entry.severity}: ${entry.message}`).join("\n"),
    tablet_latency_ms: record.exchanges.reduce((sum, exchange) => sum + exchange.ms, 0),
  };
};

const rows = readFileSync(input, "utf8")
  .split("\n")
  .filter(line => line !== "")
  .map(line => JSON.parse(line) as CollectedRecord)
  .flatMap(record => (record.outcome.kind === "unresolved" ? [] : [toRow(record)]))
  .filter((row): row is ZetaRow => row !== undefined);

writeFileSync(output, rows.map(row => JSON.stringify(row)).join("\n") + (rows.length === 0 ? "" : "\n"), "utf8");

console.log(`${rows.length} row(s) written to ${output}`);
