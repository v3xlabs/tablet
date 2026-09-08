import { describe, expect, it } from "vitest";

import { parseConfigurations } from "../src/config";
import type { EditTarget } from "../src/format/next-edit";
import { unifiedHunk } from "../src/format/udiff";
import { assembleZeta, blockStarts, markedEditable, readZeta, ZETA_DEFAULTS } from "../src/format/zeta";

const numbered = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `line ${index}`);

describe("blockStarts", () => {
  it("cuts a long region into blocks of at most sixteen lines", () => {
    const starts = blockStarts(numbered(40));

    expect(starts).toEqual([0, 16, 32]);
  });

  it("prefers a boundary after a blank line once six lines are in", () => {
    const lines = [...numbered(8), "", ...numbered(10)];

    expect(blockStarts(lines)).toEqual([0, 9]);
  });

  it("does not open a block on a line that only closes something", () => {
    const lines = [...numbered(8), "", "}", ...numbered(20)];

    expect(blockStarts(lines)).toEqual([0, 16]);
  });

  it("folds a short tail into the block before it", () => {
    const lines = [...numbered(16), "", "tail"];

    expect(blockStarts(lines)).toEqual([0]);
  });

  it("keeps a region under six lines as one block", () => {
    expect(blockStarts(numbered(3))).toEqual([0]);
  });
});

const target: EditTarget = {
  path: "src/cart.py",
  lines: [
    "import math",
    "",
    "def total_price(items, tax_rate):",
    "    total = 0",
    "    for item in items:",
    "        total += item.price",
    "    return total",
    "",
    "def count(items):",
    "    return len(items)",
  ],
  windowStart: 2,
  windowEnd: 7,
  cursor: { line: 5, character: 27 },
  previousWindow: undefined,
};

describe("markedEditable", () => {
  it("opens the region with tag one, marks the cursor, and closes with the next tag on its own line", () => {
    expect(markedEditable(target, "<|user_cursor|>")).toBe([
      "<|marker_1|>def total_price(items, tax_rate):",
      "    total = 0",
      "    for item in items:",
      "        total += item.price<|user_cursor|>",
      "    return total",
      "<|marker_2|>",
      "",
    ].join("\n"));
  });
});

const base = {
  template: ZETA_DEFAULTS.template,
  chunkTemplate: ZETA_DEFAULTS.chunkTemplate,
  changeTemplate: ZETA_DEFAULTS.changeTemplate,
  diagnosticTemplate: ZETA_DEFAULTS.diagnosticTemplate,
  cursorMarker: ZETA_DEFAULTS.cursorMarker,
  contextLines: 200,
  budget: 4000,
  target,
  chunks: [],
  changes: [{ path: "src/cart.py", line: 2, isPredicted: false, before: "def total_price(items):\n    total = 0", after: "def total_price(items, tax_rate):\n    total = 0" }],
  diagnostics: [],
};

describe("assembleZeta", () => {
  it("lays out suffix, prefix with history, the file, and the middle tag", () => {
    const assembled = assembleZeta(base);

    expect(assembled.ok && assembled.prompt).toBe([
      "<[fim-suffix]>",
      "def count(items):",
      "    return len(items)",
      "<[fim-prefix]><filename>edit_history",
      "--- a/src/cart.py",
      "+++ b/src/cart.py",
      "@@ -3,2 +3,2 @@",
      "-def total_price(items):",
      "+def total_price(items, tax_rate):",
      "     total = 0",
      "",
      "<filename>src/cart.py",
      "import math",
      "",
      "<|marker_1|>def total_price(items, tax_rate):",
      "    total = 0",
      "    for item in items:",
      "        total += item.price<|user_cursor|>",
      "    return total",
      "<|marker_2|>",
      "<[fim-middle]>",
    ].join("\n"));
  });

  it("leaves the history section out when there are no changes", () => {
    const assembled = assembleZeta({ ...base, changes: [] });

    expect(assembled.ok && assembled.prompt).not.toContain("edit_history");
    expect(assembled.ok && assembled.prompt).toContain("<[fim-prefix]><filename>src/cart.py");
  });

  it("renders related files before the history", () => {
    const assembled = assembleZeta({ ...base, chunks: [{ path: "src/item.py", startLine: 0, lines: ["class Item:", "    price: float"] }] });
    const prompt = assembled.ok ? assembled.prompt : "";

    expect(prompt).toContain("<[fim-prefix]><filename>src/item.py\nclass Item:\n    price: float\n\n<filename>edit_history");
  });

  it("drops chunks before it drops history when over budget", () => {
    const chunk = { path: "src/item.py", startLine: 0, lines: numbered(40) };
    const assembled = assembleZeta({ ...base, chunks: [chunk], budget: 150 });
    const prompt = assembled.ok ? assembled.prompt : "";

    expect(prompt).not.toContain("src/item.py");
    expect(prompt).toContain("edit_history");
  });
});

