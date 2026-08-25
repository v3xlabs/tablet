export type PlainEdit = {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  text: string;
};

const offsetOf = (text: string, line: number, character: number): number => {
  let offset = 0;

  for (let index = 0; index < line; index++) {
    const nextBreak = text.indexOf("\n", offset);

    if (nextBreak === -1) return text.length;

    offset = nextBreak + 1;
  }

  return Math.min(offset + character, text.length);
};

/**
 * A formatter hands back a set of edits against the document as it stands, so they are
 * applied from the end backwards and every offset stays valid while the text shrinks and
 * grows underneath.
 */
export const applyEdits = (text: string, edits: PlainEdit[]): string => {
  const placed = edits
    .map(edit => ({
      start: offsetOf(text, edit.startLine, edit.startCharacter),
      end: offsetOf(text, edit.endLine, edit.endCharacter),
      text: edit.text,
    }))
    .toSorted((left, right) => right.start - left.start);

  let result = text;

  for (const edit of placed) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);

  return result;
};
