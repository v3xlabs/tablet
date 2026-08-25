import type { RecentEdit } from "../context/recent-edits";
import type { Suggestion } from "../suggest";
import type { EditTarget } from "./next-edit";

const WORD = /[A-Za-z_$][\w$]*/g;

const wordsOf = (line: string): string[] => line.match(WORD) ?? [];

/**
 * The one token a line swapped, or nothing. Two lines that differ by an inserted word, a
 * deleted word, or more than one substitution are not this shape, and reading them as one
 * is how a spread rewrites something the reader never touched.
 */
const substitutionIn = (before: string, after: string): [string, string] | undefined => {
  const left = wordsOf(before);
  const right = wordsOf(after);

  if (left.length !== right.length) return undefined;

  const differing = left.flatMap((word, index) => (word === right[index] ? [] : [index]));
  const only = differing[0];

  if (only === undefined || differing.length !== 1) return undefined;

  const from = left[only];
  const to = right[only];

  return from === undefined || to === undefined ? undefined : [from, to];
};

/**
 * A change is read line for line, so a rename is seen the same way whether it landed in a
 * declaration or in one call site. Word set arithmetic misses the common case: renaming
 * one of four fields from i32 to i64 leaves i32 in the text on both sides, so nothing
 * looks removed at all.
 */
const substitutionsIn = (change: RecentEdit): Array<[string, string]> => {
  const before = change.before.split("\n");
  const after = change.after.split("\n");

  if (before.length !== after.length) return [];

  return before.flatMap((line, index) => {
    const counterpart = after[index];

    if (counterpart === undefined || counterpart === line) return [];

    const substitution = substitutionIn(line, counterpart);

    return substitution === undefined ? [] : [substitution];
  });
};

const APPLIED_ENOUGH_TO_SPREAD = 2;

/**
 * One swap is a decision about one line. The same swap twice is a job half done, and the
 * rest of the job is what this offers. The threshold is the whole guard against turning a
 * deliberate one-off into a file-wide rewrite.
 */
const repeatedSubstitutions = (changes: RecentEdit[]): Map<string, string> => {
  const counts = new Map<string, number>();
  const pairs = new Map<string, [string, string]>();

  for (const change of changes) {
    for (const [from, to] of substitutionsIn(change)) {
      const key = `${from} ${to}`;

      counts.set(key, (counts.get(key) ?? 0) + 1);
      pairs.set(key, [from, to]);
    }
  }

  const spreading = new Map<string, string>();

  for (const [key, count] of counts) {
    const pair = pairs.get(key);

    if (pair !== undefined && count >= APPLIED_ENOUGH_TO_SPREAD) spreading.set(pair[0], pair[1]);
  }

  return spreading;
};

// an identifier can hold only one character a pattern would otherwise read as syntax
const escaped = (word: string): string => word.replaceAll("$", String.raw`\$`);

const occurrencesOf = (line: string, word: string): number[] => {
  const pattern = new RegExp(String.raw`(?<![\w$])${escaped(word)}(?![\w$])`, "g");

  return Array.from(line.matchAll(pattern), match => match.index);
};

/**
 * A half applied rename leaves its remaining sites wherever they happen to be, which is
 * usually not inside the window: the burst cases put the second stale call twenty lines
 * past the cursor. The whole file is searched for that reason, and the editor carries the
 * reader to the edit the way it carries them to any other next edit.
 */
export const renameSpreadFor = (target: EditTarget, changes: RecentEdit[]): Suggestion[] => {
  const spreading = repeatedSubstitutions(changes);

  if (spreading.size === 0) return [];

  const edits: Suggestion[] = [];

  for (const [index, line] of target.lines.entries()) {
    for (const [from, to] of spreading) {
      for (const at of occurrencesOf(line, from)) {
        edits.push({
          kind: "edit",
          path: target.path,
          startLine: index,
          startCharacter: at,
          endLine: index,
          endCharacter: at + from.length,
          text: to,
        });
      }
    }
  }

  return edits;
};
