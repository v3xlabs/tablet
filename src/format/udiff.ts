import type { RecentEdit } from "../context/recent-edits";

const commonHead = (before: string[], after: string[]): number => {
  const limit = Math.min(before.length, after.length);
  let count = 0;

  while (count < limit && before[count] === after[count]) count++;

  return count;
};

const commonTail = (before: string[], after: string[], head: number): number => {
  const limit = Math.min(before.length, after.length) - head;
  let count = 0;

  while (count < limit && before[before.length - 1 - count] === after[after.length - 1 - count]) count++;

  return count;
};

/**
 * One hunk in unified diff form, the way zed and copilot show an edit to their models.
 * The before and after blocks already carry their padding lines, which become the
 * hunk's context lines.
 */
export const unifiedHunk = (edit: RecentEdit): string => {
  const before = edit.before.split("\n");
  const after = edit.after.split("\n");
  const head = commonHead(before, after);
  const tail = commonTail(before, after, head);

  const body = [
    ...before.slice(0, head).map(line => ` ${line}`),
    ...before.slice(head, before.length - tail).map(line => `-${line}`),
    ...after.slice(head, after.length - tail).map(line => `+${line}`),
    ...before.slice(before.length - tail).map(line => ` ${line}`),
  ];

  return [`@@ -${edit.line + 1},${before.length} +${edit.line + 1},${after.length} @@`, ...body].join("\n");
};
