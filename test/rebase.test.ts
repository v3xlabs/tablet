import { describe, expect, it } from "vitest";

import { rebaseSuggestions } from "../src/rebase";
import type { Suggestion } from "../src/suggest";

const edit = (startLine: number, startCharacter: number, endLine: number, endCharacter: number, text: string): Suggestion =>
  ({ kind: "edit", path: "a.ts", startLine, startCharacter, endLine, endCharacter, text });

const before = "const total = sum(items);\nreturn total;\n";

describe("rebaseSuggestions", () => {
  it("leaves the rest of an insertion when the reader types its start", () => {
    const suggested = [edit(0, 24, 0, 24, " * rate")];

    expect(rebaseSuggestions(suggested, "a.ts", before, "const total = sum(items) *;\nreturn total;\n"))
      .toEqual({ suggestions: [edit(0, 26, 0, 26, " rate")], isAgreed: true });
  });

  it("drops an insertion the reader typed out in full and carries the rest", () => {
    const suggested = [edit(0, 24, 0, 24, " * rate"), edit(1, 7, 1, 12, "total * rate")];

    expect(rebaseSuggestions(suggested, "a.ts", before, "const total = sum(items) * rate;\nreturn total;\n"))
      .toEqual({ suggestions: [edit(1, 7, 1, 12, "total * rate")], isAgreed: true });
  });

  it("recognises an accepted edit applied over a wider range than the edit", () => {
    const suggested = [edit(0, 6, 0, 11, "subtotal"), edit(1, 7, 1, 12, "subtotal")];

    expect(rebaseSuggestions(suggested, "a.ts", before, "const subtotal = sum(items);\nreturn total;\n"))
      .toEqual({ suggestions: [edit(1, 7, 1, 12, "subtotal")], isAgreed: true });
  });

  it("moves an edit below an unrelated new line down with it, without agreement", () => {
    const suggested = [edit(1, 7, 1, 12, "total * rate")];

    expect(rebaseSuggestions(suggested, "a.ts", before, "const total = sum(items);\nlog(total);\nreturn total;\n"))
      .toEqual({ suggestions: [edit(2, 7, 2, 12, "total * rate")], isAgreed: false });
  });

  it("keeps an edit above the reader's change where it was", () => {
    const suggested = [edit(0, 6, 0, 11, "subtotal")];

    expect(rebaseSuggestions(suggested, "a.ts", before, "const total = sum(items);\nreturn total + 1;\n").suggestions).toEqual(suggested);
  });

  it("drops an insertion when the reader types something else at the same place", () => {
    const suggested = [edit(0, 24, 0, 24, " * rate")];

    expect(rebaseSuggestions(suggested, "a.ts", before, "const total = sum(items)!;\nreturn total;\n"))
      .toEqual({ suggestions: [], isAgreed: false });
  });

  it("drops a replacement whose text the reader changed", () => {
    const suggested = [edit(0, 6, 0, 11, "subtotal")];

    expect(rebaseSuggestions(suggested, "a.ts", before, "const totals = sum(items);\nreturn total;\n").suggestions).toEqual([]);
  });

  it("carries an edit in another file and drops a completion", () => {
    const elsewhere: Suggestion = { kind: "edit", path: "b.ts", startLine: 3, startCharacter: 0, endLine: 3, endCharacter: 0, text: "x" };

    expect(rebaseSuggestions([elsewhere, { kind: "completion", text: " * rate" }], "a.ts", before, `${before}\n`).suggestions).toEqual([elsewhere]);
  });
});
