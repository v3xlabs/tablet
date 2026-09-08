const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

const KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "function", "if", "implements",
  "import", "in", "instanceof", "interface", "let", "new", "null", "of", "package", "private", "protected", "public",
  "return", "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof", "undefined", "var", "void",
  "while", "with", "yield", "fn", "pub", "impl", "struct", "mut", "use", "mod", "match", "def", "elif", "not", "and",
  "or", "pass", "lambda", "None", "True", "False", "self", "string", "number", "boolean", "console", "log",
]);

const MIN_LENGTH = 3;
const MAX_LOOKUPS = 8;

/** Where on the line the names worth resolving start, nearest the cursor first. */
export const identifiersOn = (line: string, cursorCharacter: number): Array<{ name: string; character: number; }> => {
  const found = new Map<string, number>();

  for (const match of line.matchAll(IDENTIFIER)) {
    const name = match[0];

    if (name.length < MIN_LENGTH || KEYWORDS.has(name) || found.has(name)) continue;

    found.set(name, match.index);
  }

  return [...found]
    .map(([name, character]) => ({ name, character }))
    .toSorted((left, right) => Math.abs(left.character - cursorCharacter) - Math.abs(right.character - cursorCharacter))
    .slice(0, MAX_LOOKUPS);
};

const EXCERPT_LINES = 12;

/**
 * The definition and what follows it, which for a function is its signature and the
 * first lines of its body, and for a type its fields. A block that closes earlier ends
 * the excerpt there.
 */
export const excerptAround = (lines: string[], line: number): { startLine: number; lines: string[]; } => {
  const start = Math.max(0, line);
  const picked: string[] = [];
  let depth = 0;

  for (let index = start; index < lines.length && picked.length < EXCERPT_LINES; index++) {
    const text = lines[index] ?? "";

    picked.push(text);

    for (const char of text) {
      if ("{([".includes(char)) depth++;
      else if ("})]".includes(char)) depth--;
    }

    if (index > start && depth <= 0 && text.trim() !== "") break;
  }

  return { startLine: start, lines: picked };
};
