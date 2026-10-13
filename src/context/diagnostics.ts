import { firstSentence } from "../format/budget";
import { type AssembledPrompt } from "../format/fim";
import { render } from "../format/template";

export type Diagnostic = {
  line: number;
  character: number;
  severity: string;
  source: string | undefined;
  message: string;
  /** Title of the language server's quick fix, only when the server is sure of one. */
  fix?: string;
};

export const describeDiagnostic = (diagnostic: Diagnostic): string => {
  const where = `${diagnostic.line + 1}:${diagnostic.character + 1}`;
  const who = diagnostic.source === undefined ? diagnostic.severity : `${diagnostic.severity} ${diagnostic.source}`;

  const fix = diagnostic.fix === undefined ? "" : ` (quick fix: ${diagnostic.fix})`;

  return `${where} ${who}: ${firstSentence(diagnostic.message)}${fix}`;
};

/**
 * A linter has already worked out what is wrong with the code and where. Passing that to
 * the model costs a few lines of prompt and saves it from rediscovering the same fault.
 */
export const renderDiagnostics = (
  template: string,
  path: string,
  diagnostics: Diagnostic[],
): AssembledPrompt => {
  if (diagnostics.length === 0) return { ok: true, prompt: "" };

  const result = render(template, { path, text: diagnostics.map(describeDiagnostic).join("\n") });

  return result.ok ? { ok: true, prompt: result.text } : { ok: false, unknown: result.unknown };
};
