import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { complete, type CompletionRequest, type CompletionResult } from "../src/endpoint";
import { formatFallback, itemsFor } from "../src/format/inline-items";
import { createProvider } from "../src/provider";
import { createRuntime } from "../src/runtime";
import { deferred } from "./deferred";

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  diagnostics: [] as vscode.Diagnostic[],
  documents: [] as vscode.TextDocument[],
  executeCommand: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({ get: (key: string) => state.settings[key] }),
    asRelativePath: (uri: { toString: () => string; }) => uri.toString(),
    workspaceFolders: [],
    openTextDocument: vi.fn(),
    get textDocuments() { return state.documents; },
  },
  window: {
    createOutputChannel: () => ({ appendLine: vi.fn() }),
    createStatusBarItem: () => ({ show: vi.fn() }),
  },
  commands: { executeCommand: state.executeCommand },
  languages: { getDiagnostics: () => state.diagnostics },
  CodeActionKind: { QuickFix: { value: "quickfix" } },
  StatusBarAlignment: { Right: 1 },
  ExtensionMode: { Development: 1 },
  InlineCompletionTriggerKind: { Automatic: 0, Invoke: 1 },
  ThemeColor: class {},
}));
vi.mock("../src/lsp", () => ({ createDefinitionCache: () => ({ read: vi.fn(() => []), invalidate: vi.fn(), dispose: vi.fn() }) }));
vi.mock("../src/endpoint", async importOriginal => ({ ...await importOriginal<typeof import("../src/endpoint")>(), complete: vi.fn() }));
vi.mock("../src/format/inline-items", () => ({
  itemsFor: vi.fn(),
  formatFallback: vi.fn(),
  describeItem: () => "item",
  uriFor: (path: string) => ({ toString: () => path }),
}));

const item = { insertText: "answer" } as vscode.InlineCompletionItem;

const flush = async (): Promise<void> => {
  for (let index = 0; index < 40; index++) await Promise.resolve();
};

const tokenSource = () => {
  const callbacks = new Set<() => void>();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (callback: () => void) => {
      callbacks.add(callback);

      return { dispose: () => callbacks.delete(callback) };
    },
  };

  return {
    token: token as vscode.CancellationToken,
    cancel: () => {
      token.isCancellationRequested = true;

      for (const callback of callbacks) callback();
    },
  };
};

const configure = (format: string, extras: Record<string, unknown> = {}): void => {
  state.settings["configurations"] = { local: { endpoint: "https://unused.test/v1", model: "test", format, contextFiles: 0, ...extras } };
};

const nextEdit = (): void => configure("next-edit", { template: "{{path}}\n{{current}}", cursorMarker: "", crossFileCandidates: 0 });

type Setup = { text?: string; line?: number; path?: string; languageId?: string; };

const setup = ({ text: initial = "const value = ", line = 0, path = "source.ts", languageId = "typescript" }: Setup = {}) => {
  const runtime = createRuntime({
    globalState: { get: vi.fn() },
    secrets: { get: vi.fn(async () => "") },
    globalStorageUri: { fsPath: "/unused" },
  } as unknown as vscode.ExtensionContext);
  let text = initial;
  const document = {
    version: 1,
    isClosed: false,
    uri: { scheme: "file", toString: () => path, fsPath: `/${path}` },
    languageId,
    getText: () => text,
  };
  const provider = createProvider(runtime);
  const invoke = ({ source = tokenSource(), isAutomatic = false } = {}) => Promise.resolve(provider.provideInlineCompletionItems(
    document as vscode.TextDocument,
    { line, character: (text.split("\n")[line] ?? "").length } as vscode.Position,
    { triggerKind: isAutomatic ? 0 : 1 } as vscode.InlineCompletionContext,
    source.token,
  ));

  state.documents = [document as vscode.TextDocument];

  return {
    runtime,
    document: document as vscode.TextDocument,
    invoke,
    edit: (updated: string) => {
      text = updated;
      document.version++;
    },
  };
};

