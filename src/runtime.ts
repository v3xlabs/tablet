import * as vscode from "vscode";

import { type Cache, emptyCache } from "./cache";
import type { CollectedRecord } from "./collect/record";
import { type Config, isLanguageEnabled, parseConfigurations, type ParseResult, selectActive } from "./config";
import { type ChangeTracker, emptyTracker } from "./context/recent-edits";
import { emptyRing, type Ring } from "./context/ring-buffer";
import { delayFactor, type Eagerness, type EagernessSetting, levelOf } from "./eagerness";
import { idleStatus, renderStatus, type StatusMarks } from "./status-bar";
import type { Suggestion } from "./suggest";

export const OVERRIDE_KEY = "activeConfig.override";
export const ENABLED_KEY = "enabled.override";
export const STORED_KEY = "configurations";

export type Runtime = {
  memento: vscode.Memento;
  secrets: vscode.SecretStorage;
  output: vscode.OutputChannel;
  status: vscode.StatusBarItem;
  isDev: boolean;
  ring: Ring;
  tracker: ChangeTracker;
  cache: Cache<Suggestion[]>;
  lastServed: { path: string; text: string; suggestions: Suggestion[]; } | undefined;
  declined: { path: string; text: string; } | undefined;
  candidatePaths: string[];
  lastPickLine: number;
  lastPickHash: string | undefined;
  inFlight: AbortController | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The context size the endpoint reported when it refused a prompt, held for the session. */
  contextLimit: number | undefined;
  globalStoragePath: string;
  /** Records for suggestions on screen, settled when the editor reports how each one ended. */
  pending: WeakMap<vscode.InlineCompletionItem, PendingRecord>;
  lastPending: PendingRecord | undefined;
  watcher: vscode.Disposable | undefined;
  /** Scores of recent suggestion outcomes, newest last, which set the eagerness. */
  scores: number[];
};

export type PendingRecord = {
  record: CollectedRecord;
  document: vscode.TextDocument;
};

export const createRuntime = (context: vscode.ExtensionContext): Runtime => {
  const ringSettings = vscode.workspace.getConfiguration("tablet").get<Record<string, number>>("ringBuffer") ?? {};

  return {
    memento: context.globalState,
    secrets: context.secrets,
    output: vscode.window.createOutputChannel("tablet"),
    status: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100),
    isDev: context.extensionMode === vscode.ExtensionMode.Development,
    ring: emptyRing(ringSettings["chunks"] ?? 16),
    tracker: emptyTracker(8),
    cache: emptyCache<Suggestion[]>(32),
    lastServed: undefined,
    declined: undefined,
    candidatePaths: [],
    lastPickLine: -9999,
    lastPickHash: undefined,
    inFlight: undefined,
    idleTimer: undefined,
    contextLimit: undefined,
    globalStoragePath: context.globalStorageUri.fsPath,
    pending: new WeakMap(),
    lastPending: undefined,
    watcher: undefined,
    scores: [],
  };
};

const BUDGET_MARGIN = 0.9;

/**
 * What the endpoint told us wins over what the configuration guessed, and the generation
 * allowance comes off either, so the prompt and the answer fit the slot together.
 */
export const promptBudget = (runtime: Runtime, config: Config): number => {
  const ceiling = runtime.contextLimit === undefined
    ? config.contextBudget
    : Math.min(config.contextBudget, Math.floor(runtime.contextLimit * BUDGET_MARGIN));

  return Math.max(0, ceiling - config.maxTokens);
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

/** Read against the active document, so a workspace that opted in is the one that collects. */
export const isCollectEnabled = (): boolean =>
  vscode.workspace.getConfiguration("tablet", vscode.window.activeTextEditor?.document.uri).get<boolean>("collect") ?? false;

export const eagernessOf = (runtime: Runtime): Eagerness =>
  levelOf(runtime.scores, vscode.workspace.getConfiguration("tablet").get<EagernessSetting>("eagerness") ?? "auto");

/** A configured delay, stretched or shortened by how the recent suggestions went. */
export const scaledDelay = (runtime: Runtime, ms: number): number => Math.round(ms * delayFactor(eagernessOf(runtime)));

export const statusMarks = (runtime: Runtime): StatusMarks => ({
  isDevelopment: runtime.isDev,
  isPaused: !isAutomaticEnabled(runtime),
  isCollecting: isCollectEnabled(),
  eagerness: eagernessOf(runtime),
});

export const showActive = (runtime: Runtime): void => {
  const active = activeConfig(runtime);

  if (active.configuration === undefined) {
    renderStatus(runtime.status, idleStatus(active.names, active.problems), statusMarks(runtime));

    return;
  }

  renderStatus(runtime.status, { kind: "idle", name: active.configuration.name, detail: "" }, statusMarks(runtime));
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
    scaledDelay(runtime, idleMs),
  );
};

export const cancelIdleTrigger = (runtime: Runtime): void => {
  if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);

  runtime.idleTimer = undefined;
};
