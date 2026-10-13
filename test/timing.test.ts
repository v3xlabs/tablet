import { describe, expect, it } from "vitest";

import { percentile } from "../src/timing";

describe("percentile", () => {
  it.each([
    [[40, 10, 30, 20, 100], 0.5, 30],
    [[40, 10, 30, 20, 100], 0.95, 100],
    [[40, 10, 30, 20], 0.5, 20],
    [[7], 0.95, 7],
    [[], 0.5, undefined],
  ])("of %j at %d is the measured value %j", (values, fraction, expected) => {
    expect(percentile(values, fraction)).toBe(expected);
  });
});
