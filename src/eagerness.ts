import type { Outcome } from "./collect/record";

export type Eagerness = "low" | "medium" | "high";

export type EagernessSetting = Eagerness | "auto";

export const EAGERNESS_SETTINGS: EagernessSetting[] = ["auto", "low", "medium", "high"];

const RECENT = 20;
const HIGH_FROM = 0.7;
const MEDIUM_FROM = 0.4;

/** Accept 1, ignore 0.5, reject 0, and typing over a suggestion counts as a reject. */
export const scoreOf = (outcome: Outcome): number | undefined => {
  switch (outcome.kind) {
    case "accepted": {
      return 1;
    }
    case "rejected": {
      return 0;
    }
    case "ignored": {
      return outcome.userTypingDisagreed ? 0 : 0.5;
    }
    case "unresolved": {
      return undefined;
    }
  }
};

export const withScore = (scores: number[], score: number): number[] => [...scores, score].slice(-RECENT);

/**
 * How often recent suggestions were taken decides how soon the next one is asked for.
 * The thresholds are copilot's: over 0.7 is a reader who wants more, under 0.4 one who
 * wants fewer. With nothing scored yet the middle applies.
 */
export const levelOf = (scores: number[], setting: EagernessSetting): Eagerness => {
  if (setting !== "auto") return setting;

  if (scores.length < 5) return "medium";

  const mean = scores.reduce((sum, held) => sum + held, 0) / scores.length;

  if (mean >= HIGH_FROM) return "high";

  return mean >= MEDIUM_FROM ? "medium" : "low";
};

/** Multiplier on the configured debounce and idle delays. */
export const delayFactor = (level: Eagerness): number => {
  switch (level) {
    case "high": {
      return 0.5;
    }
    case "medium": {
      return 1;
    }
    case "low": {
      return 3;
    }
  }
};
