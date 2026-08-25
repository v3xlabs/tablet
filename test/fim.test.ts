import { describe, expect, it } from "vitest";

import { assembleFim, FIM_DEFAULTS } from "../src/format/fim";
import type { Snapshot } from "../src/snapshot";

const snapshot: Snapshot = {
  path: "src/user.ts",
  languageId: "typescript",
  lines: ["const a = 1;", "const b = ", "const c = 3;"],
  cursorLine: 1,
  cursorCharacter: 10,
};

const base = {
  template: FIM_DEFAULTS.template,
  chunkTemplate: FIM_DEFAULTS.chunkTemplate,
  prefixLines: 10,
  suffixLines: 10,
  snapshot,
  chunks: [],
  repo: "tablet",
};

describe("assembleFim", () => {
  it("puts the text before the cursor in the prefix and the rest in the suffix", () => {
    const assembled = assembleFim(base);

    expect(assembled).toEqual({
      ok: true,
      prompt: "<|fim_prefix|>const a = 1;\nconst b = <|fim_suffix|>\nconst c = 3;<|fim_middle|>",
    });
  });

  it("is the bare file level prompt when no chunks are held", () => {
    const assembled = assembleFim(base);

    expect(assembled.ok && assembled.prompt.startsWith("<|fim_prefix|>")).toBe(true);
  });

  it("frames each chunk ahead of the prefix", () => {
    const assembled = assembleFim({
      ...base,
      chunks: [{ path: "src/other.ts", startLine: 0, lines: ["export const x = 1;"] }],
    });

    expect(assembled.ok && assembled.prompt).toContain("<|file_sep|>src/other.ts\nexport const x = 1;\n");
  });

  it("honours a template that renames every marker", () => {
    const assembled = assembleFim({ ...base, template: "<PRE>{{prefix}}<SUF>{{suffix}}<MID>" });

    expect(assembled.ok && assembled.prompt).toBe("<PRE>const a = 1;\nconst b = <SUF>\nconst c = 3;<MID>");
  });

  it("reports a placeholder it cannot fill", () => {
    expect(assembleFim({ ...base, template: "{{prefix}}{{nonsense}}" })).toEqual({ ok: false, unknown: ["nonsense"] });
  });
});
