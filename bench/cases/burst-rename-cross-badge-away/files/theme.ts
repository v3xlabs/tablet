export type Tone = "info" | "warn" | "error";

const COLORS: Record<Tone, string> = {
  info: "#2563eb",
  warn: "#d97706",
  error: "#dc2626",
};

export const toneColor = (tone: Tone): string => COLORS[tone];

export const contrastText = (hex: string): string => {
  const channel = Number.parseInt(hex.slice(1, 3), 16);

  return channel > 127 ? "#111827" : "#f9fafb";
};
