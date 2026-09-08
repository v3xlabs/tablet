import { describe, expect, it } from "vitest";

import { delayFactor, levelOf, scoreOf, withScore } from "../src/eagerness";

describe("eagerness", () => {
  it("scores accept, ignore, reject, and typing over", () => {
    expect(scoreOf({ kind: "accepted" })).toBe(1);
    expect(scoreOf({ kind: "ignored", userTypingDisagreed: false })).toBe(0.5);
    expect(scoreOf({ kind: "ignored", userTypingDisagreed: true })).toBe(0);
    expect(scoreOf({ kind: "rejected" })).toBe(0);
    expect(scoreOf({ kind: "unresolved" })).toBeUndefined();
  });

  it("keeps the last twenty scores", () => {
    let scores: number[] = [];

    for (let index = 0; index < 25; index++) scores = withScore(scores, 1);

    expect(scores).toHaveLength(20);
  });

  it("stays in the middle until five outcomes exist, then follows the mean", () => {
    expect(levelOf([1, 1, 1, 1], "auto")).toBe("medium");
    expect(levelOf([1, 1, 1, 1, 1], "auto")).toBe("high");
    expect(levelOf([0, 0, 0.5, 0, 0], "auto")).toBe("low");
    expect(levelOf([1, 0, 1, 0, 0.5], "auto")).toBe("medium");
  });

  it("obeys a fixed setting", () => {
    expect(levelOf([1, 1, 1, 1, 1], "low")).toBe("low");
    expect(delayFactor("low")).toBe(3);
    expect(delayFactor("high")).toBe(0.5);
  });
});
