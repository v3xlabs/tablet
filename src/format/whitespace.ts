import type { Diagnostic } from "../context/diagnostics";
import type { Suggestion } from "../suggest";
import type { EditTarget } from "./next-edit";

const INDENT_UNITS = new Set([2, 4, 8]);

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * The step a file indents by, taken from how often each step appears between consecutive
 * lines rather than from a setting, because the file the reader is in is the authority on
 * its own shape. A file with no nesting has no unit, and nothing below it runs.
 */
const indentUnitOf = (lines: string[]): number | undefined => {
  const steps = new Map<number, number>();
  let previous: number | undefined;

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    const indent = indentOf(line);

    if (previous !== undefined && indent > previous) {
      const step = indent - previous;

      steps.set(step, (steps.get(step) ?? 0) + 1);
    }

    previous = indent;
  }

  return [...steps]
    .filter(([step]) => INDENT_UNITS.has(step))
    .toSorted((left, right) => right[1] - left[1])[0]?.[0];
};

/**
 * A continuation line of a block comment is indented one space past the opener, and a tab
 * indented file measures nothing useful in spaces. Both are left alone rather than
 * reported as drift.
 */
const isMeasurable = (line: string): boolean => {
  const trimmed = line.trim();

  if (trimmed.length === 0 || line.includes("\t")) return false;

  return !(trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//") || trimmed.startsWith("#"));
};

const driftedLines = (target: EditTarget): number[] => {
  const unit = indentUnitOf(target.lines);

  if (unit === undefined) return [];

  const drifted: number[] = [];

  for (let line = target.windowStart; line < target.windowEnd; line++) {
    const text = target.lines[line];

    if (text === undefined || !isMeasurable(text)) continue;

    if (indentOf(text) % unit !== 0) drifted.push(line);
  }

  return drifted;
};

/**
 * Trimming the spaces a reader is in the middle of typing is worse than leaving them, so
 * the cursor sitting inside the run is what rules a line out. A cursor resting where the
 * content ends is the reader looking at the mess, not making it.
 */
const isCursorInsideRun = (target: EditTarget, line: number, runStart: number): boolean =>
  target.cursor !== undefined && target.cursor.line === line && target.cursor.character > runStart;

const trailingFixes = (target: EditTarget): Suggestion[] => {
  const fixes: Suggestion[] = [];

  for (let line = target.windowStart; line < target.windowEnd; line++) {
    const text = target.lines[line];

    if (text === undefined || text.trim().length === 0) continue;

    const trimmed = text.trimEnd();

    if (trimmed.length === text.length) continue;

    if (isCursorInsideRun(target, line, trimmed.length)) continue;

    fixes.push({
      kind: "edit",
      path: target.path,
      startLine: line,
      startCharacter: trimmed.length,
      endLine: line,
      endCharacter: text.length,
      text: "",
    });
  }

  return fixes;
};

const WANTED_INDENT = /Expected indentation of (\d+) spaces? but found (\d+)/;
const MISSING_SEMICOLON = /';' expected|Missing semicolon/;

/** The column a linter named, for the lines it named. Drift it says nothing about stays undecided. */
const wantedIndents = (diagnostics: Diagnostic[]): Map<number, number> => {
  const wanted = new Map<number, number>();

  for (const diagnostic of diagnostics) {
    const match = WANTED_INDENT.exec(diagnostic.message);
    const column = match?.[1];

    if (column !== undefined) wanted.set(diagnostic.line, Number(column));
  }

  return wanted;
};

const indentFix = (target: EditTarget, line: number, wanted: number): Suggestion | undefined => {
  const text = target.lines[line];

  if (text === undefined) return undefined;

  const actual = indentOf(text);

  if (actual === wanted) return undefined;

  return actual > wanted
    ? { kind: "edit", path: target.path, startLine: line, startCharacter: wanted, endLine: line, endCharacter: actual, text: "" }
    : { kind: "edit", path: target.path, startLine: line, startCharacter: actual, endLine: line, endCharacter: actual, text: " ".repeat(wanted - actual) };
};

const semicolonFixes = (target: EditTarget, diagnostics: Diagnostic[]): Suggestion[] => {
  const fixes: Suggestion[] = [];

  for (const diagnostic of diagnostics) {
    if (!MISSING_SEMICOLON.test(diagnostic.message)) continue;

    const text = target.lines[diagnostic.line];

    if (text === undefined) continue;

    const trimmed = text.trimEnd();

    if (trimmed.length === 0 || trimmed.endsWith(";")) continue;

    // a cursor inside the content is the reader still typing the statement, and the
    // linter has not seen the end of it yet either
    if (isCursorInsideRun(target, diagnostic.line, 0) && target.cursor !== undefined && target.cursor.character < trimmed.length) continue;

    fixes.push({
      kind: "edit",
      path: target.path,
      startLine: diagnostic.line,
      startCharacter: text.length,
      endLine: diagnostic.line,
      endCharacter: text.length,
      text: ";",
    });
  }

  return fixes;
};

export type WhitespaceRepair = {
  edits: Suggestion[];
  /**
   * A line drifted and nothing said what its indent should be, which is the state rustfmt
   * and gofmt leave a file in: they repair silently and report nothing. Guessing the
   * column from the neighbours is how a fix lands one level out, so the language's own
   * formatter is offered instead, and only when there is nothing else to say.
   */
  requiresFormatter: boolean;
};

/**
 * Whitespace is decided from the window itself, and a diagnostic only names the column an
 * indent should reach. Reading the text rather than the message is what lets this fire in
 * a rust or python editor, where the formatter never files a complaint to match against.
 */
export const whitespaceRepairFor = (target: EditTarget, diagnostics: Diagnostic[]): WhitespaceRepair => {
  const inWindow = diagnostics.filter(held => held.line >= target.windowStart && held.line < target.windowEnd);
  const wanted = wantedIndents(inWindow);
  const drifted = driftedLines(target);
  const edits = [...trailingFixes(target), ...semicolonFixes(target, inWindow)];
  let isWantsFormatter = false;

  for (const line of drifted) {
    const column = wanted.get(line);

    if (column === undefined) {
      isWantsFormatter = true;

      continue;
    }

    const fix = indentFix(target, line, column);

    if (fix !== undefined) edits.push(fix);
  }

  // a linter can flag an indent the file's own step agrees with, which is drift the file
  // does not show; those lines are still the linter's to name
  for (const [line, column] of wanted) {
    if (drifted.includes(line)) continue;

    const fix = indentFix(target, line, column);

    if (fix !== undefined) edits.push(fix);
  }

  return { edits, requiresFormatter: isWantsFormatter };
};
