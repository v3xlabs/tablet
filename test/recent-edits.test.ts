import { describe, expect, it } from "vitest";

import { blocksFromChange, emptyEditLog, emptyTracker, isSameBurst, recordEdit, trackChange } from "../src/context/recent-edits";

describe("isSameBurst", () => {
  const log = recordEdit(emptyEditLog(8), { path: "a.ts", line: 0, before: "const a = 1;", after: "const ab = 1;" });

  it("is true when the change picks up where the last one stopped", () => {
    expect(isSameBurst(log, { path: "a.ts", line: 0, before: "const ab = 1;", after: "const abc = 1;" })).toBe(true);
  });

  it("is false for a fresh burst", () => {
    expect(isSameBurst(log, { path: "a.ts", line: 0, before: "const x = 2;", after: "const y = 2;" })).toBe(false);
  });

  it("is false in another file", () => {
    expect(isSameBurst(log, { path: "b.ts", line: 0, before: "const ab = 1;", after: "const abc = 1;" })).toBe(false);
  });

  it("is false on an empty log", () => {
    expect(isSameBurst(emptyEditLog(8), { path: "a.ts", line: 0, before: "x", after: "y" })).toBe(false);
  });
});

describe("recordEdit", () => {
  it("coalesces a change that continues the previous one", () => {
    const log = [
      { path: "a.ts", line: 0, before: "name", after: "names" },
      { path: "a.ts", line: 0, before: "names", after: "namespace" },
    ].reduce(recordEdit, emptyEditLog(4));

    expect(log.edits).toEqual([{ path: "a.ts", line: 0, before: "name", after: "namespace" }]);
  });

  it("keeps changes in different files apart", () => {
    const log = [
      { path: "a.ts", line: 0, before: "one", after: "two" },
      { path: "b.ts", line: 0, before: "two", after: "three" },
    ].reduce(recordEdit, emptyEditLog(4));

    expect(log.edits).toHaveLength(2);
  });

  it("ignores a change that changed nothing", () => {
    expect(recordEdit(emptyEditLog(4), { path: "a.ts", line: 0, before: "x", after: "x" }).edits).toEqual([]);
  });

  it("drops an edit that coalesced back to where it started", () => {
    const log = [
      { path: "a.ts", line: 0, before: "name", after: "namex" },
      { path: "a.ts", line: 0, before: "namex", after: "name" },
    ].reduce(recordEdit, emptyEditLog(4));

    expect(log.edits).toEqual([]);
  });

  it("keeps at most the limit", () => {
    const log = [
      { path: "a.ts", line: 0, before: "1", after: "2" },
      { path: "b.ts", line: 0, before: "3", after: "4" },
      { path: "c.ts", line: 0, before: "5", after: "6" },
    ].reduce(recordEdit, emptyEditLog(2));

    expect(log.edits.map(edit => edit.path)).toEqual(["b.ts", "c.ts"]);
  });
});

describe("blocksFromChange", () => {
  it("recovers what was replaced and what replaced it", () => {
    const before = ["a", "b", "old", "d", "e"];
    const after = ["a", "b", "new", "d", "e"];

    expect(blocksFromChange(before, after, 1)).toEqual({ line: 1, before: "b\nold\nd", after: "b\nnew\nd" });
  });

  it("returns nothing when the text is the same", () => {
    expect(blocksFromChange(["a"], ["a"], 1)).toBeUndefined();
  });
});

describe("trackChange", () => {
  it("records nothing the first time a document is seen", () => {
    const tracker = emptyTracker(8);

    expect(trackChange(tracker, "k", "a.ts", "const a = 1;")).toBeUndefined();
    expect(tracker.log.edits).toEqual([]);
  });

  it("pins the pre-burst text per file while a burst continues", () => {
    const tracker = emptyTracker(8);

    trackChange(tracker, "k", "a.ts", "const total = 1;");
    trackChange(tracker, "k", "a.ts", "const tota = 1;");
    trackChange(tracker, "k", "a.ts", "const tot = 1;");

    expect(tracker.previousByPath.get("a.ts")).toEqual(["const total = 1;"]);
    expect(tracker.log.edits).toHaveLength(1);
  });

  it("re-pins after a fresh burst starts", () => {
    const tracker = emptyTracker(8);

    trackChange(tracker, "k", "a.ts", "one\ntwo\nthree\nfour\nfive");
    trackChange(tracker, "k", "a.ts", "one\ntwo\nthree\nfour\nFIVE");
    trackChange(tracker, "k", "a.ts", "ONE\ntwo\nthree\nfour\nFIVE");

    expect(tracker.previousByPath.get("a.ts")).toEqual(["one", "two", "three", "four", "FIVE"]);
  });

  it("keeps the pre-burst text of one file when another is edited", () => {
    const tracker = emptyTracker(8);

    trackChange(tracker, "a", "a.ts", "before a");
    trackChange(tracker, "a", "a.ts", "after a");
    trackChange(tracker, "b", "b.ts", "before b");
    trackChange(tracker, "b", "b.ts", "after b");

    expect(tracker.previousByPath.get("a.ts")).toEqual(["before a"]);
    expect(tracker.previousByPath.get("b.ts")).toEqual(["before b"]);
  });

  it("returns nothing when nothing changed", () => {
    const tracker = emptyTracker(8);

    trackChange(tracker, "k", "a.ts", "same");

    expect(trackChange(tracker, "k", "a.ts", "same")).toBeUndefined();
  });
});
