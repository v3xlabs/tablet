import { toneColor, contrastText, type Tone } from "./theme";

export type Badge = {
  label: string;
  tone: Tone;
};

export const badgeStyle = (badge: Badge): Record<string, string> => {
  const background = toneColor(badge.tone);

  return {
    background,
    color: contrastText(background),
  };
};
