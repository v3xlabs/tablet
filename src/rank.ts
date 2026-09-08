import type { Diagnostic } from "./context/diagnostics";
import type { RecentEdit } from "./context/recent-edits";
import type { EditTarget } from "./format/next-edit";
import { renameSpreadFor } from "./format/rename";
import { whitespaceRepairFor } from "./format/whitespace";
import type { Suggestion } from "./suggest";

export const uniqueBy = <T>(items: T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();

  return items.filter((item) => {
    const signature = key(item);

    if (seen.has(signature)) return false;

    seen.add(signature);

    return true;
  });
};

/**
 * What the linter flags is what the reader wants fixed, and after that the
 * fix nearest the cursor beats a stray change the model made further away.
 */
export const orderedByRelevance = (suggestions: Suggestion[], target: EditTarget, diagnostics: Diagnostic[]): Suggestion[] => {
  const anchor = target.cursor?.line ?? Math.floor((target.windowStart + target.windowEnd) / 2);

  const rank = (suggestion: Suggestion): number => {
    if (suggestion.kind !== "edit") return 0;

    const isFlagged = diagnostics.some(held => held.line >= suggestion.startLine && held.line <= suggestion.endLine);

    return (isFlagged ? 0 : 1000) + Math.abs(suggestion.startLine - anchor);
  };

  return suggestions.toSorted((left, right) => rank(left) - rank(right));
};

export type Derived = {
  edits: Suggestion[];
  requiresFormatter: boolean;
};

/** The repairs the extension works out for itself from the window, the changes, and the diagnostics. */
export const derivedRepairs = (target: EditTarget, changes: RecentEdit[], diagnostics: Diagnostic[]): Derived => {
  const repair = whitespaceRepairFor(target, diagnostics);
  const edits = uniqueBy([...renameSpreadFor(target, changes), ...repair.edits], item => JSON.stringify(item));

  return {
    edits: orderedByRelevance(edits, target, diagnostics),
    requiresFormatter: repair.requiresFormatter,
  };
};

/**
 * What the model proposed comes first, in relevance order, and the mechanical repairs
 * follow. A semicolon or a trimmed space is right, and it is also what the reader wants
 * to see last, after the edit that carries their intent.
 */
export const modelFirst = (model: Suggestion[], derived: Suggestion[], target: EditTarget, diagnostics: Diagnostic[]): Suggestion[] =>
  uniqueBy([...orderedByRelevance(model, target, diagnostics), ...derived], item => JSON.stringify(item));
