import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

import { createDiagnosticTracker } from "../src/editor-diagnostics";
import { createQuickFixes } from "../src/quickfix";

const state = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  diagnostics: [] as vscode.Diagnostic[],
  documents: [] as vscode.TextDocument[],
}));

vi.mock("vscode", () => ({
  commands: { executeCommand: state.executeCommand },
  languages: { getDiagnostics: () => state.diagnostics },
  workspace: { get textDocuments() { return state.documents; } },
  CodeActionKind: { QuickFix: { value: "quickfix" } },
}));

const uri = { scheme: "file", toString: () => "file:///source.ts" } as vscode.Uri;
const other = { toString: () => "file:///other.ts" } as vscode.Uri;
const document = { uri, version: 3 } as vscode.TextDocument;
const range = { start: { line: 4, character: 6 }, end: { line: 4, character: 10 } } as vscode.Range;
const flagged = { range, message: "Cannot find name 'vlue'.", severity: 0 } as vscode.Diagnostic;

const actionOf = (extras: Record<string, unknown> = {}) => ({
  title: "Change spelling to 'value'",
  diagnostics: [flagged],
  edit: { size: 1, entries: () => [[uri, [{ range, newText: "value" }]]] },
  ...extras,
});

const declare = actionOf({ title: "Declare 'vlue'", edit: { size: 1, entries: () => [[uri, [{ range, newText: "let vlue;\n" }]]] } });

beforeEach(() => {
  state.documents = [document];
  state.diagnostics = [flagged];
});

const near = async (actions: unknown[]) => {
  const tracker = createDiagnosticTracker();

  state.executeCommand.mockReset()
    .mockResolvedValue(actions);
  tracker.noteDiagnostics([uri]);

  return createQuickFixes(tracker.isFresh).near(document, "source.ts", 4, 10, undefined);
};

describe("quick fixes", () => {
  it("offer the one preferred repair as a plain edit of this file", async () => {
    const fixes = await near([actionOf({ isPreferred: true }), declare]);

    expect(fixes.map(fix => fix.edit)).toEqual([
      { kind: "edit", path: "source.ts", startLine: 4, startCharacter: 6, endLine: 4, endCharacter: 10, text: "value" },
    ]);
  });

  it.each([
    ["several repairs with none preferred", [actionOf(), declare]],
    ["a repair that runs a command", [actionOf({ isPreferred: true, command: { command: "organize", title: "organize" } })]],
    ["a repair of another file", [actionOf({ isPreferred: true, edit: { size: 1, entries: () => [[other, [{ range, newText: "value" }]]] } })]],
  ])("offer nothing for %s", async (_case, actions) => {
    expect(await near(actions)).toEqual([]);
  });
});
