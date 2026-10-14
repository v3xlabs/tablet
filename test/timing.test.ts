import { afterEach, describe, expect, it, vi } from "vitest";

import { emptyTiming, finishAsk, MINUTE_MS, type Outcome, percentile, startAsk, usageSeries } from "../src/timing";

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

describe("usage series", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("buckets shown suggestions by the minute they finished in, with quiet minutes empty", () => {
    vi.useFakeTimers();

    const timing = emptyTiming(200);
    const finish = (askedAt: number, finishedAt: number, outcome: Outcome = "asked"): void => {
      vi.setSystemTime(askedAt);

      const ask = startAsk();

      vi.setSystemTime(finishedAt);
      finishAsk(timing, ask, outcome);
    };
    const start = 10 * MINUTE_MS;

    finish(start - 400, start + 100);
    finish(start + 1000, start + 1300);
    finish(start + 2000, start + 2200);
    finish(start + 3000, start + 3500, "obsolete");
    finish(start + 2 * MINUTE_MS, start + 2 * MINUTE_MS + 50, "carried");

    expect(usageSeries(timing.minutes, start + 2 * MINUTE_MS + 30_000, 4)).toEqual([
      { startedAt: start - MINUTE_MS, served: 0, p50: undefined, p95: undefined },
      { startedAt: start, served: 3, p50: 300, p95: 500 },
      { startedAt: start + MINUTE_MS, served: 0, p50: undefined, p95: undefined },
      { startedAt: start + 2 * MINUTE_MS, served: 1, p50: 50, p95: 50 },
    ]);
  });
});
