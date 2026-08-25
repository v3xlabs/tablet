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
  diagnosticTemplate: NEXT_EDIT_DEFAULTS.diagnosticTemplate,
  formatTemplate: NEXT_EDIT_DEFAULTS.formatTemplate,
  cursorMarker: NEXT_EDIT_DEFAULTS.cursorMarker,
  formatMarker: NEXT_EDIT_DEFAULTS.formatMarker,
  contextLines: 300,
  target,
  chunks: [],
  changes: [],
  diagnostics: [],
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

  it("renders each recent change as its own diff block", () => {
    const assembled = assembleNextEdit({
      ...base,
      changes: [{ path: "src/user.ts", before: "  name: string;", after: "  displayName: string;" }],
    });

    expect(assembled.ok && assembled.prompt).toContain(
      "<|file_sep|>src/user.ts.diff\noriginal:\n  name: string;\nupdated:\n  displayName: string;\n",
    );
  });
});

describe("readNextEdit", () => {
  it("returns nothing when the model rewrote the window unchanged", () => {
    expect(readNextEdit("type User = {\n  displayName: string;\n};", target, NEXT_EDIT_DEFAULTS.formatMarker)).toEqual({ kind: "none" });
  });

  it("narrows a rewritten window to the line that changed", () => {
    const edit = readNextEdit("type User = {\n  displayName: number;\n};", target, NEXT_EDIT_DEFAULTS.formatMarker);

    expect(edit).toEqual({ kind: "edits", edits: [{ startLine: 1, startCharacter: 15, endLine: 1, endCharacter: 21, text: "number" }] });
  });

  it("ignores a header the model wrote itself", () => {
    const edit = readNextEdit("src/user.ts:1:3\ntype User = {\n  displayName: number;\n};", target, NEXT_EDIT_DEFAULTS.formatMarker);

    expect(edit).toEqual({ kind: "edits", edits: [{ startLine: 1, startCharacter: 15, endLine: 1, endCharacter: 21, text: "number" }] });
  });

  it("drops an echoed cursor marker instead of inserting it", () => {
    const edit = readNextEdit("type User = {\n  displayName<|cursor|>: number;\n};", target, NEXT_EDIT_DEFAULTS.formatMarker, "<|cursor|>");

    expect(edit).toEqual({ kind: "edits", edits: [{ startLine: 1, startCharacter: 15, endLine: 1, endCharacter: 21, text: "number" }] });
  });

  it("returns nothing for an empty reply", () => {
    expect(readNextEdit("\n\n", target, NEXT_EDIT_DEFAULTS.formatMarker)).toEqual({ kind: "none" });
  });

  it("splits a reply that fixes one place and invents another into separate edits", () => {
    const broken: EditTarget = {
      path: "src/test.ts",
      lines: ["const hello = () => {", "      log(\"hi\");", "};", "", "const other = 1;"],
      windowStart: 0,
      windowEnd: 5,
      cursor: { line: 1, character: 6 },
      previousWindow: undefined,
    };

    const reply = readNextEdit(
      "const hello = () => {\n  log(\"hi\");\n};\n\nconst other = 1;\n\nhello();",
      broken,
      NEXT_EDIT_DEFAULTS.formatMarker,
    );

    expect(reply).toEqual({
      kind: "edits",
      edits: [
        { startLine: 1, startCharacter: 2, endLine: 1, endCharacter: 6, text: "" },
        { startLine: 4, startCharacter: 16, endLine: 4, endCharacter: 16, text: "\n\nhello();" },
      ],
    });
  });
});

const windowed = (lines: string[]): EditTarget => ({
  path: "src/test.ts",
  lines,
  windowStart: 0,
  windowEnd: lines.length,
  cursor: undefined,
  previousWindow: undefined,
});

