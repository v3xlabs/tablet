import { isSecretPath, redactSecrets } from "./sanitize";

export type Chunk = {
  path: string;
  startLine: number;
  lines: string[];
};

export type Ring = {
  chunks: Chunk[];
  limit: number;
};

export const emptyRing = (limit: number): Ring => ({ chunks: [], limit });

const jaccard = (left: string[], right: string[]): number => {
  const a = new Set(left.map(line => line.trim()).filter(line => line !== ""));
  const b = new Set(right.map(line => line.trim()).filter(line => line !== ""));

  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;

  for (const line of a) {
    if (b.has(line)) shared++;
  }

  return shared / (a.size + b.size - shared);
};

const SIMILAR_ENOUGH_TO_EVICT = 0.78;

/**
 * Held chunks that overlap the new one are dropped rather than kept alongside it, so the
 * ring fills with distinct material instead of the same function seen from six positions.
 */
export const addChunk = (ring: Ring, chunk: Chunk): Ring => {
  if (ring.limit <= 0) return ring;

  if (chunk.lines.length < 3) return ring;

  // a chunk from a secret file never reaches the model, and the text is redacted even
  // when the path looks ordinary, because a stray key in a readme still leaks
  if (isSecretPath(chunk.path)) return ring;

  const lines = chunk.lines.map(line => redactSecrets(line));
  const safe = { ...chunk, lines };

  const kept = ring.chunks.filter(held => jaccard(held.lines, safe.lines) < SIMILAR_ENOUGH_TO_EVICT);
  const chunks = [...kept, safe];

  return { ...ring, chunks: chunks.slice(Math.max(0, chunks.length - ring.limit)) };
};

/**
 * Chunks come from above the prefix and below the suffix, which is material the prompt
 * does not already carry.
 */
export const chunksAround = (
  path: string,
  lines: string[],
  cursorLine: number,
  scope: number,
  size: number,
): Chunk[] => {
  const above = { start: Math.max(0, cursorLine - scope), end: Math.max(0, cursorLine - scope + size) };
  const below = { start: Math.min(lines.length, cursorLine + scope), end: Math.min(lines.length, cursorLine + scope + size) };

  return [above, below]
    .filter(span => span.end - span.start >= 3)
    .map(span => ({ path, startLine: span.start, lines: lines.slice(span.start, span.end) }));
};
