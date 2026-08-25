export type Snapshot = {
  path: string;
  languageId: string;
  lines: string[];
  cursorLine: number;
  cursorCharacter: number;
};

export const lineAt = (lines: string[], index: number): string => lines[index] ?? "";

export const linePrefixOf = (snapshot: Snapshot): string =>
  lineAt(snapshot.lines, snapshot.cursorLine).slice(0, snapshot.cursorCharacter);

export const lineSuffixOf = (snapshot: Snapshot): string =>
  lineAt(snapshot.lines, snapshot.cursorLine).slice(snapshot.cursorCharacter);

export const windowAround = (
  lineCount: number,
  centre: number,
  span: number,
): { start: number; end: number; } => {
  const half = Math.floor(span / 2);
  const start = Math.max(0, centre - half);

  return { start, end: Math.min(lineCount, start + span) };
};
