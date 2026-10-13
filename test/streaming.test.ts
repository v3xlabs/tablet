import { describe, expect, it } from "vitest";

import { type EditTarget, finishedNextEdit, readNextEdit } from "../src/format/next-edit";
import { finishedZeta, readZeta } from "../src/format/zeta";

const numbered = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `line ${index}`);

const prefixesOf = (text: string): string[] => Array.from({ length: text.length + 1 }, (_unused, index) => text.slice(0, index));

const editsOf = (reply: { kind: string; edits?: unknown[]; }): unknown[] => reply.edits ?? [];

const targetOf = (lines: string[]): EditTarget => ({ path: "src/a.ts", lines, windowStart: 0, windowEnd: lines.length, cursor: { line: 3, character: 0 }, previousWindow: undefined });

describe("a streamed zeta reply", () => {
  it("shows nothing until a block is closed, then exactly the closed blocks, never a marker", () => {
    const lines = numbered(40);
    const target = targetOf(lines);
    const blockOne = lines.slice(0, 16).map(line => (line === "line 3" ? "line three" : line));
    const blockTwo = lines.slice(16, 32).map(line => (line === "line 20" ? "line twenty" : line));
    const reply = `<|marker_1|>${blockOne.join("\n")}\n<|marker_2|>${blockTwo.join("\n")}\n<|marker_3|>`;
    const whole = editsOf(readZeta(reply, target, ""));
    const closedAt = reply.indexOf("<|marker_2|>") + "<|marker_2|>".length;

    expect(whole).toHaveLength(2);

    for (const prefix of prefixesOf(reply)) {
      const finished = finishedZeta(prefix);
      const partial = finished === undefined ? [] : editsOf(readZeta(finished, target, ""));

      expect(JSON.stringify(partial)).not.toContain("<|");

      if (prefix.length < closedAt) expect(partial).toEqual([]);
      else if (prefix.length < reply.length) expect(partial).toEqual(whole.slice(0, 1));
      else expect(partial).toEqual(whole);
    }
  });
});

describe("a streamed next-edit reply", () => {
  const lines = numbered(12);

  it.each([
    ["a changed line", lines.map(line => (line === "line 3" ? "line three" : line))],
    ["an inserted line", [...lines.slice(0, 4), "inserted", ...lines.slice(4)]],
    ["deleted lines", [...lines.slice(0, 4), ...lines.slice(6)]],
  ])("shows %s only once final, and never a half-written line", (_case, rewritten) => {
    const target = targetOf(lines);
    const reply = `${rewritten.join("\n")}\n`;
    const whole = editsOf(readNextEdit(reply, target, ""));
    const shown = prefixesOf(reply).map((prefix) => {
      const finished = finishedNextEdit(prefix, target);

      return finished === undefined ? [] : editsOf(readNextEdit(finished, target, ""));
    });
    const firstShown = shown.findIndex(partial => partial.length > 0);

    expect(whole).toHaveLength(1);
    expect(firstShown).toBeGreaterThan(-1);
    expect(firstShown).toBeLessThan(reply.length);
    expect(shown.slice(firstShown)).toEqual(shown.slice(firstShown).map(() => whole));
  });
});
