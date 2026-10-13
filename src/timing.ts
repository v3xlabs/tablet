type Step = "debounce" | "prepare" | "queue" | "partial" | "response" | "render";

export type Phase = Step | "total";

export type Outcome = "asked" | "carried" | "joined" | "cached" | "reserved" | "quickfix" | "obsolete";

export type Timing = {
  limit: number;
  samples: Record<Phase, number[]>;
  counts: Record<Outcome, number>;
};

export type AskTiming = {
  startedAt: number;
  steps: Partial<Record<Step, number>>;
};

const STEPS: Step[] = ["debounce", "prepare", "queue", "partial", "response", "render"];
const PHASES: Phase[] = [...STEPS, "total"];
const OUTCOMES: Outcome[] = ["asked", "carried", "joined", "cached", "reserved", "quickfix", "obsolete"];

export const emptyTiming = (limit: number): Timing => ({
  limit,
  samples: { debounce: [], prepare: [], queue: [], partial: [], response: [], render: [], total: [] },
  counts: { asked: 0, carried: 0, joined: 0, cached: 0, reserved: 0, quickfix: 0, obsolete: 0 },
});

const recordPhase = (timing: Timing, phase: Phase, ms: number): void => {
  const held = timing.samples[phase];

  held.push(ms);

  if (held.length > timing.limit) held.shift();
};

export const startAsk = (): AskTiming => ({ startedAt: Date.now(), steps: {} });

export const finishAsk = (timing: Timing, ask: AskTiming, outcome: Outcome): void => {
  timing.counts[outcome]++;

  if (outcome === "obsolete") return;

  for (const step of STEPS) {
    const ms = ask.steps[step];

    if (ms !== undefined) recordPhase(timing, step, ms);
  }

  recordPhase(timing, "total", Date.now() - ask.startedAt);
};

/** Nearest-rank: every reported value is one that was measured. */
export const percentile = (values: number[], fraction: number): number | undefined => {
  if (values.length === 0) return undefined;

  const sorted = values.toSorted((left, right) => left - right);

  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
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