const streaming = (first: Promise<unknown>, rest: Promise<CompletionResult>) => async (request: CompletionRequest): Promise<CompletionResult> => {
  await first;

  const finished = request.finish?.("answer\n");

  return finished === undefined ? rest : { ok: true, texts: [finished] };
};

beforeEach(() => {
  state.settings = { log: "off" };
  state.diagnostics = [];
  configure("fim");
  state.executeCommand.mockReset()
    .mockResolvedValue([]);
  vi.mocked(complete).mockReset()
    .mockResolvedValue({ ok: true, texts: ["answer"] });
  vi.mocked(itemsFor).mockReset()
    .mockImplementation(async suggestions => suggestions.map(() => item));
  vi.mocked(formatFallback).mockReset()
    .mockResolvedValue(item);
});
afterEach(() => vi.useRealTimers());

describe("typing bursts", () => {
  it.each([
    ["still running", false],
    ["already landed", true],
  ])("carry the dispatched reply when it is %s, through asks cancelled while debouncing", async (_state, isLanded) => {
    nextEdit();
    const { invoke, edit, runtime } = setup({ text: "const value = \n" });
    const oldReply = deferred<CompletionResult>();
    const first = tokenSource();
    const second = tokenSource();

    vi.mocked(complete).mockReturnValueOnce(oldReply.promise)
      .mockReturnValueOnce(deferred<CompletionResult>().promise);
    const old = invoke({ source: first });

    await flush();
    edit("const value = 1\n");
    first.cancel();
    const debouncing = invoke({ source: second, isAutomatic: true });

    await flush();

    if (isLanded) {
      oldReply.resolve({ ok: true, texts: ["const value = 123;\n"] });
      await old;
    }

    edit("const value = 12\n");
    second.cancel();
    const newest = invoke();

    await flush();
    oldReply.resolve({ ok: true, texts: ["const value = 123;\n"] });
    expect(await newest).toEqual([item]);
    expect(runtime.lastServed?.suggestions).toEqual([{
      kind: "edit", path: "source.ts", startLine: 0, startCharacter: 16, endLine: 0, endCharacter: 16, text: "3;",
    }]);
    await Promise.all([old, debouncing]);
  });
});

describe("stale replies", () => {
  it.each([
    ["the ask was cancelled", (source: ReturnType<typeof tokenSource>) => source.cancel()],
    ["the text changed", (_source: ReturnType<typeof tokenSource>, edit: (text: string) => void) => edit("const value = x")],
  ])("are never shown, in part or whole, once %s", async (_reason, supersede) => {
    const { invoke, edit, runtime } = setup();
    const firstPart = deferred<undefined>();
    const rest = deferred<CompletionResult>();
    const source = tokenSource();

    vi.mocked(complete).mockImplementationOnce(streaming(firstPart.promise, rest.promise));
    const pending = invoke({ source });

    await flush();
    supersede(source, edit);
    firstPart.resolve(undefined);
    await flush();
    rest.resolve({ ok: true, texts: ["answer\nmore"] });
    expect(await pending).toBeUndefined();
    expect(runtime.lastServed).toBeUndefined();
    expect(itemsFor).not.toHaveBeenCalled();
  });
});

describe("progressive display", () => {
  it.each([
    ["replaces it with the whole answer", false],
    ["keeps the screen as it is when the text changed meanwhile", true],
  ])("shows the first finished line at once, then %s", async (_outcome, isEdited) => {
    const { invoke, edit, runtime } = setup();
    const rest = deferred<CompletionResult>();

    vi.mocked(complete).mockImplementationOnce(streaming(Promise.resolve(), rest.promise));
    expect(await invoke()).toEqual([item]);
    expect(runtime.lastServed?.suggestions).toEqual([{ kind: "completion", text: "answer" }]);

    if (isEdited) edit("const value = x");

    rest.resolve({ ok: true, texts: ["answer\nmore"] });
    await flush();
    expect(runtime.lastServed?.suggestions).toEqual([{ kind: "completion", text: isEdited ? "answer" : "answer\nmore" }]);
    expect(state.executeCommand).toHaveBeenCalledTimes(isEdited ? 0 : 1);
  });
});

