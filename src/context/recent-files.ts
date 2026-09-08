import { windowAround } from "../snapshot";
import type { SuggestDependencies, SuggestInput } from "../suggest";
import type { RecentEdit } from "./recent-edits";
import type { Chunk } from "./ring-buffer";
import { isSecretPath, redactSecrets } from "./sanitize";

const WORD = /[A-Za-z_$][\w$]*/g;

const wordsIn = (text: string): Set<string> => new Set(text.match(WORD));

/**
 * A rename leaves the old identifier behind in every file that has not caught up yet, so
 * the line holding it is the place worth showing the model in a file the cursor is not in.
 */
export const focusLine = (lines: string[], changes: RecentEdit[]): number => {
  const removed = new Set<string>();

  for (const change of changes) {
    const after = wordsIn(change.after);

    for (const word of wordsIn(change.before)) {
      if (!after.has(word)) removed.add(word);
    }
  }

  if (removed.size === 0) return 0;

  const hit = lines.findIndex(line => [...wordsIn(line)].some(word => removed.has(word)));

  return hit === -1 ? 0 : hit;
};

/**
 * Renaming something in one file and moving to another leaves the model with a change it
 * can see and a file it cannot. A window of each recently touched file, taken around the
 * identifier the change removed, is the smallest thing that closes that gap.
 */
export const recentFileChunks = async (
  input: SuggestInput,
  dependencies: SuggestDependencies,
  budget: number,
  span: number,
): Promise<Chunk[]> => {
  const paths = input.candidatePaths
    .filter(path => path !== input.snapshot.path)
    .filter(path => !isSecretPath(path))
    .slice(0, Math.max(0, budget));

  const reads = await Promise.all(paths.map(path => dependencies.readFile(path)));
  const chunks: Chunk[] = [];

  for (const [index, read] of reads.entries()) {
    if (read === undefined) continue;

    const path = paths[index] ?? "";
    const lines = read.map(line => redactSecrets(line));
    const around = windowAround(lines.length, focusLine(lines, input.changes), span);

    chunks.push({ path, startLine: around.start, lines: lines.slice(around.start, around.end) });
  }

  return chunks;
};