describe("readNextEdit, deletions", () => {
  it("proposes a deletion as an empty replacement over the removed range", () => {
    const edit = readNextEdit("const a = 1;\nconst b = 2;", windowed(["const a = 1;", "", "", "const b = 2;"]), NEXT_EDIT_DEFAULTS.formatMarker);

    expect(edit).toEqual({ kind: "edits", edits: [{ startLine: 1, startCharacter: 0, endLine: 3, endCharacter: 0, text: "" }] });
  });

  it("deletes a stray closing brace at the end of a file", () => {
    const edit = readNextEdit("const a = 1;", windowed(["const a = 1;", "};"]), NEXT_EDIT_DEFAULTS.formatMarker);

    expect(edit).toEqual({ kind: "edits", edits: [{ startLine: 0, startCharacter: 12, endLine: 1, endCharacter: 2, text: "" }] });
  });

  it("removes the trailing indentation of a whitespace only line", () => {
    const edit = readNextEdit("const a = 1;\n\nconst b = 2;", windowed(["const a = 1;", " ".repeat(4), "const b = 2;"]), NEXT_EDIT_DEFAULTS.formatMarker);

    expect(edit).toEqual({ kind: "edits", edits: [{ startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 4, text: "" }] });
  });

  it("does not invent a deletion when the window really ends in blank lines", () => {
    expect(readNextEdit("const a = 1;\n\n\n", windowed(["const a = 1;", "", ""]), NEXT_EDIT_DEFAULTS.formatMarker)).toEqual({ kind: "none" });
  });

  it("does not read the file's final newline as a deletion when the reply leaves it out", () => {
    expect(readNextEdit("const a = 1;\n", windowed(["const a = 1;", ""]), NEXT_EDIT_DEFAULTS.formatMarker)).toEqual({ kind: "none" });
  });

  it("keeps the final newline when deleting the last code line", () => {
    const edit = readNextEdit("const a = 1;", windowed(["const a = 1;", "const b = 2;", ""]), NEXT_EDIT_DEFAULTS.formatMarker);

    expect(edit).toEqual({ kind: "edits", edits: [{ startLine: 0, startCharacter: 12, endLine: 1, endCharacter: 12, text: "" }] });
  });

  it("refuses a reply that would blank the whole window", () => {
    expect(readNextEdit("\n   \n  ", windowed(["const a = 1;", "const b = 2;"]), NEXT_EDIT_DEFAULTS.formatMarker)).toEqual({ kind: "none" });
  });
});

describe("assembleNextEdit, diagnostics", () => {
  it("leaves the section out when the file is clean", () => {
    const assembled = assembleNextEdit(base);

    expect(assembled.ok && assembled.prompt).not.toContain("diagnostics/");
  });

  it("puts what the linter said ahead of the window", () => {
    const assembled = assembleNextEdit({
      ...base,
      diagnostics: [{ line: 1, character: 2, severity: "warning", source: "eslint", message: "prefer const" }],
    });

    const prompt = assembled.ok ? assembled.prompt : "";

    expect(prompt).toContain("<|file_sep|>diagnostics/src/user.ts\n2:3 warning eslint: prefer const\n");
    expect(prompt.indexOf("diagnostics/")).toBeLessThan(prompt.indexOf("<|file_sep|>current/"));
  });
});

describe("readNextEdit, asking for the formatter", () => {
  it("reads the marker as a request to format", () => {
    const reply = readNextEdit("<|format|>", windowed(["const a = 1;"]), NEXT_EDIT_DEFAULTS.formatMarker);

    expect(reply).toEqual({ kind: "format" });
  });

  it("ignores the blank lines a model puts around the marker", () => {
    const reply = readNextEdit("\n<|format|>\n", windowed(["const a = 1;"]), NEXT_EDIT_DEFAULTS.formatMarker);

    expect(reply).toEqual({ kind: "format" });
  });

  it("treats a marker inside code as code", () => {
    const reply = readNextEdit("const a = \"<|format|>\";", windowed(["const a = 1;"]), NEXT_EDIT_DEFAULTS.formatMarker);

    expect(reply.kind).toBe("edits");
  });

  it("stops looking for the marker when it is configured away", () => {
    const reply = readNextEdit("<|format|>", windowed(["const a = 1;"]), "");

    expect(reply.kind).toBe("edits");
  });
});

describe("assembleNextEdit, the format instruction", () => {
  it("tells the model the marker it may answer with", () => {
    const assembled = assembleNextEdit({ ...base, formatMarker: "<|format|>" });

    expect(assembled.ok && assembled.prompt).toContain("Reply with <|format|> alone to run the formatter");
  });
});

describe("assembleNextEdit, turning the formatter off", () => {
  it("drops the whole instruction when the marker is empty", () => {
    const assembled = assembleNextEdit({ ...base, formatMarker: "" });

    expect(assembled.ok && assembled.prompt).not.toContain("instructions");
    expect(assembled.ok && assembled.prompt).not.toContain("formatter");
  });
});
