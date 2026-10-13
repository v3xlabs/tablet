import * as vscode from "vscode";

import { excerptAround, identifiersOn } from "./context/definitions";
import type { Chunk } from "./context/ring-buffer";
import { isSecretPath, redactSecrets } from "./context/sanitize";

const MAX_DEFINITIONS = 6;
const MAX_TARGETS = 24;
const MAX_ENTRIES = 64;
const MAX_BACKGROUND = 4;
const LOOKUP_TIMEOUT_MS = 400;
const RETRY_DELAY_MS = 2000;
const VISIBLE_SPAN = 20;

type Target = { uri: vscode.Uri; line: number; };
type Dependency = { document: vscode.TextDocument; version: number; };
type Entry = {
  key: string;
  uri: string;
  document: vscode.TextDocument;
  version: number;
  line: number;
  character: number;
  state: "queued" | "running" | "ready" | "failed";
  retryAt: number;
  startedAt: number;
  chunks: Chunk[];
  dependencies: Map<string, Dependency>;
};
type Work = { entry: Entry; timer: ReturnType<typeof setTimeout>; };

export type DefinitionCache = {
  read: (document: vscode.TextDocument, position: vscode.Position) => Chunk[];
  invalidate: (uri: string) => void;
  dispose: () => void;
};

const targetOf = (entry: vscode.Location | vscode.LocationLink): Target => ("targetUri" in entry
  ? { uri: entry.targetUri, line: (entry.targetSelectionRange ?? entry.targetRange).start.line }
  : { uri: entry.uri, line: entry.range.start.line });

const isCurrentDocument = (document: vscode.TextDocument, version: number): boolean =>
  !document.isClosed && document.version === version;

/**
 * Ready definition excerpts only: a cold read schedules work without waiting for LSP or
 * opening files. An excerpt is keyed by the text of the line it was asked from, so typing
 * elsewhere in the file keeps it, while any change to a target document drops it. Both
 * the LRU (including queued work) and uncancellable background work are bounded. A
 * timed-out command/open keeps its slot until it actually settles, so a broken provider
 * cannot accumulate an unbounded number of outstanding promises.
 */
