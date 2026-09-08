import * as vscode from "vscode";

export type LogLevel = "off" | "error" | "info" | "debug";

const RANK: Record<LogLevel, number> = { off: 0, error: 1, info: 2, debug: 3 };

const level = (): LogLevel => vscode.workspace.getConfiguration("tablet").get<LogLevel>("log") ?? "info";

const stamp = (): string => new Date().toISOString()
  .slice(11, 23);

export const logError = (output: vscode.OutputChannel, message: string): void => {
  if (RANK[level()] < RANK.error) return;

  output.appendLine(`${stamp()} ${message}`);
};

/** One line per ask: what was asked, what came back, or why nothing was asked. */
export const logInfo = (output: vscode.OutputChannel, message: string): void => {
  if (RANK[level()] < RANK.info) return;

  output.appendLine(`${stamp()} ${message}`);
};

/** The prompts and replies themselves, which are long. */
export const logDebug = (output: vscode.OutputChannel, message: string): void => {
  if (RANK[level()] < RANK.debug) return;

  output.appendLine(`${stamp()} ${message}`);
};
