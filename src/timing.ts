type Step = "debounce" | "prepare" | "queue" | "partial" | "response" | "render";

export type Phase = Step | "total";

export type Outcome = "asked" | "carried" | "joined" | "cached" | "reserved" | "quickfix" | "obsolete";

/** One minute of the session: how many suggestions were shown and how long each took. */
export type Minute = {
  startedAt: number;
  served: number;
  totals: number[];
};

export type Timing = {
  limit: number;
  samples: Record<Phase, number[]>;
  counts: Record<Outcome, number>;
  accepted: number;
  minutes: Minute[];
};

export type AskTiming = {
  startedAt: number;
  steps: Partial<Record<Step, number>>;
};

const STEPS: Step[] = ["debounce", "prepare", "queue", "partial", "response", "render"];
const PHASES: Phase[] = [...STEPS, "total"];
const OUTCOMES: Outcome[] = ["asked", "carried", "joined", "cached", "reserved", "quickfix", "obsolete"];

export const MINUTE_MS = 60_000;

const MINUTES_HELD = 60;
const SAMPLES_PER_MINUTE = 120;

export const emptyTiming = (limit: number): Timing => ({
  limit,
  samples: { debounce: [], prepare: [], queue: [], partial: [], response: [], render: [], total: [] },
  counts: { asked: 0, carried: 0, joined: 0, cached: 0, reserved: 0, quickfix: 0, obsolete: 0 },
  accepted: 0,
  minutes: [],
});

const recordPhase = (timing: Timing, phase: Phase, ms: number): void => {
  const held = timing.samples[phase];

  held.push(ms);

  if (held.length > timing.limit) held.shift();
};

const recordMinute = (timing: Timing, at: number, ms: number): void => {
  const startedAt = at - (at % MINUTE_MS);
  const latest = timing.minutes.at(-1);
  const minute = latest?.startedAt === startedAt ? latest : { startedAt, served: 0, totals: [] };

  if (minute !== latest) {
    timing.minutes.push(minute);

    if (timing.minutes.length > MINUTES_HELD) timing.minutes.shift();
  }

  minute.served++;

  if (minute.totals.length < SAMPLES_PER_MINUTE) minute.totals.push(ms);
};

export const startAsk = (): AskTiming => ({ startedAt: Date.now(), steps: {} });

export const finishAsk = (timing: Timing, ask: AskTiming, outcome: Outcome): void => {
  timing.counts[outcome]++;

  if (outcome === "obsolete") return;

  for (const step of STEPS) {
    const ms = ask.steps[step];

    if (ms !== undefined) recordPhase(timing, step, ms);
  }

  const finishedAt = Date.now();
  const totalMs = finishedAt - ask.startedAt;

  recordPhase(timing, "total", totalMs);
  recordMinute(timing, finishedAt, totalMs);
};

/** Nearest-rank: every reported value is one that was measured. */
export const percentile = (values: number[], fraction: number): number | undefined => {
  if (values.length === 0) return undefined;

  const sorted = values.toSorted((left, right) => left - right);

  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
};

export type UsagePoint = {
  startedAt: number;
  served: number;
  p50: number | undefined;
  p95: number | undefined;
};

/** The last `span` minutes up to the one holding `nowMs`, oldest first, with quiet minutes as zero. */
export const usageSeries = (minutes: Minute[], nowMs: number, span: number): UsagePoint[] => {
  const current = nowMs - (nowMs % MINUTE_MS);
  const byStart = new Map(minutes.map(minute => [minute.startedAt, minute]));

  return Array.from({ length: span }, (_, index) => {
    const startedAt = current - (span - 1 - index) * MINUTE_MS;
    const minute = byStart.get(startedAt);
    const totals = minute?.totals ?? [];

    return {
      startedAt,
      served: minute?.served ?? 0,
      p50: percentile(totals, 0.5),
      p95: percentile(totals, 0.95),
    };
  });
};

export const describeTiming = (timing: Timing): string[] => {
  const phases = PHASES.map((phase) => {
    const held = timing.samples[phase];
    const p50 = percentile(held, 0.5);
    const p95 = percentile(held, 0.95);

    return p50 === undefined || p95 === undefined
      ? `${phase}: no samples`
      : `${phase}: p50 ${p50} ms, p95 ${p95} ms over ${held.length}`;
  });
  const total = OUTCOMES.reduce((sum, outcome) => sum + timing.counts[outcome], 0);
  const outcomes = OUTCOMES.map((outcome) => {
    const count = timing.counts[outcome];
    const share = total === 0 ? 0 : Math.round(count / total * 100);

    return `${outcome} ${count} (${share}%)`;
  });

  return [...phases, `outcomes: ${outcomes.join(", ")}`];
};