describe("readZeta", () => {
  it("turns a rewritten span into edits against the window", () => {
    const reply = [
      "<|marker_1|>def total_price(items, tax_rate):",
      "    total = 0",
      "    for item in items:",
      "        total += item.price * (1 + tax_rate)",
      "    return total",
      "<|marker_2|>",
    ].join("\n");

    const read = readZeta(reply, target, "<|user_cursor|>");

    expect(read).toEqual({
      kind: "edits",
      edits: [{ startLine: 5, startCharacter: 27, endLine: 5, endCharacter: 27, text: " * (1 + tax_rate)" }],
    });
  });

  it("reads the same tag twice as nothing to change", () => {
    expect(readZeta("<|marker_1|><|marker_1|>", target, "<|user_cursor|>")).toEqual({ kind: "none" });
  });

  it("reads an echoed cursor marker as no text", () => {
    const reply = "<|marker_1|>def total_price(items, tax_rate):\n    total = 0\n    for item in items:\n        total += item.price<|user_cursor|>\n    return total\n<|marker_2|>";

    expect(readZeta(reply, target, "<|user_cursor|>")).toEqual({ kind: "none" });
  });

  it("rebuilds only the blocks the reply names in a multi block region", () => {
    const long: EditTarget = { path: "a.ts", lines: numbered(40), windowStart: 0, windowEnd: 40, cursor: { line: 20, character: 0 }, previousWindow: undefined };
    const reply = `<|marker_2|>${numbered(40).slice(16, 20)
      .join("\n")}\nchanged 20\n${numbered(40).slice(21, 32)
      .join("\n")}\n<|marker_3|>`;

    expect(readZeta(reply, long, "<|user_cursor|>")).toEqual({
      kind: "edits",
      edits: [{ startLine: 20, startCharacter: 0, endLine: 20, endCharacter: 4, text: "changed" }],
    });
  });
});

describe("unifiedHunk", () => {
  it("writes context, removed, and added lines with a header from the block's line", () => {
    expect(unifiedHunk({ path: "a.ts", line: 9, isPredicted: false, before: "a\nb\nc", after: "a\nB\nc" })).toBe("@@ -10,3 +10,3 @@\n a\n-b\n+B\n c");
  });

  it("writes a pure insertion", () => {
    expect(unifiedHunk({ path: "a.ts", line: 0, isPredicted: false, before: "a\nc", after: "a\nb\nc" })).toBe("@@ -1,2 +1,3 @@\n a\n+b\n c");
  });
});

describe("zeta configuration", () => {
  it("parses with its own defaults", () => {
    const parsed = parseConfigurations({ z: { endpoint: "http://x/v1", model: "zeta-2.1", format: "zeta" } });
    const config = parsed.configurations[0];

    expect(parsed.problems).toEqual([]);
    expect(config?.format).toBe("zeta");

    if (config?.format !== "zeta") return;

    expect(config.windowLines).toBe(32);
    expect(config.contextBudget).toBe(4096);
    expect(config.stop).toEqual(["<[end▁of▁sentence]>"]);
  });

  it("refuses a change template naming before or after", () => {
    const parsed = parseConfigurations({ z: { endpoint: "http://x/v1", model: "m", format: "zeta", changeTemplate: "{{before}}" } });

    expect(parsed.configurations).toEqual([]);
    expect(parsed.problems[0]).toContain("expected path or diff");
  });
});

describe("assembleZeta, accepted predictions in the history", () => {
  it("marks an accepted prediction the way zed does", () => {
    const assembled = assembleZeta({ ...base, changes: base.changes.map(change => ({ ...change, isPredicted: true })) });

    expect(assembled.ok && assembled.prompt).toContain("<filename>edit_history\n// User accepted prediction:\n--- a/src/cart.py");
  });
});
