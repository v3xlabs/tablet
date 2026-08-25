import * as vscode from "vscode";

import { type Cache, emptyCache } from "./cache";
import { type Config as Config, parseConfigurations, selectActive } from "./config";
import { type EditLog, emptyEditLog } from "./context/recent-edits";
import { emptyRing, type Ring } from "./context/ring-buffer";
import type { Suggestion } from "./suggest";

export const OVERRIDE_KEY = "activeConfig.override";
export const ENABLED_KEY = "enabled.override";

export type Runtime = {
  memento: vscode.Memento;
  secrets: vscode.SecretStorage;
  output: vscode.OutputChannel;
  status: vscode.StatusBarItem;
  ring: Ring;
  edits: EditLog;
  cache: Cache<Suggestion[]>;
  previousLines: { path: string; lines: string[]; } | undefined;
  lastText: Map<string, string>;
  candidatePaths: string[];
  lastPickLine: number;
  inFlight: AbortController | undefined;
  lastProblem: string | undefined;
};

export const createRuntime = (context: vscode.ExtensionContext): Runtime => {
  const ringSettings = vscode.workspace.getConfiguration("tablet").get<Record<string, number>>("ringBuffer") ?? {};

  return {
    memento: context.globalState,
    secrets: context.secrets,
    output: vscode.window.createOutputChannel("tablet"),
    status: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100),
    ring: emptyRing(ringSettings["chunks"] ?? 16),
    edits: emptyEditLog(8),
    cache: emptyCache<Suggestion[]>(32),
    previousLines: undefined,
    lastText: new Map(),
    candidatePaths: [],
    lastPickLine: -9999,
    inFlight: undefined,
    lastProblem: undefined,
  };
};

export type Active = {
  configuration: Config | undefined;
  problems: string[];
};

export const activeConfig = (runtime: Runtime): Active => {
  const settings = vscode.workspace.getConfiguration("tablet");
  const parsed = parseConfigurations(settings.get("configurations") ?? {});
  const override = runtime.memento.get<string>(OVERRIDE_KEY);
  const config = selectActive(parsed.configurations, settings.get<string>("activeConfiguration") ?? "", override);

  if (config === undefined && parsed.problems.length === 0 && parsed.configurations.length > 1) {
    return { configuration: config, problems: ["no active configuration is selected"] };
  }

  return { configuration: config, problems: parsed.problems };
};

export const relativePath = (uri: vscode.Uri): string =>
  vscode.workspace.asRelativePath(uri, false);

export const noteFile = (runtime: Runtime, path: string): void => {
  runtime.candidatePaths = [path, ...runtime.candidatePaths.filter(held => held !== path)].slice(0, 16);
};

export const isAutomaticEnabled = (runtime: Runtime): boolean => {
  const setting = vscode.workspace.getConfiguration("tablet").get<boolean>("enabled") ?? true;

  return runtime.memento.get<boolean>(ENABLED_KEY) ?? setting;
};
