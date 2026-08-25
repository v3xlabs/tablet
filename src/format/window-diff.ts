export type WindowEdit = {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  text: string;
};

const commonPrefix = (before: string, after: string): number => {
  const limit = Math.min(before.length, after.length);
  let count = 0;

  while (count < limit && before[count] === after[count]) count++;

  return count;
};

const commonSuffix = (before: string, after: string, floor: number): number => {
  const limit = Math.min(before.length, after.length) - floor;
  let count = 0;

  while (count < limit && before[before.length - 1 - count] === after[after.length - 1 - count]) count++;

  return count;
};

const positionAt = (text: string, offset: number): { line: number; character: number; } => {
  const upto = text.slice(0, offset);
  const lastBreak = upto.lastIndexOf("\n");

  return { line: upto.split("\n").length - 1, character: offset - (lastBreak + 1) };
};

/**
 * Narrowing by character rather than by line is what keeps an edit inside a line from
 * replacing the whole line. A line wide edit reads in the editor as a jump to column zero,
 * even when the only new text sits after what the user has already typed.
 *
 * `windowStart` is the document line the window's first line sits on.
 */
export const reduceToEdit = (before: string[], after: string[], windowStart: number): WindowEdit | undefined => {
  const beforeText = before.join("\n");
  const afterText = after.join("\n");

  if (beforeText === afterText) return undefined;

  const prefix = commonPrefix(beforeText, afterText);
  const suffix = commonSuffix(beforeText, afterText, prefix);

  const start = positionAt(beforeText, prefix);
  const end = positionAt(beforeText, beforeText.length - suffix);

  return {
    startLine: windowStart + start.line,
    startCharacter: start.character,
    endLine: windowStart + end.line,
    endCharacter: end.character,
    text: afterText.slice(prefix, afterText.length - suffix),
  };
};

type LineHunk = {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
};

const uniqueLineIndex = (lines: string[], from: number, upto: number): Map<string, number> => {
  const seen = new Map<string, number>();
  const repeated = new Set<string>();

  for (let index = from; index < upto; index++) {
    const line = lines[index] ?? "";

    if (seen.has(line)) repeated.add(line);
    else seen.set(line, index);
  }

  for (const line of repeated) seen.delete(line);

  return seen;
};

type Anchor = { before: number; after: number; };

/** The longest subset of anchors that stays in order on both sides, so no anchor pair crosses another. */
const longestInOrder = (anchors: Anchor[]): Anchor[] => {
  const bestUpto: number[] = anchors.map(() => 1);
  const cameFrom: number[] = anchors.map(() => -1);

  for (let index = 0; index < anchors.length; index++) {
    for (let earlier = 0; earlier < index; earlier++) {
      const isImprovement = (anchors[earlier]?.after ?? 0) < (anchors[index]?.after ?? 0)
        && (bestUpto[earlier] ?? 0) + 1 > (bestUpto[index] ?? 0);

      if (isImprovement) {
        bestUpto[index] = (bestUpto[earlier] ?? 0) + 1;
        cameFrom[index] = earlier;
      }
    }
  }

  let end = 0;

  for (let index = 1; index < anchors.length; index++) {
    if ((bestUpto[index] ?? 0) > (bestUpto[end] ?? 0)) end = index;
  }

  const picked: Anchor[] = [];

  for (let index = end; index >= 0 && anchors.length > 0; index = cameFrom[index] ?? -1) {
    const anchor = anchors[index];

    if (anchor !== undefined) picked.unshift(anchor);
  }

  return picked;
};

const collectHunks = (
  before: string[],
  after: string[],
  beforeFrom: number,
  beforeUpto: number,
  afterFrom: number,
  afterUpto: number,
  found: LineHunk[],
): void => {
  while (beforeFrom < beforeUpto && afterFrom < afterUpto && before[beforeFrom] === after[afterFrom]) {
    beforeFrom++;
    afterFrom++;
  }

  while (beforeUpto > beforeFrom && afterUpto > afterFrom && before[beforeUpto - 1] === after[afterUpto - 1]) {
    beforeUpto--;
    afterUpto--;
  }

  if (beforeFrom === beforeUpto && afterFrom === afterUpto) return;

  const uniqueBefore = uniqueLineIndex(before, beforeFrom, beforeUpto);
  const uniqueAfter = uniqueLineIndex(after, afterFrom, afterUpto);

  const shared = [...uniqueBefore]
    .flatMap(([line, index]) => {
      const other = uniqueAfter.get(line);

      return other === undefined ? [] : [{ before: index, after: other }];
    })
    .toSorted((left, right) => left.before - right.before);

  const anchors = longestInOrder(shared);

  if (anchors.length === 0) {
    found.push({ beforeStart: beforeFrom, beforeEnd: beforeUpto, afterStart: afterFrom, afterEnd: afterUpto });

    return;
  }

  let previousBefore = beforeFrom;
  let previousAfter = afterFrom;

  for (const anchor of anchors) {
    collectHunks(before, after, previousBefore, anchor.before, previousAfter, anchor.after, found);
    previousBefore = anchor.before + 1;
    previousAfter = anchor.after + 1;
  }

  collectHunks(before, after, previousBefore, beforeUpto, previousAfter, afterUpto, found);
};

