export const DAY_MS = 86_400_000;

export const daysBetween = (fromIso: string, toIso: string): number => {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();

  return Math.round((to - from) / DAY_MS);
};

export const addDays = (iso: string, days: number): string => {
  const shifted = new Date(new Date(iso).getTime() + days * DAY_MS);

  return shifted.toISOString();
};

export const isOverdue = (dueIso: string, nowIso: string): boolean =>
  daysBetween(dueIso, nowIso) > 0;

export const startOfDay = (iso: string): string => {
  const date = new Date(iso);

  date.setUTCHours(0, 0, 0, 0);

  return date.toISOString();
};
