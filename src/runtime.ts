import * as vscode from "vscode";

import { type Cache, emptyCache } from "./cache";
import { type Config, isLanguageEnabled, parseConfigurations, type ParseResult, selectActive } from "./config";
import { type EditLog, emptyEditLog } from "./context/recent-edits";
import { emptyRing, type Ring } from "./context/ring-buffer";
import type { Suggestion } from "./suggest";

export const OVERRIDE_KEY = "activeConfig.override";
export const ENABLED_KEY = "enabled.override";
export const STORED_KEY = "configurations";

export type Runtime = {
  memento: vscode.Memento;
  secrets: vscode.SecretStorage;
  output: vscode.OutputChannel;
  status: vscode.StatusBarItem;
  ring: Ring;
  edits: EditLog;
  cache: Cache<Suggestion[]>;
  previousLines: { path: string; lines: string[]; } | undefined;
  lastServed: { path: string; text: string; suggestions: Suggestion[]; } | undefined;
  declined: { path: string; text: string; } | undefined;
  lastText: Map<string, string>;
  candidatePaths: string[];
  lastPickLine: number;
  inFlight: AbortController | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
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
    lastServed: undefined,
    declined: undefined,
    lastText: new Map(),
    candidatePaths: [],
    lastPickLine: -9999,
    inFlight: undefined,
    idleTimer: undefined,
  };
};

export type Active = {
  configuration: Config | undefined;
  names: string[];
  problems: string[];
};

export const storedConfigs = (runtime: Runtime): Record<string, unknown> =>
  runtime.memento.get<Record<string, unknown>>(STORED_KEY) ?? {};

// a name defined in settings.json wins, so a declarative configuration is never shadowed
// by one the add command wrote into extension storage
export const allConfigs = (runtime: Runtime): ParseResult =>
  parseConfigurations({
    ...storedConfigs(runtime),
    ...vscode.workspace.getConfiguration("tablet").get<Record<string, unknown>>("configurations"),
  });

export const saveConfig = async (runtime: Runtime, name: string, raw: Record<string, unknown>): Promise<void> => {
  await runtime.memento.update(STORED_KEY, { ...storedConfigs(runtime), [name]: raw });
};

export const forgetConfig = async (runtime: Runtime, name: string): Promise<void> => {
  const held = { ...storedConfigs(runtime) };

  delete held[name];

  await runtime.memento.update(STORED_KEY, held);
};

export const activeConfig = (runtime: Runtime): Active => {
  const settings = vscode.workspace.getConfiguration("tablet");
  const parsed = allConfigs(runtime);
  const override = runtime.memento.get<string>(OVERRIDE_KEY);
  const config = selectActive(parsed.configurations, settings.get<string>("activeConfiguration") ?? "", override);

  const names = parsed.configurations.map(held => held.name);

  return { configuration: config, names, problems: parsed.problems };
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

const IDLE_TRIGGER_MS = 400;

/**
 * The editor asks for inline suggestions when the document changes, never when the cursor
 * simply moves. Resting on the line you are about to fix is exactly when a suggestion is
 * wanted, so the rest is what schedules the ask.
 */
export const scheduleIdleTrigger = (runtime: Runtime, editor: vscode.TextEditor | undefined): void => {
  if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);

  runtime.idleTimer = undefined;

  if (editor === undefined || !editor.selection.isEmpty || editor.document.uri.scheme !== "file") return;

  if (!isAutomaticEnabled(runtime)) return;

  const settings = vscode.workspace.getConfiguration("tablet");

  if (!isLanguageEnabled(settings.get<Record<string, boolean>>("languages") ?? {}, editor.document.languageId)) return;

  const idleMs = settings.get<number>("idleTriggerMs") ?? IDLE_TRIGGER_MS;

  if (idleMs <= 0) return;

  runtime.idleTimer = setTimeout(
    () => void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger"),
    idleMs,
  );
};

export const cancelIdleTrigger = (runtime: Runtime): void => {
  if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);

  runtime.idleTimer = undefined;
};
