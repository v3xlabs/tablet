import type { UsagePoint } from "./timing";

export type Frame = { width: number; height: number; };

/** Fixed colors for an SVG shown as an image, where theme variables cannot reach. */
export type Palette = { ink: string; accent: string; };

export type Ceilings = { latencyMs: number; served: number; };

/** Rounds up to 1, 2 or 5 times a power of ten, so an axis label reads as a plain number. */
export const niceCeiling = (value: number): number => {
  if (value <= 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(value));

  return ([1, 2, 5].find(factor => factor * magnitude >= value) ?? 10) * magnitude;
};

export const ceilingsOf = (usage: UsagePoint[]): Ceilings => ({
  latencyMs: niceCeiling(Math.max(0, ...usage.map(point => point.p95 ?? 0))),
  served: niceCeiling(Math.max(0, ...usage.map(point => point.served))),
});

const runsOf = <Held>(columns: Array<Held | undefined>): Held[][] => {
  const runs: Held[][] = [];
  let current: Held[] = [];

  for (const column of columns) {
    if (column !== undefined) {
      current.push(column);
      continue;
    }

    if (current.length > 0) runs.push(current);

    current = [];
  }

  if (current.length > 0) runs.push(current);

  return runs;
};

type Column = { x: string; p50: string; p95: string; };

/**
 * The median as a line over a band reaching up to p95. A quiet minute breaks the line
 * instead of pulling it to zero, and a lone minute still shows as a dot.
 */
export const latencyMarkup = (usage: UsagePoint[], frame: Frame, ceilingMs: number): string => {
  const step = frame.width / usage.length;
  const yOf = (ms: number): string => (frame.height - ms / ceilingMs * frame.height).toFixed(1);
  const columns = usage.map((point, index): Column | undefined => (point.p50 === undefined || point.p95 === undefined
    ? undefined
    : { x: ((index + 0.5) * step).toFixed(1), p50: yOf(point.p50), p95: yOf(point.p95) }));
  const runs = runsOf(columns);
  const bands = runs.map((run) => {
    const upper = run.map(column => `${column.x},${column.p95}`);
    const lower = run.map(column => `${column.x},${column.p50}`).toReversed();

    return `<path class="band" d="M${[...upper, ...lower].join("L")}Z"/>`;
  });
  const lines = runs.map(run =>
    `<path class="line" d="M${run.map(column => `${column.x},${column.p50}`).join("L")}${run.length === 1 ? "h0" : ""}"/>`);

  return [...bands, ...lines].join("");
};

export const barsMarkup = (usage: UsagePoint[], frame: Frame, ceiling: number): string => {
  const step = frame.width / usage.length;
  const width = Math.max(1, step * 0.6);

  return usage.map((point, index) => {
    if (point.served === 0) return "";

    const height = Math.max(1.5, point.served / ceiling * frame.height);
    const x = (index * step + (step - width) / 2).toFixed(1);

    return `<rect class="bar" x="${x}" y="${(frame.height - height).toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}" rx="1"/>`;
  }).join("");
};

const INSET = 3;
const BAR_SHARE = 0.45;

/** Suggestions per minute as bars along the floor, the wait drawn over them on its own scale. */
export const usageSvg = (usage: UsagePoint[], frame: Frame, palette: Palette): string => {
  const ceilings = ceilingsOf(usage);
  const barHeight = Math.round(frame.height * BAR_SHARE);
  const plot = { width: frame.width, height: frame.height - INSET * 2 };
  const style = [
    `.bar{fill:${palette.ink};fill-opacity:.22}`,
    `.band{fill:${palette.accent};fill-opacity:.16}`,
    `.line{fill:none;stroke:${palette.accent};stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}`,
    `.floor{stroke:${palette.ink};stroke-opacity:.3}`,
  ].join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="0 0 ${frame.width} ${frame.height}">`,
    `<style>${style}</style>`,
    `<g transform="translate(0 ${frame.height - barHeight})">${barsMarkup(usage, { width: frame.width, height: barHeight }, ceilings.served)}</g>`,
    `<line class="floor" x1="0" x2="${frame.width}" y1="${frame.height - 0.5}" y2="${frame.height - 0.5}"/>`,
    `<g transform="translate(0 ${INSET})">${latencyMarkup(usage, plot, ceilings.latencyMs)}</g>`,
    "</svg>",
  ].join("");
};
