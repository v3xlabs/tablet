import type { Suggestion, SuggestResult } from "./suggest";

type Change = { start: number; end: number; text: string; };

type Rebased
  = | { kind: "typed"; change: Change; }
    | { kind: "moved"; change: Change; }
    | { kind: "done"; }
    | { kind: "conflict"; };

/** The reader's edits between two texts, as the one span that differs. */
const changeBetween = (before: string, after: string): Change => {
  const limit = Math.min(before.length, after.length);
  let prefix = 0;

  while (prefix < limit && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;

  while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;

  return { start: prefix, end: before.length - suffix, text: after.slice(prefix, after.length - suffix) };
};

/**
 * Where a model edit stands after the reader's own edit, the way zed carries a prediction
 * across typing: an edit the reader did not reach moves with the text around it, typing
 * the start of what the edit inserts leaves the rest of it, and any other contact means
 * the edit no longer describes the text.
 */
const rebaseChange = (model: Change, user: Change): Rebased => {
  const isSameRange = user.start === model.start && user.end === model.end;

  if (isSameRange && model.text.startsWith(user.text)) {
    const at = model.start + user.text.length;
    const rest = model.text.slice(user.text.length);

    return rest === "" ? { kind: "done" } : { kind: "typed", change: { start: at, end: at, text: rest } };
  }

  // a change that only touches the edit's range still alters the word the edit rewrites
  if (user.end < model.start) {
    const shift = user.text.length - (user.end - user.start);

    return { kind: "moved", change: { start: model.start + shift, end: model.end + shift, text: model.text } };
  }

  if (user.start > model.end) return { kind: "moved", change: model };

  return { kind: "conflict" };
};

const lineStarts = (text: string): number[] => {
  const starts = [0];

  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);

  return starts;
};

const offsetOf = (starts: number[], line: number, character: number): number => (starts[line] ?? 0) + character;

const positionOf = (starts: number[], offset: number): { line: number; character: number; } => {
  let line = 0;

  while (line + 1 < starts.length && (starts[line + 1] ?? Infinity) <= offset) line++;

  return { line, character: offset - (starts[line] ?? 0) };
};

export type Carried = {
  suggestions: Suggestion[];
  /** The reader's edit was one of the suggestions, or the start of one. */
  isAgreed: boolean;
};

/**
 * Carries suggestions made for one text of a file over to a later text of the same file.
 * An edit in another file is untouched by typing here and stays as it was. A completion
 * is carried only when its start was typed at `anchor`, an offset into `before`. A
 * formatter offer is worked out again from the text it would format, so it is never carried.
 */
export const rebaseSuggestions = (suggestions: Suggestion[], path: string, before: string, after: string, anchor?: number): Carried => {
  const beforeText = before.replaceAll("\r\n", "\n");
  const afterText = after.replaceAll("\r\n", "\n");

  // unchanged text (an undo, a cursor rest): its edits still hold, its completions do not
  if (beforeText === afterText) return { suggestions: suggestions.filter(suggestion => suggestion.kind === "edit"), isAgreed: true };

  const user = changeBetween(beforeText, afterText);
  const beforeStarts = lineStarts(beforeText);
  const afterStarts = lineStarts(afterText);
  const rebased: Suggestion[] = [];
  let isAgreed = false;

  for (const suggestion of suggestions) {
    if (suggestion.kind === "completion") {
      const isTypedAtAnchor = user.start === anchor && user.end === anchor && user.text !== "";

      if (isTypedAtAnchor && suggestion.text.startsWith(user.text) && suggestion.text !== user.text) {
        rebased.push({ kind: "completion", text: suggestion.text.slice(user.text.length) });
        isAgreed = true;
      }

      continue;
    }

    if (suggestion.kind !== "edit") continue;

    if (suggestion.path !== path) {
      rebased.push(suggestion);

      continue;
    }

    const model = {
      start: offsetOf(beforeStarts, suggestion.startLine, suggestion.startCharacter),
      end: offsetOf(beforeStarts, suggestion.endLine, suggestion.endCharacter),
      text: suggestion.text,
    };

    // an accepted edit may reach the text by a wider range than the edit itself, so the
    // result is compared rather than the ranges
    const isApplied = beforeText.slice(0, model.start) + model.text + beforeText.slice(model.end) === afterText;
    const moved: Rebased = isApplied ? { kind: "done" } : rebaseChange(model, user);

    if (moved.kind === "done" || moved.kind === "typed") isAgreed = true;

    if (moved.kind === "done" || moved.kind === "conflict") continue;

    const start = positionOf(afterStarts, moved.change.start);
    const end = positionOf(afterStarts, moved.change.end);

    rebased.push({
      kind: "edit",
      path,
      startLine: start.line,
      startCharacter: start.character,
      endLine: end.line,
      endCharacter: end.character,
      text: moved.change.text,
    });
  }

  return { suggestions: rebased, isAgreed };
};

const settled = async (isPrevious: boolean, result: Promise<SuggestResult>): Promise<{ isPrevious: boolean; result: SuggestResult; }> =>
  ({ isPrevious, result: await result });

/**
 * The request asked before the last keystroke usually lands first. When the typing since
 * followed what it proposed, the rest of its answer is served at once instead of waiting
 * for the request asked now.
 */
export const carriedFrom = async (
  previous: { text: string; offset: number; result: Promise<SuggestResult>; },
  running: Promise<SuggestResult>,
  path: string,
  text: string,
): Promise<Suggestion[] | undefined> => {
  const first = await Promise.race([settled(true, previous.result), settled(false, running)]);

  if (!first.isPrevious || first.result.kind !== "suggestions") return undefined;

  const carried = rebaseSuggestions(first.result.suggestions, path, previous.text, text, previous.offset);

  return carried.isAgreed && carried.suggestions.length > 0 ? carried.suggestions : undefined;
};
