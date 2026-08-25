import * as vscode from "vscode";

export type LogLevel = "off" | "error" | "debug";

const level = (): LogLevel => vscode.workspace.getConfiguration("tablet").get<LogLevel>("log") ?? "error";

export const logError = (output: vscode.OutputChannel, message: string): void => {
  if (level() === "off") return;

  output.appendLine(message);
};

export const logDebug = (output: vscode.OutputChannel, message: string): void => {
  if (level() !== "debug") return;

  output.appendLine(message);
};
