import { reduceToEdit } from "../format/window-diff";

export type RecentEdit = {
  path: string;
  before: string;
  after: string;
};

export type EditLog = {
  edits: RecentEdit[];
  limit: number;
};

export const emptyEditLog = (limit: number): EditLog => ({ edits: [], limit });

/**
 * Typing fires a change per keystroke. Without coalescing the log would hold one entry per
 * character, and the prompt would carry the same edit a dozen times at one character of
 * progress each.
 */
export const recordEdit = (log: EditLog, edit: RecentEdit): EditLog => {
  if (log.limit <= 0) return log;

  if (edit.before === edit.after) return log;

  const last = log.edits[log.edits.length - 1];

  const edits = last !== undefined && last.path === edit.path && last.after === edit.before
    ? [...log.edits.slice(0, -1), { path: edit.path, before: last.before, after: edit.after }]
    : [...log.edits, edit];

  const settled = edits.filter(entry => entry.before !== entry.after);

  return { ...log, edits: settled.slice(Math.max(0, settled.length - log.limit)) };
};

/**
 * A change event carries the range that changed but not the text that was there, so the
 * before block is recovered by diffing the previous document text against the current one.
 */
export const blocksFromChange = (
  before: string[],
  after: string[],
  pad: number,
): { before: string; after: string; } | undefined => {
  const edit = reduceToEdit(before, after, 0);

  if (edit === undefined) return undefined;

  const start = Math.max(0, edit.startLine - pad);
  const afterEnd = edit.text === "" ? edit.startLine + 1 : edit.startLine + edit.text.split("\n").length;

  return {
    before: before.slice(start, Math.min(before.length, edit.endLine + 1 + pad)).join("\n"),
    after: after.slice(start, Math.min(after.length, afterEnd + pad)).join("\n"),
  };
};
