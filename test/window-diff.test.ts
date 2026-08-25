import { describe, expect, it } from "vitest";

import { reduceToEdit } from "../src/format/window-diff";

describe("reduceToEdit", () => {
  it("returns nothing when the window is unchanged", () => {
    expect(reduceToEdit(["a", "b"], ["a", "b"], 10)).toBeUndefined();
  });

  it("narrows a one line change to that line", () => {
    const edit = reduceToEdit(["a", "b", "c"], ["a", "B", "c"], 10);

    expect(edit).toEqual({ startLine: 11, endLine: 12, text: "B" });
  });

  it("describes an insertion as an empty range", () => {
    const edit = reduceToEdit(["a", "c"], ["a", "b", "c"], 0);

    expect(edit).toEqual({ startLine: 1, endLine: 1, text: "b" });
  });

  it("describes a deletion as empty text", () => {
    const edit = reduceToEdit(["a", "b", "c"], ["a", "c"], 0);

    expect(edit).toEqual({ startLine: 1, endLine: 2, text: "" });
  });
});
