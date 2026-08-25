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

export const filterCompletion = ({ completion, lineSuffix, followingLines }: FilterInput): string | undefined => {
  const withoutOverlap = lineSuffix !== "" && completion.endsWith(lineSuffix)
    ? completion.slice(0, completion.length - lineSuffix.length)
    : completion;

  const lines = cutAtExistingCode(trimTrailingBlankLines(withoutOverlap.split("\n")), followingLines);
  const text = trimTrailingBlankLines(lines).join("\n");

  if (text.trim() === "") return undefined;

  if (text === lineSuffix) return undefined;

  return text;
};
