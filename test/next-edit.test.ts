import { describe, expect, it } from "vitest";

import { assembleNextEdit, type EditTarget, NEXT_EDIT_DEFAULTS, readNextEdit } from "../src/format/next-edit";

const target: EditTarget = {
  path: "src/user.ts",
  lines: ["type User = {", "  displayName: string;", "};"],
  windowStart: 0,
  windowEnd: 3,
  cursor: { line: 1, character: 13 },
  previousWindow: ["type User = {", "  name: string;", "};"],
};

const base = {
  template: NEXT_EDIT_DEFAULTS.template,
  chunkTemplate: NEXT_EDIT_DEFAULTS.chunkTemplate,
  changeTemplate: NEXT_EDIT_DEFAULTS.changeTemplate,
  cursorMarker: NEXT_EDIT_DEFAULTS.cursorMarker,
  contextLines: 300,
  target,
  chunks: [],
  changes: [],
};

describe("assembleNextEdit", () => {
  it("lays the sections out in the order the model was trained on", () => {
    const assembled = assembleNextEdit(base);
    const prompt = assembled.ok ? assembled.prompt : "";

    expect(prompt.indexOf("<|file_sep|>original/")).toBeLessThan(prompt.indexOf("<|file_sep|>current/"));
    expect(prompt.indexOf("<|file_sep|>current/")).toBeLessThan(prompt.indexOf("<|file_sep|>updated/"));
  });

  it("marks the cursor inside the current window only", () => {
    const assembled = assembleNextEdit(base);
    const prompt = assembled.ok ? assembled.prompt : "";

    expect(prompt).toContain("  displayName<|cursor|>: string;");
    expect(prompt.match(/<\|cursor\|>/g)).toHaveLength(1);
  });

  it("names the window line range the model should rewrite", () => {
    const assembled = assembleNextEdit(base);

    expect(assembled.ok && assembled.prompt).toContain("<|file_sep|>updated/src/user.ts:1:3");
  });

  it("shows the window before the edit as the original", () => {
    const assembled = assembleNextEdit(base);

    expect(assembled.ok && assembled.prompt).toContain("original/src/user.ts:1:3\ntype User = {\n  name: string;");
  });

  it("leaves the cursor out of a file the cursor is not in", () => {
    const assembled = assembleNextEdit({
      ...base,
      target: { ...target, cursor: undefined, previousWindow: undefined },
    });

    expect(assembled.ok && assembled.prompt).not.toContain("<|cursor|>");
  });

  it("renders each recent change as an original and updated pair", () => {
    const assembled = assembleNextEdit({
      ...base,
      changes: [{ path: "src/user.ts", before: "  name: string;", after: "  displayName: string;" }],
    });

    expect(assembled.ok && assembled.prompt).toContain("<|file_sep|>original/src/user.ts\n  name: string;\n");
  });
});

describe("readNextEdit", () => {
  it("returns nothing when the model rewrote the window unchanged", () => {
    expect(readNextEdit("type User = {\n  displayName: string;\n};", target)).toBeUndefined();
  });

  it("narrows a rewritten window to the line that changed", () => {
    const edit = readNextEdit("type User = {\n  displayName: number;\n};", target);

    expect(edit).toEqual({ startLine: 1, endLine: 2, text: "  displayName: number;" });
  });

  it("ignores a header the model wrote itself", () => {
    const edit = readNextEdit("src/user.ts:1:3\ntype User = {\n  displayName: number;\n};", target);

    expect(edit).toEqual({ startLine: 1, endLine: 2, text: "  displayName: number;" });
  });

  it("returns nothing for an empty reply", () => {
    expect(readNextEdit("\n\n", target)).toBeUndefined();
  });
});
