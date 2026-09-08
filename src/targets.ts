import type { Diagnostic } from "./context/diagnostics";
import type { EditTarget } from "./format/next-edit";
import { windowAround } from "./snapshot";
import type { SuggestInput } from "./suggest";

export const localTarget = (input: SuggestInput, windowLines: number): EditTarget => {
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

/**
 * The linter already knows where the file is broken, and the model proposes edits close to
 * the cursor far more readily than away from it. When the nearest diagnostic is not where
 * the cursor is, a second window centred on the diagnostic is what turns "the lsp is
 * failing on line 60" into a suggestion. Errors win over warnings, nearest first.
 */
export const diagnosticTarget = (input: SuggestInput, windowLines: number): { target: EditTarget; diagnostic: Diagnostic; } | undefined => {
  const { snapshot } = input;
  const outside = input.diagnostics.filter(held => Math.abs(held.line - snapshot.cursorLine) > 2);
  const errors = outside.filter(held => held.severity === "error");

  const chosen = (errors.length > 0 ? errors : outside)
    .toSorted((left, right) => Math.abs(left.line - snapshot.cursorLine) - Math.abs(right.line - snapshot.cursorLine))[0];

  if (chosen === undefined) return undefined;

  const span = windowAround(snapshot.lines.length, chosen.line, windowLines);

  return {
    diagnostic: chosen,
    target: {
      path: snapshot.path,
      lines: snapshot.lines,
      windowStart: span.start,
      windowEnd: span.end,
      cursor: undefined,
      previousWindow: input.previousByPath.get(snapshot.path)?.slice(span.start, span.end),
    },
  };
};
