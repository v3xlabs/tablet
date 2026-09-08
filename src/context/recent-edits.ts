import { reduceToEdit } from "../format/window-diff";

export type RecentEdit = {
  path: string;
  /** Document line the before block starts on, zero based. */
  line: number;
  /** The change came from accepting a tablet suggestion, which the model is told. */
  isPredicted: boolean;
  before: string;
  after: string;
};

export type EditLog = {
  edits: RecentEdit[];
  limit: number;
};

export const emptyEditLog = (limit: number): EditLog => ({ edits: [], limit });

/**
 * A change continues the current burst when it picks up exactly where the last recorded
 * one stopped. This one boundary decides both what coalesces in the log and how long the
 * window shown to the model as "original" stays pinned.
 */
export const isSameBurst = (log: EditLog, edit: RecentEdit): boolean => {
  const last = log.edits[log.edits.length - 1];

  return last !== undefined && last.path === edit.path && last.after === edit.before;
};

/**
 * Typing fires a change per keystroke. Without coalescing the log would hold one entry per
 * character, and the prompt would carry the same edit a dozen times at one character of
 * progress each.
 */
export const recordEdit = (log: EditLog, edit: RecentEdit): EditLog => {
  if (log.limit <= 0) return log;

  if (edit.before === edit.after) return log;

  const last = log.edits[log.edits.length - 1];

  const edits = last !== undefined && isSameBurst(log, edit)
    ? [...log.edits.slice(0, -1), { path: edit.path, line: last.line, isPredicted: last.isPredicted || edit.isPredicted, before: last.before, after: edit.after }]
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
): { line: number; before: string; after: string; } | undefined => {
  const edit = reduceToEdit(before, after, 0);

  if (edit === undefined) return undefined;

  const start = Math.max(0, edit.startLine - pad);
  const afterEnd = edit.text === "" ? edit.startLine + 1 : edit.startLine + edit.text.split("\n").length;

  return {
    line: start,
    before: before.slice(start, Math.min(before.length, edit.endLine + 1 + pad)).join("\n"),
    after: after.slice(start, Math.min(after.length, afterEnd + pad)).join("\n"),
  };
};

const CHANGE_PADDING = 2;
const PREVIOUS_LIMIT = 16;

export type ChangeTracker = {
  lastText: Map<string, string>;
  previousByPath: Map<string, string[]>;
  log: EditLog;
  /** An accept the editor reported before its document change arrived. */
  expected: { path: string; text: string; } | undefined;
};

export const emptyTracker = (limit: number): ChangeTracker => ({
  lastText: new Map(),
  previousByPath: new Map(),
  log: emptyEditLog(limit),
  expected: undefined,
});

const didMarkLast = (tracker: ChangeTracker, path: string, text: string): boolean => {
  const last = tracker.log.edits[tracker.log.edits.length - 1];

  if (last === undefined || last.path !== path || !last.after.includes(text)) return false;

  tracker.log = { ...tracker.log, edits: [...tracker.log.edits.slice(0, -1), { ...last, isPredicted: true }] };

  return true;
};

/**
 * The editor reports an accept and the document change in an order it does not promise,
 * so the mark goes on the last recorded edit when the text is already there, and waits
 * for the change otherwise.
 */
export const notePrediction = (tracker: ChangeTracker, path: string, text: string): void => {
  if (text === "" || didMarkLast(tracker, path, text)) return;

  tracker.expected = { path, text };
};

/**
 * The live tracking rule, shared by the extension and the bench: diff the new text
 * against what the document held, pin the start of the burst per file, coalesce the
 * keystrokes into the log. Returns the recorded change, or nothing when the text did
 * not change or the document is new.
 */
export const trackChange = (tracker: ChangeTracker, key: string, path: string, now: string): RecentEdit | undefined => {
  const previous = tracker.lastText.get(key);

  tracker.lastText.set(key, now);

  if (previous === undefined) return undefined;

  const before = previous.split(/\r?\n/);
  const after = now.split(/\r?\n/);
  const blocks = blocksFromChange(before, after, CHANGE_PADDING);

  if (blocks === undefined) return undefined;

  const change = { path, line: blocks.line, isPredicted: false, before: blocks.before, after: blocks.after };

  if (!isSameBurst(tracker.log, change) || !tracker.previousByPath.has(path)) {
    tracker.previousByPath.delete(path);
    tracker.previousByPath.set(path, before);

    if (tracker.previousByPath.size > PREVIOUS_LIMIT) {
      const oldest = tracker.previousByPath.keys().next().value;

      if (oldest !== undefined) tracker.previousByPath.delete(oldest);
    }
  }

  tracker.log = recordEdit(tracker.log, change);

  const expected = tracker.expected;

  if (expected !== undefined && expected.path === path && didMarkLast(tracker, path, expected.text)) tracker.expected = undefined;

  return change;
};
