export type Sample = {
  label: string;
  value: number;
  at: number;
};

export type Series = {
  samples: Sample[];
  capacity: number;
};

export const emptySeries = (capacity: number): Series => ({
  samples: [],
  capacity,
});

export const record = (series: Series, sample: Sample): Series => {
  const samples = [...series.samples, sample];
  const overflow = samples.length - series.capacity;
  return {
    ...series,
    samples: overflow > 0 ? samples.slice(overflow) : samples,     
  };
};

export const latest = (series: Series): Sample | undefined =>
  series.samples[series.samples.length - 1];

export const meanOf = (series: Series): number => {
  if (series.samples.length === 0) return 0;
  let total = 0;
  for (const sample of series.samples) {
    total += sample.value;
  }
  return total / series.samples.length;
};

export const spanOf = (series: Series): number => {
  const first = series.samples[0];
  const last = latest(series);
  if (first === undefined || last === undefined) return 0;
  return last.at - first.at;
};

export const labelled = (series: Series, label: string): Sample[] => {
  const found: Sample[] = [];
  for (const sample of series.samples) {
    if (sample.label === label) {
      found.push(sample);
    }
  }
  return found;
};

export const rateOf = (series: Series): number => {
  const span = spanOf(series);
  if (span <= 0) return 0;
  return series.samples.length / span;
};

export const merge = (left: Series, right: Series): Series => {
  const samples = [...left.samples, ...right.samples].toSorted(
    (a, b) => a.at - b.at,
  );
  const capacity = Math.max(left.capacity, right.capacity);
  const overflow = samples.length - capacity;
  return {
    samples: overflow > 0 ? samples.slice(overflow) : samples,
    capacity,
  };
};
