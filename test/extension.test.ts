import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

import { activate } from "../src/extension";
import { createProvider } from "../src/provider";

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  activeEditor: undefined as vscode.TextEditor | undefined,
  executeCommand: vi.fn(),
  changeListeners: new Set<(event: vscode.TextDocumentChangeEvent) => void>(),
  ignored: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({ get: (key: string) => state.settings[key] }),
    asRelativePath: (uri: vscode.Uri) => uri.fsPath.replace("/workspace/", ""),
    textDocuments: [],
    onDidChangeTextDocument: (listener: (event: vscode.TextDocumentChangeEvent) => void) => {
      state.changeListeners.add(listener);

      return { dispose: () => state.changeListeners.delete(listener) };
    },
    onDidCloseTextDocument: state.ignored,
    onDidOpenTextDocument: state.ignored,
    onDidChangeConfiguration: state.ignored,
  },
  window: {
    get activeTextEditor() { return state.activeEditor; },
    createOutputChannel: () => ({ appendLine: vi.fn(), dispose: vi.fn() }),
    createStatusBarItem: () => ({ show: vi.fn(), dispose: vi.fn() }),
    onDidChangeActiveTextEditor: state.ignored,
    onDidChangeTextEditorSelection: state.ignored,
  },
  commands: { executeCommand: state.executeCommand },
  languages: { registerInlineCompletionItemProvider: state.ignored, onDidChangeDiagnostics: state.ignored, getDiagnostics: () => [] },
  StatusBarAlignment: { Right: 1 },
  ExtensionMode: { Development: 1 },
  ThemeColor: class {},
  Disposable: class {
    constructor(private readonly cleanup: () => void) {}
    dispose(): void { this.cleanup(); }
  },
}));
vi.mock("../src/commands", () => ({ registerCommands: () => [] }));
vi.mock("../src/provider", () => ({ createProvider: vi.fn(() => ({})) }));
vi.mock("../src/lsp", () => ({ createDefinitionCache: () => ({ read: vi.fn(() => []), invalidate: vi.fn(), dispose: vi.fn() }) }));

const subscriptions: vscode.Disposable[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  state.executeCommand.mockReset();
  state.settings = {
    configurations: { local: { endpoint: "https://unused.test/v1", model: "test", format: "fim" } },
    languages: { "*": true },
    idleTriggerMs: 400,
  };
});

afterEach(() => {
  for (const subscription of subscriptions) subscription.dispose();

  subscriptions.length = 0;
  vi.useRealTimers();
});

describe("a rest after typing", () => {
  it.each([
    ["nothing is shown, then stops", false, 2],
    ["never again while a suggestion is shown", true, 1],
  ])("asks, then once more if the rest lasts and %s", async (_case, isShown, asks) => {
    const document = {
      uri: { scheme: "file", fsPath: "/workspace/source.ts", toString: () => "file:///workspace/source.ts" },
      languageId: "typescript",
      version: 1,
      isClosed: false,
      getText: () => "computeTotal()",
    } as vscode.TextDocument;

    state.activeEditor = { document, selection: { isEmpty: true, active: { line: 0, character: 0 } } } as vscode.TextEditor;
    activate({
      subscriptions,
      globalState: { get: vi.fn() },
      secrets: { get: vi.fn() },
      globalStorageUri: { fsPath: "/unused" },
    } as unknown as vscode.ExtensionContext);

    const runtime = vi.mocked(createProvider).mock.calls.at(-1)?.[0];

    if (runtime !== undefined && isShown) runtime.lastServed = { path: "source.ts", text: "computeTotal()", suggestions: [] };

    for (const listener of state.changeListeners) listener({ document, contentChanges: [] } as unknown as vscode.TextDocumentChangeEvent);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.executeCommand).toHaveBeenCalledTimes(asks);
    expect(state.executeCommand).toHaveBeenCalledWith("editor.action.inlineSuggest.trigger");
  });
});
