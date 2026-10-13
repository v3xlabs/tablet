import * as vscode from "vscode";

import type { Diagnostic } from "./context/diagnostics";
import type { Suggestion } from "./suggest";

const LOOKUP_TIMEOUT_MS = 300;
const MAX_LOOKUPS = 3;
const CACHE_LIMIT = 64;
// Actions resolved per lookup; a lazy provider fills in its edit only then.
const RESOLVE_COUNT = 4;

type Edit = Extract<Suggestion, { kind: "edit"; }>;

export type QuickFix = {
  title: string;
  /** Diagnostic start, in the document version it was looked up in. */
  line: number;
  character: number;
  message: string;
  edit: Edit;
};

export type QuickFixes = {
  /**
   * Ordered most severe, then nearest the cursor. Empty unless the document's diagnostics match
   * the text on screen. Never returns a repair for `typingLine`, whose statement is unfinished.
   */
  near: (document: vscode.TextDocument, path: string, cursorLine: number, reach: number, typingLine: number | undefined) => Promise<QuickFix[]>;
};

const isAction = (entry: vscode.CodeAction | vscode.Command): entry is vscode.CodeAction => typeof entry.command !== "string";

const isSameDiagnostic = (left: vscode.Diagnostic, right: vscode.Diagnostic): boolean =>
  left.message === right.message
  && left.range.start.line === right.range.start.line
  && left.range.start.character === right.range.start.character;

/**
 * Only a text-only repair in this file is offered: a command or an edit to another file has
 * effects a preview cannot show. Ambiguous repairs are left to the reader, never picked for Tab.
 */
const chosenEdit = (actions: Array<vscode.CodeAction | vscode.Command>, document: vscode.TextDocument, diagnostic: vscode.Diagnostic): { title: string; edit: vscode.TextEdit; } | undefined => {
  const fixes = actions.filter(isAction)
    .filter(action => action.disabled === undefined)
    .filter(action => action.diagnostics?.some(held => isSameDiagnostic(held, diagnostic)) ?? true);
  const preferred = fixes.filter(action => action.isPreferred === true);
  const isOnlyFix = actions.length === 1 && fixes.length === 1;
  const chosen = preferred.length === 1 ? preferred[0] : fixes.find(() => isOnlyFix);

  if (chosen?.edit === undefined || chosen.command !== undefined || chosen.edit.size !== 1) return undefined;

  const [entry] = chosen.edit.entries();

  if (entry === undefined || entry[0].toString() !== document.uri.toString() || entry[1].length !== 1) return undefined;

  const [edit] = entry[1];

  return edit === undefined ? undefined : { title: chosen.title, edit };
};

const withTimeout = async <T>(promise: Thenable<T>, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), LOOKUP_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.resolve(promise), expired]);
  }
  finally {
    clearTimeout(timer);
  }
};

export const createQuickFixes = (isFresh: (document: vscode.TextDocument) => boolean): QuickFixes => {
  const cache = new Map<string, QuickFix | undefined>();

  const lookup = async (document: vscode.TextDocument, path: string, diagnostic: vscode.Diagnostic): Promise<QuickFix | undefined> => {
    const key = JSON.stringify([document.uri.toString(), document.version, diagnostic.range.start.line, diagnostic.range.start.character, diagnostic.message]);

    if (cache.has(key)) return cache.get(key);

    const actions = await withTimeout(
      vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command> | undefined>(
        "vscode.executeCodeActionProvider",
        document.uri,
        diagnostic.range,
        vscode.CodeActionKind.QuickFix.value,
        RESOLVE_COUNT,
      ),
      undefined,
    );

    // Timeouts are not cached, so a later ask retries the lookup.
    if (actions === undefined) return undefined;

    const chosen = chosenEdit(actions, document, diagnostic);
    const fix = chosen === undefined
      ? undefined
      : {
          title: chosen.title,
          line: diagnostic.range.start.line,
          character: diagnostic.range.start.character,
          message: diagnostic.message,
          edit: {
            kind: "edit" as const,
            path,
            startLine: chosen.edit.range.start.line,
            startCharacter: chosen.edit.range.start.character,
            endLine: chosen.edit.range.end.line,
            endCharacter: chosen.edit.range.end.character,
            text: chosen.edit.newText,
          },
        };

    cache.set(key, fix);

    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next();

      if (oldest.done === true) break;

      cache.delete(oldest.value);
    }

    return fix;
  };

  return {
    near: async (document, path, cursorLine, reach, typingLine) => {
      if (!isFresh(document)) return [];

      const isOnTypingLine = (range: { start: { line: number; }; end: { line: number; }; }): boolean =>
        typingLine !== undefined && range.start.line <= typingLine && typingLine <= range.end.line;
      const byDistance = (left: vscode.Diagnostic, right: vscode.Diagnostic): number =>
        left.severity - right.severity
        || Math.abs(left.range.start.line - cursorLine) - Math.abs(right.range.start.line - cursorLine);
      const candidates = vscode.languages.getDiagnostics(document.uri)
        .filter(diagnostic => Math.abs(diagnostic.range.start.line - cursorLine) <= reach)
        .filter(diagnostic => !isOnTypingLine(diagnostic.range))
        .toSorted(byDistance)
        .slice(0, MAX_LOOKUPS);
      const found = await Promise.all(candidates.map(diagnostic => lookup(document, path, diagnostic)));

      return found.filter(fix => fix !== undefined)
        .filter(fix => !isOnTypingLine({ start: { line: fix.edit.startLine }, end: { line: fix.edit.endLine } }));
    },
  };
};

export const withFixTitles = (diagnostics: Diagnostic[], fixes: QuickFix[]): Diagnostic[] => diagnostics.map((diagnostic) => {
  const fix = fixes.find(held => held.line === diagnostic.line && held.character === diagnostic.character && held.message === diagnostic.message);

  return fix === undefined ? diagnostic : { ...diagnostic, fix: fix.title };
});

/**
 * A language-server repair outranks model edits touching its line, and leads when the model had none.
 * The model's edits follow it, for cycling.
 */
export const rankedWithFixes = (suggestions: Suggestion[], fixes: QuickFix[]): Suggestion[] => {
  const touching = fixes.filter(fix => suggestions.some(held => held.kind === "edit" && held.startLine <= fix.line && fix.line <= held.endLine));
  const leading = suggestions.length === 0 ? fixes.slice(0, 1) : touching;

  const isLeading = (suggestion: Suggestion): boolean => leading.some(fix => JSON.stringify(fix.edit) === JSON.stringify(suggestion));

  return [...leading.map(fix => fix.edit), ...suggestions.filter(suggestion => !isLeading(suggestion))];
};
