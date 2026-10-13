import * as vscode from "vscode";

import type { Diagnostic } from "./context/diagnostics";

const DIAGNOSTIC_LIMIT = 12;
const MAX_HELD_CHANGES = 64;

const SEVERITY_NAMES = ["error", "warning", "info", "hint"];

/** The limit keeps the prompt within the endpoint's context. */
export const diagnosticsFor = (uri: vscode.Uri, cursorLine: number): Diagnostic[] => {
  const all = vscode.languages.getDiagnostics(uri)
    .map(entry => ({
      line: entry.range.start.line,
      character: entry.range.start.character,
      severity: SEVERITY_NAMES[entry.severity] ?? "note",
      source: entry.source,
      message: entry.message,
    }));

  const byDistance = (left: Diagnostic, right: Diagnostic): number =>
    Math.abs(left.line - cursorLine) - Math.abs(right.line - cursorLine);

  const errors = all.filter(held => held.severity === "error").toSorted(byDistance);
  const others = all.filter(held => held.severity !== "error").toSorted(byDistance);

  return [...errors, ...others].slice(0, DIAGNOSTIC_LIMIT)
    .toSorted((left, right) => left.line - right.line);
};

type LineChange = { startLine: number; endLine: number; delta: number; };

type Published = {
  version: number;
  /** Oldest first; each event's changes are against the text before it. */
  events: LineChange[][];
};

export type DiagnosticTracker = {
  noteDiagnostics: (uris: readonly vscode.Uri[]) => void;
  noteChange: (event: vscode.TextDocumentChangeEvent) => void;
  isFresh: (document: vscode.TextDocument) => boolean;
  lastEdit: (document: vscode.TextDocument) => { line: number; ms: number; } | undefined;
  adjust: (document: vscode.TextDocument, diagnostics: Diagnostic[]) => Diagnostic[];
};

const shiftedLine = (line: number, event: LineChange[]): number | undefined => {
  let shifted = line;

  for (const change of event) {
    if (line >= change.startLine && line <= change.endLine) return undefined;

    if (line > change.endLine) shifted += change.delta;
  }

  return shifted;
};

/**
 * The language server reports on a version the reader has usually typed past, so each
 * report is rebased through the edits since.
 */
export const createDiagnosticTracker = (): DiagnosticTracker => {
  const published = new Map<string, Published>();
  const edited = new Map<string, { line: number; at: number; }>();

  return {
    noteDiagnostics: (uris) => {
      for (const uri of uris) {
        const document = vscode.workspace.textDocuments.find(held => held.uri.toString() === uri.toString());

        if (document === undefined) {
          published.delete(uri.toString());
          edited.delete(uri.toString());
        }
        else published.set(uri.toString(), { version: document.version, events: [] });
      }
    },
    noteChange: (event) => {
      const last = event.contentChanges.at(-1);

      if (last !== undefined) edited.set(event.document.uri.toString(), { line: last.range.start.line + last.text.split("\n").length - 1, at: Date.now() });

      const held = published.get(event.document.uri.toString());

      if (held === undefined) return;

      if (held.events.length >= MAX_HELD_CHANGES) {
        published.delete(event.document.uri.toString());

        return;
      }

      held.events.push(event.contentChanges.map(change => ({
        startLine: change.range.start.line,
        endLine: change.range.end.line,
        delta: change.text.split("\n").length - 1 - (change.range.end.line - change.range.start.line),
      })));
    },
    isFresh: document => published.get(document.uri.toString())?.version === document.version,
    lastEdit: (document) => {
      const held = edited.get(document.uri.toString());

      return held === undefined ? undefined : { line: held.line, ms: Date.now() - held.at };
    },
    adjust: (document, diagnostics) => {
      const held = published.get(document.uri.toString());

      if (held === undefined || held.events.length === 0) return diagnostics;

      return diagnostics.flatMap((diagnostic) => {
        let line: number | undefined = diagnostic.line;

        for (const event of held.events) {
          if (line === undefined) break;

          line = shiftedLine(line, event);
        }

        return line === undefined ? [] : [{ ...diagnostic, line }];
      });
    },
  };
};

// Parser messages a half-typed statement produces.
const UNFINISHED = /expected|missing semicolon|unterminated|must be initiali[sz]ed|unexpected end/i;

export const withoutUnfinished = (diagnostics: Diagnostic[], typingLine: number | undefined): Diagnostic[] =>
  diagnostics.filter(diagnostic => diagnostic.line !== typingLine || !UNFINISHED.test(diagnostic.message));
