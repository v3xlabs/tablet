import { describe, expect, it } from "vitest";

import { addChunk, chunksAround, emptyRing } from "../src/context/ring-buffer";

const chunk = (path: string, lines: string[]) => ({ path, startLine: 0, lines });

describe("addChunk", () => {
  it("holds distinct chunks", () => {
    const ring = [chunk("a.ts", ["one", "two", "three"]), chunk("b.ts", ["four", "five", "six"])]
      .reduce(addChunk, emptyRing(4));

    expect(ring.chunks).toHaveLength(2);
  });

  it("evicts a chunk that nearly repeats the new one", () => {
    const first = chunk("a.ts", ["one", "two", "three", "four"]);
    const second = chunk("a.ts", ["one", "two", "three", "four"]);
    const ring = [first, second].reduce(addChunk, emptyRing(4));

    expect(ring.chunks).toEqual([second]);
  });

  it("ignores a chunk too small to be worth sending", () => {
    expect(addChunk(emptyRing(4), chunk("a.ts", ["one"])).chunks).toEqual([]);
  });

  it("keeps at most the limit", () => {
    const ring = [
      chunk("a.ts", ["a1", "a2", "a3"]),
      chunk("b.ts", ["b1", "b2", "b3"]),
      chunk("c.ts", ["c1", "c2", "c3"]),
    ].reduce(addChunk, emptyRing(2));

    expect(ring.chunks.map(held => held.path)).toEqual(["b.ts", "c.ts"]);
  });
});

describe("chunksAround", () => {
  it("picks material the prompt does not already carry", () => {
    const lines = Array.from({ length: 200 }, (_unused, index) => `line ${index}`);
    const picked = chunksAround("a.ts", lines, 100, 50, 10);

    expect(picked.map(held => held.startLine)).toEqual([50, 150]);
  });
});
