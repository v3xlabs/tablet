import * as vscode from "vscode";

import { logError, logInfo } from "../logger";
import { type PendingRecord, refreshStatus, type Runtime } from "../runtime";
import { type Snapshot, windowAround } from "../snapshot";
import type { CollectedRecord, Outcome } from "./record";
import { appendRecord } from "./store";
import { watchResolution } from "./watch";

export const outcomeOf = (reason: vscode.InlineCompletionEndOfLifeReason): Outcome => {
  switch (reason.kind) {
    case vscode.InlineCompletionEndOfLifeReasonKind.Accepted: {
      return { kind: "accepted" };
    }
    case vscode.InlineCompletionEndOfLifeReasonKind.Rejected: {
      return { kind: "rejected" };
    }
    case vscode.InlineCompletionEndOfLifeReasonKind.Ignored: {
      return { kind: "ignored", userTypingDisagreed: reason.userTypingDisagreed };
    }
  }
};

const writeRecord = async (runtime: Runtime, record: CollectedRecord): Promise<void> => {
  try {
    const file = await appendRecord(runtime.globalStoragePath, record);

    if (runtime.recordCount !== undefined) runtime.recordCount++;

    refreshStatus(runtime);
    logInfo(runtime.output, `recorded ${record.outcome.kind} suggestion to ${file}`);
  }
  catch (error) {
    logError(runtime.output, `could not write a record: ${String(error)}`);
  }
};

/**
 * An accepted suggestion is its own resolution. A turned down one is only half a record
 * until the reader shows what they wanted instead, which the watch collects.
 */
export const settle = (runtime: Runtime, pending: PendingRecord, reason: vscode.InlineCompletionEndOfLifeReason): void => {
  if (pending.record.outcome.kind !== "unresolved") return;

  const record = { ...pending.record, outcome: outcomeOf(reason) };

  pending.record = record;

  if (record.outcome.kind === "accepted") {
    void writeRecord(runtime, record);

    return;
  }

  // a watch still open from the previous suggestion writes what it has and steps aside
  runtime.watcher?.dispose();
  runtime.watcher = watchResolution(pending.document, record.window, (resolution) => {
    runtime.watcher = undefined;
    void writeRecord(runtime, { ...record, resolution });
  });
};

type Observed = Omit<CollectedRecord, "recordId" | "timestamp" | "workspace" | "path" | "languageId" | "cursor" | "window" | "outcome" | "resolution">;

const RECORD_WINDOW_LINES = 21;

/**
 * The window is the format's own, or a fixed span for a completion, which has none.
 */
export const holdRecord = (
  runtime: Runtime,
  items: vscode.InlineCompletionItem[],
  document: vscode.TextDocument,
  snapshot: Snapshot,
  windowLines: number | undefined,
  observed: Observed,
): void => {
  const span = windowAround(snapshot.lines.length, snapshot.cursorLine, windowLines ?? RECORD_WINDOW_LINES);
  const pending: PendingRecord = {
    document,
    record: {
      recordId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? "no-workspace",
      path: snapshot.path,
      languageId: snapshot.languageId,
      cursor: { line: snapshot.cursorLine, character: snapshot.cursorCharacter },
      window: { startLine: span.start, endLine: span.end - 1, text: snapshot.lines.slice(span.start, span.end).join("\n") },
      ...observed,
      outcome: { kind: "unresolved" },
      resolution: { kind: "unchanged" },
    },
  };

  for (const item of items) runtime.pending.set(item, pending);

  runtime.lastPending = pending;
};
