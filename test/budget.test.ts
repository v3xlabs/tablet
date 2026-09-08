import { describe, expect, it } from "vitest";

import { clipHunk, clipLine, estimateTokens, firstSentence, fitToBudget } from "../src/format/budget";
import { assembleNextEdit, type EditTarget, NEXT_EDIT_DEFAULTS } from "../src/format/next-edit";

describe("firstSentence", () => {
  it("drops the type dump after the first sentence", () => {
    const message = "Argument of type 'A' is not assignable to parameter of type 'B'. Property 'kind' is missing in type 'A'.";

    expect(firstSentence(message)).toBe("Argument of type 'A' is not assignable to parameter of type 'B'.");
  });

  it("keeps a message with no sentence break whole", () => {
    expect(firstSentence("';' expected.")).toBe("';' expected.");
  });

  it("does not split on a dot inside a path or version", () => {
    expect(firstSentence("Cannot find module './user.ts' or its type declarations.")).toBe("Cannot find module './user.ts' or its type declarations.");
  });
});

describe("clipHunk and clipLine", () => {
  it("keeps head and tail of a long hunk with a count between", () => {
    const hunk = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const clipped = clipHunk(hunk, 12);

    expect(clipped.split("\n")).toHaveLength(13);
    expect(clipped).toContain("... 18 lines ...");
    expect(clipped.startsWith("line 0\n")).toBe(true);
    expect(clipped.endsWith("line 29")).toBe(true);
  });

  it("leaves a short hunk alone", () => {
    expect(clipHunk("a\nb", 12)).toBe("a\nb");
  });

  it("cuts a line past the limit with a marker", () => {
    expect(clipLine("x".repeat(500))).toBe(`${"x".repeat(400)} ...`);
    expect(clipLine("short")).toBe("short");
  });
});

describe("fitToBudget", () => {
  it("applies the earliest step that changes something until the estimate fits", () => {
    const fitted = fitToBudget(
      { chunks: ["a".repeat(700), "b".repeat(700)], body: "c".repeat(700) },
      100,
      {
        render: parts => [...parts.chunks, parts.body].join(""),
        steps: [
          parts => (parts.chunks.length > 0 ? { ...parts, chunks: parts.chunks.slice(1) } : undefined),
          parts => (parts.body.length > 100 ? { ...parts, body: parts.body.slice(0, 100) } : undefined),
        ],
      },
    );

    expect(fitted.parts.chunks).toEqual([]);
    expect(fitted.parts.body).toHaveLength(100);
    expect(fitted.tokens).toBeLessThanOrEqual(100);
  });

  it("stops when no step has anything left, even over budget", () => {
    const fitted = fitToBudget({ body: "x".repeat(1000) }, 10, { render: parts => parts.body, steps: [() => {}] });

    expect(fitted.tokens).toBe(estimateTokens("x".repeat(1000)));
  });
});

const lines = Array.from({ length: 400 }, (_, index) => `const value${index} = ${index};`);

const target: EditTarget = {
  path: "src/big.ts",
  lines,
  windowStart: 190,
  windowEnd: 211,
  cursor: { line: 200, character: 0 },
  previousWindow: undefined,
};

const base = {
  template: NEXT_EDIT_DEFAULTS.template,
  chunkTemplate: NEXT_EDIT_DEFAULTS.chunkTemplate,
  changeTemplate: NEXT_EDIT_DEFAULTS.changeTemplate,
  diagnosticTemplate: NEXT_EDIT_DEFAULTS.diagnosticTemplate,
  formatTemplate: NEXT_EDIT_DEFAULTS.formatTemplate,
  cursorMarker: NEXT_EDIT_DEFAULTS.cursorMarker,
  formatMarker: NEXT_EDIT_DEFAULTS.formatMarker,
  contextLines: 300,
  target,
  chunks: [
    { path: "src/other.ts", startLine: 0, lines: Array.from({ length: 16 }, (_, index) => `export const other${index} = ${index};`) },
    { path: "src/third.ts", startLine: 0, lines: Array.from({ length: 16 }, (_, index) => `export const third${index} = ${index};`) },
  ],
  changes: [{ path: "src/big.ts", line: 0, isPredicted: false, before: "const value1 = 1;", after: "const value1 = 10;" }],
  diagnostics: [
    { line: 200, character: 0, severity: "error", source: "ts", message: "on the window" },
    { line: 20, character: 0, severity: "warning", source: "ts", message: "far away" },
  ],
};

describe("assembleNextEdit within a budget", () => {
  it("sends everything when the budget is generous", () => {
    const assembled = assembleNextEdit({ ...base, budget: 10_000 });

    expect(assembled.ok).toBe(true);

    if (!assembled.ok) return;

    expect(assembled.prompt).toContain("src/other.ts");
    expect(assembled.prompt).toContain("src/third.ts");
    expect(assembled.prompt).toContain("far away");
    expect(assembled.prompt).toContain("const value60 = 60;");
    expect(assembled.tokens).toBe(estimateTokens(assembled.prompt));
  });

  it("drops chunks, then far diagnostics, then shrinks the excerpt, and keeps the windows whole", () => {
    const assembled = assembleNextEdit({ ...base, budget: 600 });

    expect(assembled.ok).toBe(true);

    if (!assembled.ok) return;

    expect(assembled.tokens).toBeLessThanOrEqual(600);
    expect(assembled.prompt).not.toContain("src/other.ts");
    expect(assembled.prompt).not.toContain("src/third.ts");
    expect(assembled.prompt).not.toContain("far away");
    expect(assembled.prompt).not.toContain("const value60 = 60;");
    expect(assembled.prompt).toContain("<|file_sep|>current/src/big.ts:191:211\nconst value190 = 190;");
    expect(assembled.prompt).toContain("const value210 = 210;\n<|file_sep|>updated/");
  });

  it("keeps a diagnostic on the window until last", () => {
    const assembled = assembleNextEdit({ ...base, budget: 600 });

    expect(assembled.ok && assembled.prompt).toContain("on the window");
  });

  it("clips a long line in the excerpt but never in the window", () => {
    const long = "y".repeat(900);
    const withLong = { ...target, lines: lines.map((line, index) => (index === 100 || index === 200 ? long : line)) };
    const assembled = assembleNextEdit({ ...base, target: withLong, budget: 10_000 });

    expect(assembled.ok && assembled.prompt).toContain(`${"y".repeat(400)} ...`);
    expect(assembled.ok && assembled.prompt).toContain(`current/src/big.ts:191:211\n${lines.slice(190, 200).join("\n")}\n<|cursor|>${long}`);
  });
});