const editFromHunk = (before: string[], after: string[], hunk: LineHunk, windowStart: number): WindowEdit | undefined => {
  const beforeSlice = before.slice(hunk.beforeStart, hunk.beforeEnd);
  const afterSlice = after.slice(hunk.afterStart, hunk.afterEnd);

  if (beforeSlice.length > 0 && afterSlice.length > 0) {
    return reduceToEdit(beforeSlice, afterSlice, windowStart + hunk.beforeStart);
  }

  if (afterSlice.length === 0) {
    if (hunk.beforeEnd < before.length) {
      return { startLine: windowStart + hunk.beforeStart, startCharacter: 0, endLine: windowStart + hunk.beforeEnd, endCharacter: 0, text: "" };
    }

    // deleting the window's last lines has no following line to end on, so the deletion
    // eats the newline in front of it instead
    const previous = before[hunk.beforeStart - 1];

    if (previous === undefined) return reduceToEdit(before, after, windowStart);

    return {
      startLine: windowStart + hunk.beforeStart - 1,
      startCharacter: previous.length,
      endLine: windowStart + hunk.beforeEnd - 1,
      endCharacter: (before[hunk.beforeEnd - 1] ?? "").length,
      text: "",
    };
  }

  if (hunk.beforeStart < before.length) {
    return {
      startLine: windowStart + hunk.beforeStart,
      startCharacter: 0,
      endLine: windowStart + hunk.beforeStart,
      endCharacter: 0,
      text: afterSlice.map(line => `${line}\n`).join(""),
    };
  }

  const last = before[before.length - 1] ?? "";

  return {
    startLine: windowStart + before.length - 1,
    startCharacter: last.length,
    endLine: windowStart + before.length - 1,
    endCharacter: last.length,
    text: afterSlice.map(line => `\n${line}`).join(""),
  };
};

/**
 * One reply often carries several unrelated corrections, and as a single edit they arrive
 * as one block replacement mixing a fix with whatever else the model touched. Split at
 * lines that are unique to and shared by both sides, each contiguous run of changed lines
 * becomes an edit of its own, and the caller can rank and offer them separately.
 */
export const splitIntoEdits = (before: string[], after: string[], windowStart: number): WindowEdit[] => {
  const hunks: LineHunk[] = [];

  collectHunks(before, after, 0, before.length, 0, after.length, hunks);

  return hunks
    .map(hunk => editFromHunk(before, after, hunk, windowStart))
    .filter((edit): edit is WindowEdit => edit !== undefined);
};

/**
 * The editor draws an inline edit as a replacement of one piece of text by another. A zero
 * width range, which is what a pure insertion reduces to, and an empty replacement, which
 * is what a pure deletion reduces to, leave it nothing to draw against. Pulling one
 * neighbouring character into both sides makes every edit an ordinary replacement without
 * changing what it does.
 */
export const padEdit = (edit: WindowEdit, lines: string[]): WindowEdit => {
  const isEmptyRange = edit.startLine === edit.endLine && edit.startCharacter === edit.endCharacter;

  if (!isEmptyRange && edit.text !== "") return edit;

  const startLine = lines[edit.startLine];

  if (startLine !== undefined && edit.startCharacter > 0) {
    const before = startLine.slice(edit.startCharacter - 1, edit.startCharacter);

    return { ...edit, startCharacter: edit.startCharacter - 1, text: `${before}${edit.text}` };
  }

  const endLine = lines[edit.endLine];

  if (endLine !== undefined && edit.endCharacter < endLine.length) {
    const after = endLine.slice(edit.endCharacter, edit.endCharacter + 1);

    return { ...edit, endCharacter: edit.endCharacter + 1, text: `${edit.text}${after}` };
  }

  return edit;
};
