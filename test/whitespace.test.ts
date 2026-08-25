import { describe, expect, it } from "vitest";

import type { Diagnostic } from "../src/context/diagnostics";
import type { EditTarget } from "../src/format/next-edit";
import { whitespaceRepairFor } from "../src/format/whitespace";

const targetOf = (lines: string[], cursor?: { line: number; character: number; }): EditTarget => ({
  path: "src/series.ts",
  lines,
  windowStart: 0,
  windowEnd: lines.length,
  cursor,
  previousWindow: undefined,
});

const twoSpaceFile = [
  "export const meanOf = (series: Series): number => {",
  "  const total = sumOf(series);",
  "  if (total === 0) {",
  "    return 0;",
  "  }",
  "  return total / series.samples.length;",
  "};",
];

const eslintIndent = (line: number, wanted: number, found: number): Diagnostic => ({
  line,
  character: 0,
  severity: "warning",
  source: "eslint",
  message: `Expected indentation of ${wanted} spaces but found ${found}.`,
});

describe("whitespaceRepairFor, trailing space", () => {
  it("trims a line the reader is not typing on", () => {
    const lines = [...twoSpaceFile];

    lines[1] = `${lines[1]}     `;

    expect(whitespaceRepairFor(targetOf(lines), []).edits).toEqual([{
      kind: "edit",
      path: "src/series.ts",
      startLine: 1,
      startCharacter: 30,
      endLine: 1,
      endCharacter: 35,
      text: "",
    }]);
  });

  it("trims with the cursor resting where the content ends", () => {
    const lines = [...twoSpaceFile];

    lines[1] = `${lines[1]}     `;

    expect(whitespaceRepairFor(targetOf(lines, { line: 1, character: 30 }), []).edits).toHaveLength(1);
  });

  it("leaves the run alone while the cursor sits inside it", () => {
    const lines = [...twoSpaceFile];

    lines[1] = `${lines[1]}     `;

    expect(whitespaceRepairFor(targetOf(lines, { line: 1, character: 32 }), []).edits).toEqual([]);
  });

  it("leaves an indentation-only line alone, because that is a reader between statements", () => {
    const lines = [...twoSpaceFile];

    lines.splice(2, 0, " ".repeat(4));

    expect(whitespaceRepairFor(targetOf(lines), []).edits).toEqual([]);
  });

  it("says nothing about a file that is already clean", () => {
    expect(whitespaceRepairFor(targetOf(twoSpaceFile), [])).toEqual({ edits: [], requiresFormatter: false });
  });
});

describe("whitespaceRepairFor, indentation", () => {
  it("asks for the formatter when the drift is visible and no diagnostic names the column", () => {
    const lines = [...twoSpaceFile];

    lines[3] = `     ${lines[3]}`;

    expect(whitespaceRepairFor(targetOf(lines), [])).toEqual({ edits: [], requiresFormatter: true });
  });

  it("edits the line exactly when a diagnostic names the column", () => {
    const lines = [...twoSpaceFile];

    lines[3] = `     ${lines[3]}`;

    expect(whitespaceRepairFor(targetOf(lines), [eslintIndent(3, 4, 9)])).toEqual({
      edits: [{
        kind: "edit",
        path: "src/series.ts",
        startLine: 3,
        startCharacter: 4,
        endLine: 3,
        endCharacter: 9,
        text: "",
      }],
      requiresFormatter: false,
    });
  });

  it("pads a line the linter says is short", () => {
    const lines = [...twoSpaceFile];

    lines[3] = "return 0;";

    expect(whitespaceRepairFor(targetOf(lines), [eslintIndent(3, 4, 0)]).edits).toEqual([{
      kind: "edit",
      path: "src/series.ts",
      startLine: 3,
      startCharacter: 0,
      endLine: 3,
      endCharacter: 0,
      text: " ".repeat(4),
    }]);
  });

  it("leaves a block comment continuation alone, which is indented one past its opener", () => {
    const lines = [
      "/**",
      " * How a file ends is policy, not prediction.",
      " */",
      "export const tail = (lines: string[]): string => {",
      "  return lines[lines.length - 1] ?? \"\";",
      "};",
    ];

    expect(whitespaceRepairFor(targetOf(lines), [])).toEqual({ edits: [], requiresFormatter: false });
  });

  it("stays quiet on a tab indented file, where a space count measures nothing", () => {
    const lines = ["fn main() {", "\tlet total = 0;", "\t\tlet drifted = 1;", "}"];

    expect(whitespaceRepairFor(targetOf(lines), [])).toEqual({ edits: [], requiresFormatter: false });
  });

  it("ignores drift outside the window", () => {
    const lines = [...twoSpaceFile];

    lines[5] = `     ${lines[5]}`;

    const target = { ...targetOf(lines), windowStart: 0, windowEnd: 4 };

    expect(whitespaceRepairFor(target, [])).toEqual({ edits: [], requiresFormatter: false });
  });
});

const withoutSemicolon = ["export const one = 1;", "export const two = 2", "export const three = 3;"];

const semicolonDiagnostic = (message: string): Diagnostic =>
  ({ line: 1, character: 20, severity: "error", source: "ts", message });

describe("whitespaceRepairFor, missing semicolon", () => {
  it("matches the compiler wording", () => {
    expect(whitespaceRepairFor(targetOf(withoutSemicolon), [semicolonDiagnostic("';' expected.")]).edits).toEqual([{
      kind: "edit",
      path: "src/series.ts",
      startLine: 1,
      startCharacter: 20,
      endLine: 1,
      endCharacter: 20,
      text: ";",
    }]);
  });

  it("matches the eslint wording, which the compiler never emits for this", () => {
    expect(whitespaceRepairFor(targetOf(withoutSemicolon), [semicolonDiagnostic("Missing semicolon.")]).edits).toHaveLength(1);
  });

  it("adds nothing to a line that already ends in one", () => {
    expect(whitespaceRepairFor(targetOf(withoutSemicolon), [semicolonDiagnostic("';' expected.")].map(held => ({ ...held, line: 0 }))).edits).toEqual([]);
  });
});
