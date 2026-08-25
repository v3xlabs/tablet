import { colorFor, contrastText, type Tone } from "./theme";

export type Badge = {
  label: string;
  tone: Tone;
};

export const badgeStyle = (badge: Badge): Record<string, string> => {
  const background = colorFor(badge.tone);

  return {
    background,
    color: contrastText(background),
  };
};