describe("accepting a suggestion", () => {
  it("serves the answer asked ahead, with no new request and no debounce", async () => {
    nextEdit();
    const { invoke, edit, runtime } = setup({ text: "const value = 1;\n" });

    vi.mocked(complete).mockResolvedValueOnce({ ok: true, texts: ["const value = 2;\n"] })
      .mockResolvedValueOnce({ ok: true, texts: ["const value = 2;\nconst next = 3;\n"] });
    await invoke();
    await flush();
    vi.useFakeTimers();
    edit("const value = 2;\n");
    expect(await invoke({ isAutomatic: true })).toEqual([item]);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(runtime.lastServed?.suggestions[0]).toMatchObject({ kind: "edit", text: "\nconst next = 3;" });
  });
});

const TYPED = "export const total = 1\n\nconst MyVaria";
const SEMICOLON = { kind: "edit", path: "src/timing.ts", startLine: 2, startCharacter: 13, endLine: 2, endCharacter: 13, text: ";" };

describe("the line being typed", () => {
  const unchanged = `<|marker_1|>${TYPED}\n<|marker_2|>`;

  const typedSetup = () => {
    const typed = setup({ text: TYPED, line: 2, path: "src/timing.ts" });
    const range = { start: { line: 2, character: 13 }, end: { line: 2, character: 13 } } as vscode.Range;
    const diagnostic = { range, severity: 0, source: "ts", message: "';' expected." } as vscode.Diagnostic;

    state.diagnostics = [diagnostic];
    state.executeCommand.mockResolvedValue([{
      title: "Add missing semicolon",
      isPreferred: true,
      diagnostics: [diagnostic],
      edit: { size: 1, entries: () => [[typed.document.uri, [{ range, newText: ";" }]]] },
    }]);
    typed.runtime.diagnostics.noteChange({
      document: typed.document,
      contentChanges: [{ range: { start: { line: 2, character: 12 }, end: { line: 2, character: 12 } }, text: "a" }],
    } as unknown as vscode.TextDocumentChangeEvent);
    typed.runtime.diagnostics.noteDiagnostics([typed.document.uri]);

    return typed;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    configure("zeta");
    state.settings["debounceMs"] = 0;
    vi.mocked(complete).mockImplementation(async request => ({ ok: true, texts: [request.maxTokens < 100 ? "" : unchanged] }));
  });

  it("gets no semicolon from any path while the word at its end is being typed", async () => {
    const { invoke, runtime } = typedSetup();
    const pending = invoke({ isAutomatic: true });

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeUndefined();
    expect(vi.mocked(complete).mock.calls.every(([request]) => !request.prompt.includes("';' expected"))).toBe(true);
    expect(runtime.lastServed).toBeUndefined();
  });

  it("gets the semicolon back when the reader rests", async () => {
    const { invoke, runtime } = typedSetup();

    expect(await invoke()).toEqual([item]);
    expect(runtime.lastServed?.suggestions).toEqual([SEMICOLON]);
  });
});

describe("word continuation", () => {
  it.each([
    ["code", { text: TYPED, line: 2, path: "src/timing.ts" }, "ble = 1;"],
    ["prose", { text: "# Notes\n\nThe next improvement should be reach\nLate is worse.", line: 2, path: "notes.md", languageId: "markdown" }, "able with one key press."],
  ])("shows the model's continuation of the %s word at the cursor", async (_kind, at, continuation) => {
    configure("zeta");
    state.settings["proseLanguages"] = ["markdown"];
    vi.mocked(complete).mockImplementation(async request => ({ ok: true, texts: [request.maxTokens < 100 ? continuation : "<|marker_1|><|marker_1|>"] }));
    const { invoke, runtime } = setup(at);

    expect(await invoke()).toEqual([item]);
    expect(runtime.lastServed?.suggestions).toEqual([{ kind: "completion", text: continuation }]);
  });
});