export const createDefinitionCache = (): DefinitionCache => {
  const entries = new Map<string, Entry>();
  const active = new Map<string, Work>();
  const changedAt = new Map<string, number>();
  let changes = 0;
  let isDisposed = false;
  let isScheduled = false;

  const isHeld = (entry: Entry): boolean => !isDisposed && entries.get(entry.key) === entry && !entry.document.isClosed;
  const isRunning = (entry: Entry): boolean => isHeld(entry) && entry.state === "running"
    && isCurrentDocument(entry.document, entry.version);
  const areDependenciesCurrent = (entry: Entry): boolean => {
    for (const dependency of entry.dependencies.values()) {
      if (!isCurrentDocument(dependency.document, dependency.version)) return false;
    }

    return true;
  };

  const remove = (entry: Entry): void => {
    entries.delete(entry.key);

    const work = active.get(entry.key);

    if (work?.entry === entry) clearTimeout(work.timer);
  };

  const failed = (entry: Entry): void => {
    if (!isRunning(entry)) return;

    entry.state = "failed";
    entry.retryAt = Date.now() + RETRY_DELAY_MS;
    entry.chunks = [];
  };

  const resolve = async (entry: Entry): Promise<void> => {
    const found = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
      "vscode.executeDefinitionProvider",
      entry.document.uri,
      new vscode.Position(entry.line, entry.character),
    );

    if (!isRunning(entry)) return;

    const seen = new Set<string>();
    const chunks: Chunk[] = [];

    const locations = (found ?? []).slice(0, MAX_TARGETS);

    for (const location of locations) {
      if (!isRunning(entry) || !areDependenciesCurrent(entry)) return;

      if (chunks.length >= MAX_DEFINITIONS) break;

      const target = targetOf(location);
      const uri = target.uri.toString();
      const key = JSON.stringify([uri, target.line]);

      if (target.uri.scheme !== "file" || seen.has(key)) continue;

      seen.add(key);

      const isSameFile = uri === entry.uri;

      if (isSameFile && Math.abs(target.line - entry.line) <= VISIBLE_SPAN) continue;

      const path = vscode.workspace.asRelativePath(target.uri, false);

      if (isSecretPath(path) || isSecretPath(target.uri.fsPath)) continue;

      const document = isSameFile ? entry.document : await vscode.workspace.openTextDocument(target.uri);

      if (!isRunning(entry) || document.isClosed || !areDependenciesCurrent(entry)) return;

      if ((changedAt.get(uri) ?? 0) > entry.startedAt) {
        remove(entry);

        return;
      }

      entry.dependencies.set(uri, { document, version: document.version });

      const excerpt = excerptAround(document.getText().split(/\r?\n/), target.line);

      chunks.push({ path, startLine: excerpt.startLine, lines: excerpt.lines.map(line => redactSecrets(line)) });
    }

    if (!isRunning(entry) || !areDependenciesCurrent(entry)) return;

    entry.chunks = chunks;
    entry.state = "ready";
  };

  const pump = (): void => {
    isScheduled = false;

    if (isDisposed) return;

    for (const entry of entries.values()) {
      if (active.size >= MAX_BACKGROUND) break;

      if (entry.state !== "queued" || active.has(entry.key)) continue;

      if (!isHeld(entry) || entry.document.version !== entry.version) {
        remove(entry);
        continue;
      }

      entry.state = "running";
      entry.startedAt = changes;

      const timer = setTimeout(() => failed(entry), LOOKUP_TIMEOUT_MS);

      active.set(entry.key, { entry, timer });
      void resolve(entry).catch(() => failed(entry))
        .finally(() => {
          failed(entry);
          clearTimeout(timer);
          active.delete(entry.key);
          schedule();
        });
    }
  };

  const schedule = (): void => {
    if (isDisposed || isScheduled) return;

    isScheduled = true;
    queueMicrotask(pump);
  };

  const isUsable = (entry: Entry, document: vscode.TextDocument, line: number, lineText: string): boolean => {
    if (!isHeld(entry) || entry.document !== document || !areDependenciesCurrent(entry)) return false;

    if (entry.state === "queued" || entry.state === "running") {
      return entry.version === document.version && entry.line === line;
    }

    if (entry.state === "failed" && Date.now() >= entry.retryAt && !active.has(entry.key)) return false;

    return entry.line === line || entry.line >= document.lineCount || document.lineAt(entry.line).text !== lineText;
  };

  const read: DefinitionCache["read"] = (document, position) => {
    if (isDisposed || document.isClosed || isSecretPath(vscode.workspace.asRelativePath(document.uri, false)) || isSecretPath(document.uri.fsPath)) return [];

    const uri = document.uri.toString();
    const lineText = document.lineAt(position.line).text;
    const chunks: Chunk[] = [];
    const seen = new Set<string>();

    for (const name of identifiersOn(lineText, position.character)) {
      const key = JSON.stringify([uri, lineText, name.name, name.character]);
      let entry = entries.get(key);

      if (entry !== undefined && !isUsable(entry, document, position.line, lineText)) {
        remove(entry);
        entry = undefined;
      }

      if (entry !== undefined) entry.line = position.line;

      if (entry === undefined && !active.has(key)) {
        while (entries.size >= MAX_ENTRIES) {
          const oldest = entries.values().next().value;

          if (oldest !== undefined) remove(oldest);
        }

        entry = {
          key, uri, document, version: document.version, line: position.line, character: name.character,
          state: "queued", retryAt: 0, startedAt: 0, chunks: [], dependencies: new Map(),
        };
        entries.set(key, entry);
      }

      if (entry === undefined) continue;

      entries.delete(key);
      entries.set(key, entry);

      if (entry.state !== "ready") continue;

      for (const chunk of entry.chunks) {
        const chunkKey = JSON.stringify([chunk.path, chunk.startLine]);

        if (!seen.has(chunkKey) && chunks.length < MAX_DEFINITIONS) {
          seen.add(chunkKey);
          chunks.push({ ...chunk, lines: [...chunk.lines] });
        }
      }
    }

    schedule();

    return chunks;
  };

  return {
    read,
    invalidate: (uri) => {
      changes++;
      changedAt.set(uri, changes);

      for (const entry of entries.values()) {
        if (entry.dependencies.has(uri) || (entry.uri === uri && entry.state === "running")) remove(entry);
      }

      schedule();
    },
    dispose: () => {
      isDisposed = true;
      entries.clear();
      changedAt.clear();

      for (const work of active.values()) clearTimeout(work.timer);

      active.clear();
    },
  };
};
