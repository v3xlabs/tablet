export type FilterInput = {
  completion: string;
  lineSuffix: string;
  followingLines: string[];
};

const trimTrailingBlankLines = (lines: string[]): string[] => {
  const kept = [...lines];

  while (kept.length > 0 && (kept[kept.length - 1] ?? "").trim() === "") kept.pop();

  return kept;
};

const firstMeaningful = (lines: string[]): string | undefined => lines.find(line => line.trim() !== "");

/**
 * A model that has run out of new code starts reproducing what is already below the
 * cursor. Cutting at that point is the difference between a two line suggestion and a
 * suggestion that duplicates the rest of the function.
 */
const cutAtExistingCode = (lines: string[], followingLines: string[]): string[] => {
  const next = firstMeaningful(followingLines)?.trim();

  if (next === undefined) return lines;

  const collision = lines.findIndex((line, index) => index > 0 && line.trim() === next);

  return collision === -1 ? lines : lines.slice(0, collision);
};

/**
 * Editors auto-close quotes and brackets, so the line suffix is often a closer the model
 * types again before going on past it; only the text up to that point is new.
 */
const cutAtLineSuffix = (completion: string, lineSuffix: string): string => {
  const closer = lineSuffix.trim();

  if (closer === "") return completion;

  const index = completion.lastIndexOf(closer);

  return index === -1 ? completion : completion.slice(0, index);
};

export const filterCompletion = ({ completion, lineSuffix, followingLines }: FilterInput): string | undefined => {
  const withoutOverlap = cutAtLineSuffix(completion, lineSuffix);

  const lines = cutAtExistingCode(trimTrailingBlankLines(withoutOverlap.split("\n")), followingLines);
  const text = trimTrailingBlankLines(lines).join("\n");

  if (text.trim() === "") return undefined;

  if (text === lineSuffix) return undefined;

  return text;
};
