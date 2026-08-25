import type { Diagnostic } from "../src/context/diagnostics";

export type Fault
  = | { op: "indent"; line: number; }
    | { op: "trailing"; line: number; }
    | { op: "duplicate"; line: number; diagnostics: Diagnostic[]; }
    | { op: "missing-punct"; line: number; }
    | { op: "missing-line"; line: number; diagnostics: Diagnostic[]; }
    | { op: "truncate"; line: number; keep: number; }
    | { op: "typo"; line: number; from: string; to: string; diagnostics: Diagnostic[]; };

export type Mutation = {
  category: string;
  lines: string[];
  faultLine: number;
  cursorNear: { line: number; character: number; };
  diagnostics: Diagnostic[];
  allowFormat: boolean;
  truncated: boolean;
};

export const endOf = (lines: string[], line: number): { line: number; character: number; } =>
  ({ line, character: (lines[line] ?? "").length });

export const applyFault = (seed: string[], fault: Fault, language: string): Mutation => {
  const lines = [...seed];
  const original = lines[fault.line] ?? "";

  switch (fault.op) {
    case "indent": {
      lines[fault.line] = `     ${original}`;

      const wanted = original.length - original.trimStart().length;

      const diagnostics: Diagnostic[] = language.startsWith("typescript")
        ? [{ line: fault.line, character: 0, severity: "warning", source: "eslint", message: `Expected indentation of ${wanted} spaces but found ${wanted + 5}.` }]
        : (language === "python"
            ? [{ line: fault.line, character: 0, severity: "error", source: "Pylance", message: "Unexpected indentation" }]
            : [{ line: fault.line, character: 0, severity: "warning", source: "fmt", message: `Expected indentation of ${wanted} spaces but found ${wanted + 5}.` }]);

      return { category: "indent", lines, faultLine: fault.line, cursorNear: endOf(lines, fault.line), diagnostics, allowFormat: true, truncated: false };
    }
    case "trailing": {
      lines[fault.line] = `${original}     `;

      const diagnostics: Diagnostic[] = [{ line: fault.line, character: original.length, severity: "warning", source: language.startsWith("typescript") ? "eslint" : "fmt", message: "Trailing spaces not allowed." }];

      return { category: "trailing", lines, faultLine: fault.line, cursorNear: { line: fault.line, character: original.length }, diagnostics, allowFormat: true, truncated: false };
    }
    case "duplicate": {
      lines.splice(fault.line + 1, 0, original);

      return { category: "duplicate", lines, faultLine: fault.line + 1, cursorNear: endOf(lines, fault.line + 1), diagnostics: fault.diagnostics, allowFormat: false, truncated: false };
    }
    case "missing-punct": {
      lines[fault.line] = original.replace(/;$/, "");

      return { category: "missing-punct", lines, faultLine: fault.line, cursorNear: endOf(lines, fault.line), diagnostics: [{ line: fault.line, character: Math.max(0, original.length - 1), severity: "error", source: "ts", message: "';' expected." }], allowFormat: false, truncated: false };
    }
    case "missing-line": {
      lines.splice(fault.line, 1);

      return { category: "missing-line", lines, faultLine: fault.line, cursorNear: endOf(lines, fault.line), diagnostics: fault.diagnostics, allowFormat: false, truncated: false };
    }
    case "truncate": {
      lines[fault.line] = original.slice(0, fault.keep);

      return { category: "truncated", lines, faultLine: fault.line, cursorNear: { line: fault.line, character: fault.keep }, diagnostics: [], allowFormat: false, truncated: true };
    }
    case "typo": {
      lines[fault.line] = original.replace(fault.from, () => fault.to);

      return { category: "typo", lines, faultLine: fault.line, cursorNear: endOf(lines, fault.line), diagnostics: fault.diagnostics, allowFormat: false, truncated: false };
    }
  }
};

export const lineMatching = (lines: string[], needle: string, nth = 0): number => {
  const hits = lines
    .map((line, index) => ({ line, index }))
    .filter(held => held.line.includes(needle));

  const hit = hits[nth];

  if (hit === undefined) throw new Error(`no line ${nth} matching ${JSON.stringify(needle)}`);

  return hit.index;
};

const everyNth = <T>(items: T[], step: number, cap: number): T[] =>
  items.filter((_, index) => index % step === 0).slice(0, cap);

export const autoFaults = (lines: string[], language: string): Fault[] => {
  const indented = lines
    .map((line, index) => ({ line, index }))
    .filter(held => /^ {2,}\S/.test(held.line) && held.line.trim().length >= 4);

  const nonEmpty = lines
    .map((line, index) => ({ line, index }))
    .filter(held => held.line.trim().length >= 4);

  const semicolons = lines
    .map((line, index) => ({ line, index }))
    .filter(held => held.line.endsWith(";") && held.line.trim().length >= 6);

  return [
    ...everyNth(indented, 3, 6).map((held): Fault => ({ op: "indent", line: held.index })),
    ...everyNth(nonEmpty, 5, 4).map((held): Fault => ({ op: "trailing", line: held.index })),
    ...(language === "python" ? [] : everyNth(semicolons, 4, 5).map((held): Fault => ({ op: "missing-punct", line: held.index }))),
  ];
};
