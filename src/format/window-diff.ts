export type WindowEdit = {
  startLine: number;
  endLine: number;
  text: string;
};

const countCommonPrefix = (before: string[], after: string[]): number => {
  const limit = Math.min(before.length, after.length);
  let count = 0;

  while (count < limit && before[count] === after[count]) count++;

  return count;
};

const countCommonSuffix = (before: string[], after: string[], skip: number): number => {
  const limit = Math.min(before.length, after.length) - skip;
  let count = 0;

  while (count < limit && before[before.length - 1 - count] === after[after.length - 1 - count]) count++;

  return count;
};

/** `windowStart` is the document line the window's first line sits on. */
export const reduceToEdit = (before: string[], after: string[], windowStart: number): WindowEdit | undefined => {
  const prefix = countCommonPrefix(before, after);

  if (prefix === before.length && prefix === after.length) return undefined;

  const suffix = countCommonSuffix(before, after, prefix);

  return {
    startLine: windowStart + prefix,
    endLine: windowStart + before.length - suffix,
    text: after.slice(prefix, after.length - suffix).join("\n"),
  };
};
