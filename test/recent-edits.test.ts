import { describe, expect, it } from "vitest";

import { blocksFromChange, emptyEditLog, recordEdit } from "../src/context/recent-edits";

describe("recordEdit", () => {
  it("coalesces a change that continues the previous one", () => {
    const log = [
      { path: "a.ts", before: "name", after: "names" },
      { path: "a.ts", before: "names", after: "namespace" },
    ].reduce(recordEdit, emptyEditLog(4));

    expect(log.edits).toEqual([{ path: "a.ts", before: "name", after: "namespace" }]);
  });

  it("keeps changes in different files apart", () => {
    const log = [
      { path: "a.ts", before: "one", after: "two" },
      { path: "b.ts", before: "two", after: "three" },
    ].reduce(recordEdit, emptyEditLog(4));

    expect(log.edits).toHaveLength(2);
  });

  it("ignores a change that changed nothing", () => {
    expect(recordEdit(emptyEditLog(4), { path: "a.ts", before: "x", after: "x" }).edits).toEqual([]);
  });

  it("drops an edit that coalesced back to where it started", () => {
    const log = [
      { path: "a.ts", before: "name", after: "namex" },
      { path: "a.ts", before: "namex", after: "name" },
    ].reduce(recordEdit, emptyEditLog(4));

    expect(log.edits).toEqual([]);
  });

  it("keeps at most the limit", () => {
    const log = [
      { path: "a.ts", before: "1", after: "2" },
      { path: "b.ts", before: "3", after: "4" },
      { path: "c.ts", before: "5", after: "6" },
    ].reduce(recordEdit, emptyEditLog(2));

    expect(log.edits.map(edit => edit.path)).toEqual(["b.ts", "c.ts"]);
  });
});

describe("blocksFromChange", () => {
  it("recovers what was replaced and what replaced it", () => {
    const before = ["a", "b", "old", "d", "e"];
    const after = ["a", "b", "new", "d", "e"];

    expect(blocksFromChange(before, after, 1)).toEqual({ before: "b\nold\nd", after: "b\nnew\nd" });
  });

  it("returns nothing when the text is the same", () => {
    expect(blocksFromChange(["a"], ["a"], 1)).toBeUndefined();
  });
});
