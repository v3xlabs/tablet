import { describe, expect, it } from "vitest";

import { applyEdits } from "../src/format/apply-edits";

const text = "const a = 1;\n    const b = 2;\nconst c = 3;";

describe("applyEdits", () => {
  it("returns the text unchanged when there is nothing to do", () => {
    expect(applyEdits(text, [])).toBe(text);
  });

  it("applies one edit", () => {
    const edited = applyEdits(text, [{ startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 4, text: "" }]);

    expect(edited).toBe("const a = 1;\nconst b = 2;\nconst c = 3;");
  });

  it("applies several edits without letting the earlier ones shift the later ones", () => {
    const edited = applyEdits(text, [
      { startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 7, text: "first" },
      { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 4, text: "" },
      { startLine: 2, startCharacter: 6, endLine: 2, endCharacter: 7, text: "third" },
    ]);

    expect(edited).toBe("const first = 1;\nconst b = 2;\nconst third = 3;");
  });

  it("clamps an edit that runs past the end of the text", () => {
    expect(applyEdits("ab", [{ startLine: 9, startCharacter: 9, endLine: 9, endCharacter: 9, text: "!" }])).toBe("ab!");
  });
});
