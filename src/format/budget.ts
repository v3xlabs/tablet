/**
 * Measured against llama.cpp's /tokenize on the shared endpoints: code lands near 4.1
 * characters per token, yaml near 1.9. The ratio errs on the side of counting more
 * tokens than the server will, so a prompt that fits here fits there.
 * See .tmp/context-audit/measure.ts.
 */
export const CHARS_PER_TOKEN = 3.5;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const LINE_LIMIT = 400;
const LINE_CUT_MARKER = " ...";

/** A minified or generated line carries hundreds of tokens and no signal past the first few. */
export const clipLine = (line: string): string =>
  (line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)}${LINE_CUT_MARKER}` : line);

/**
 * A hunk over the limit keeps its head and tail with a count in between, so a large
 * paste tells the model what happened without carrying every line twice.
 */
export const clipHunk = (text: string, limit: number): string => {
  const lines = text.split("\n");

  if (lines.length <= limit) return text;

  const head = Math.ceil(limit / 2);
  const tail = Math.floor(limit / 2);
  const dropped = lines.length - head - tail;

  return [...lines.slice(0, head), `... ${dropped} lines ...`, ...lines.slice(lines.length - tail)].join("\n");
};

/**
 * A message from a type checker often carries the type dump after the first sentence.
 * The first sentence says what is wrong. The dump says what the types are, at a cost
 * of hundreds of tokens.
 */
export const firstSentence = (message: string): string => {
  const cut = message.search(/\.\s+[A-Z]/);

  return cut === -1 ? message.split("\n", 1)[0] ?? message : message.slice(0, cut + 1);
};

export type Trimmable<T> = {
  render: (parts: T) => string;
  steps: Array<(parts: T) => T | undefined>;
};

/**
 * Renders, and while the estimate is over budget applies the first step that still
 * changes something. Steps are ordered from the least valuable section to the most, so
 * the cheapest material leaves first. A step returns undefined when it has nothing
 * left to take.
 */
export const fitToBudget = <T>(parts: T, budget: number, trimmable: Trimmable<T>): { parts: T; prompt: string; tokens: number; } => {
  const firstChange = (held: T): T | undefined => {
    for (const step of trimmable.steps) {
      const next = step(held);

      if (next !== undefined) return next;
    }

    return undefined;
  };

  let held = parts;
  let prompt = trimmable.render(held);
  let tokens = estimateTokens(prompt);

  while (tokens > budget) {
    const next = firstChange(held);

    if (next === undefined) break;

    held = next;
    prompt = trimmable.render(held);
    tokens = estimateTokens(prompt);
  }

  return { parts: held, prompt, tokens };
};
