import * as vscode from "vscode";

import { logError, logInfo } from "../logger";
import type { PendingRecord, Runtime } from "../runtime";
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
