import { blocksFromChange, recordEdit } from "./context/recent-edits";
import { applyEdits } from "./format/apply-edits";
import type { SuggestInput, Suggestion } from "./suggest";

const CHANGE_PADDING = 2;

const endOfInsertion = (edit: Suggestion & { kind: "edit"; }): { line: number; character: number; } => {
  const inserted = edit.text.split("\n");
  const lastLine = inserted[inserted.length - 1] ?? "";

  return inserted.length === 1
    ? { line: edit.startLine, character: edit.startCharacter + lastLine.length }
    : { line: edit.startLine + inserted.length - 1, character: lastLine.length };
};

/**
 * The document as it will be once the reader accepts the suggestion on screen, with the
 * cursor where the accept leaves it and the change log carrying the accepted edit, which
 * is what the live tracker would have recorded. Asking on this while the suggestion is
 * still showing puts the next answer in the cache before the tab is pressed.
 */
export const speculativeInput = (input: SuggestInput, suggestion: Suggestion): SuggestInput | undefined => {
  if (suggestion.kind !== "edit" || suggestion.path !== input.snapshot.path) return undefined;

  const before = input.snapshot.lines;
  const after = applyEdits(before.join("\n"), [suggestion]).split("\n");
  const blocks = blocksFromChange(before, after, CHANGE_PADDING);

  if (blocks === undefined) return undefined;

  const cursor = endOfInsertion(suggestion);
  const log = recordEdit({ edits: input.changes, limit: Math.max(input.changes.length, 8) }, { path: suggestion.path, isPredicted: true, ...blocks });
  const previousByPath = new Map(input.previousByPath);

  previousByPath.set(suggestion.path, before);

  return {
    ...input,
    snapshot: { ...input.snapshot, lines: after, cursorLine: cursor.line, cursorCharacter: cursor.character },
    changes: log.edits,
    previousByPath,
  };
};
