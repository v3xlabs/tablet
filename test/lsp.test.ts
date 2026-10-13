import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

import { createDefinitionCache, type DefinitionCache } from "../src/lsp";
import { deferred } from "./deferred";

const mocks = vi.hoisted(() => ({ executeCommand: vi.fn(), openTextDocument: vi.fn() }));

vi.mock("vscode", () => ({
  commands: { executeCommand: mocks.executeCommand },
  workspace: {
    openTextDocument: mocks.openTextDocument,
    asRelativePath: (uri: vscode.Uri) => uri.fsPath.replace("/workspace/", ""),
  },
  Position: class {
    constructor(public line: number, public character: number) {}
  },
}));

type Document = vscode.TextDocument & { version: number; };

const uriOf = (path: string): vscode.Uri => ({
  scheme: "file", fsPath: `/workspace/${path}`, toString: () => `file:///workspace/${path}`,
} as vscode.Uri);

const editable = (path: string, initial: string) => {
  let text = initial;
  const document = {
    uri: uriOf(path), version: 1, isClosed: false, getText: () => text,
    get lineCount() { return text.split("\n").length; },
    lineAt: (line: number) => ({ text: text.split("\n")[line] ?? "" }),
  } as Document;

  return {
    document,
    edit: (updated: string) => {
      text = updated;
      document.version++;
    },
  };
};

const locationOf = (path: string): vscode.Location => ({ uri: uriOf(path), range: { start: { line: 0, character: 0 } } } as vscode.Location);
const at = (line: number) => ({ line, character: 0 } as vscode.Position);
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const caches: DefinitionCache[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  caches.push(createDefinitionCache());
  mocks.executeCommand.mockReset()
    .mockImplementation(async (_command: string, _uri: vscode.Uri, where: vscode.Position) => [locationOf(where.line === 0 ? "alpha.ts" : "beta.ts")]);
  mocks.openTextDocument.mockReset()
    .mockImplementation(async (uri: vscode.Uri) => editable(uri.fsPath.replace("/workspace/", ""), "export const value = 1;").document);
});

afterEach(() => {
  for (const cache of caches) cache.dispose();

  caches.length = 0;
  vi.useRealTimers();
});

const cacheOf = (): DefinitionCache => {
  const cache = caches.at(-1);

  if (cache === undefined) throw new Error("no cache");

  return cache;
};

describe("definition cache", () => {
  it("keeps the excerpts of the cursor line through edits on other lines and in other files", async () => {
    const cache = cacheOf();
    const source = editable("source.ts", "computeTotal()\n\nconst other = 1");
    const lookup = deferred<vscode.Location[]>();

    mocks.executeCommand.mockReturnValueOnce(lookup.promise);
    cache.read(source.document, at(0));
    await flush();
    cache.invalidate(uriOf("unrelated.ts").toString());
    lookup.resolve([locationOf("alpha.ts")]);
    await flush();
    source.edit("computeTotal()\n\nconst other = 2");
    cache.invalidate(source.document.uri.toString());
    expect(cache.read(source.document, at(0))[0]?.path).toBe("alpha.ts");
    expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("resolves identical lines separately, and follows a line that moved", async () => {
    const cache = cacheOf();
    const source = editable("source.ts", ["helper(x)", "", "", "helper(x)"].join("\n"));

    cache.read(source.document, at(0));
    await flush();
    expect(cache.read(source.document, at(0))[0]?.path).toBe("alpha.ts");
    expect(cache.read(source.document, at(3))).toEqual([]);
    await flush();
    expect(cache.read(source.document, at(3))[0]?.path).toBe("beta.ts");

    source.edit(["", "helper(y)", "", "", "helper(x)"].join("\n"));
    expect(cache.read(source.document, at(4))[0]?.path).toBe("beta.ts");
  });

  it("never answers a line with a lookup still running for an identical line elsewhere", async () => {
    const cache = cacheOf();
    const source = editable("source.ts", ["helper(x)", "", "", "helper(x)"].join("\n"));
    const lookup = deferred<vscode.Location[]>();

    mocks.executeCommand.mockReturnValueOnce(lookup.promise);
    cache.read(source.document, at(0));
    await flush();
    cache.read(source.document, at(3));
    lookup.resolve([locationOf("alpha.ts")]);
    await flush();
    expect(cache.read(source.document, at(3))[0]?.path).not.toBe("alpha.ts");
    await flush();
    expect(cache.read(source.document, at(3))[0]?.path).toBe("beta.ts");
  });
});
