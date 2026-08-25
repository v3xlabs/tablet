import { describe, expect, it } from "vitest";

import { padEdit, reduceToEdit } from "../src/format/window-diff";

describe("reduceToEdit", () => {
  it("returns nothing when the window is unchanged", () => {
    expect(reduceToEdit(["a", "b"], ["a", "b"], 10)).toBeUndefined();
  });

  it("narrows a change inside a line to the characters that changed", () => {
    const edit = reduceToEdit(["const c = "], ["const c = a + b;"], 2);

    expect(edit).toEqual({ startLine: 2, startCharacter: 10, endLine: 2, endCharacter: 10, text: "a + b;" });
  });

  it("does not reach back to the start of the line it edits", () => {
    const edit = reduceToEdit(["  displayName: string;"], ["  displayName: number;"], 0);

    expect(edit?.startCharacter).toBeGreaterThan(0);
  });

  it("narrows a one line change to that line", () => {
    const edit = reduceToEdit(["a", "b", "c"], ["a", "B", "c"], 10);

    expect(edit).toEqual({ startLine: 11, startCharacter: 0, endLine: 11, endCharacter: 1, text: "B" });
  });

  it("describes an insertion as an empty range", () => {
    const edit = reduceToEdit(["a", "c"], ["a", "b", "c"], 0);

    expect(edit).toEqual({ startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 0, text: "b\n" });
  });

  it("describes a deletion as empty text", () => {
    const edit = reduceToEdit(["a", "b", "c"], ["a", "c"], 0);

    expect(edit).toEqual({ startLine: 1, startCharacter: 0, endLine: 2, endCharacter: 0, text: "" });
  });
});

describe("padEdit", () => {
  const lines = ["   myLogingFunction();", "const other = 1;"];

  it("leaves an ordinary replacement alone", () => {
    const edit = { startLine: 0, startCharacter: 3, endLine: 0, endCharacter: 8, text: "myLog" };

    expect(padEdit(edit, lines)).toEqual(edit);
  });

  it("turns an insertion into a replacement of the character before it", () => {
    const edit = { startLine: 0, startCharacter: 8, endLine: 0, endCharacter: 8, text: "g" };

    expect(padEdit(edit, lines)).toEqual({ startLine: 0, startCharacter: 7, endLine: 0, endCharacter: 8, text: "gg" });
  });

  it("turns a deletion into a replacement carrying the character before it", () => {
    const edit = { startLine: 1, startCharacter: 15, endLine: 1, endCharacter: 16, text: "" };

    expect(padEdit(edit, lines)).toEqual({ startLine: 1, startCharacter: 14, endLine: 1, endCharacter: 16, text: "1" });
  });

  it("reaches forwards when there is nothing before it", () => {
    const edit = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0, text: "x" };

    expect(padEdit(edit, lines)).toEqual({ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1, text: "x " });
  });

  it("keeps an edit it cannot pad", () => {
    const edit = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0, text: "x" };

    expect(padEdit(edit, [""])).toEqual(edit);
  });

  it("preserves what the edit does", () => {
    const edit = { startLine: 0, startCharacter: 8, endLine: 0, endCharacter: 8, text: "g" };
    const padded = padEdit(edit, lines);
    const line = lines[0] ?? "";
    const applied = line.slice(0, padded.startCharacter) + padded.text + line.slice(padded.endCharacter);

    expect(applied).toBe("   myLoggingFunction();");
  });
});
