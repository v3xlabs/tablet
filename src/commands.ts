import { mkdir } from "node:fs/promises";

import * as vscode from "vscode";

import { collectRoot, exportRecords } from "./collect/store";
import { EAGERNESS_SETTINGS } from "./eagerness";
import { activeConfig, allConfigs, cancelRequests, ENABLED_KEY, forgetConfig, isAutomaticEnabled, isCollectEnabled, isSnoozed, OVERRIDE_KEY, type Runtime, saveConfig, showActive, storedConfigs, toggleSnooze } from "./runtime";
import { describeTiming } from "./timing";

const FORMATS = [
  { label: "fim", detail: "fill in the middle, completes where the cursor is" },
  { label: "next-edit", detail: "rewrites a window of code, and can propose an edit in another file" },
  { label: "zeta", detail: "zed's zeta 2.1 layout: numbered blocks around the cursor, edit history as unified diffs" },
];

const ask = async (title: string, prompt: string, options: {
  value?: string;
  placeHolder?: string;
  password?: boolean;
  taken?: string[];
}): Promise<string | undefined> =>
  vscode.window.showInputBox({
    title,
    prompt,
    ignoreFocusOut: true,
    ...(options.value !== undefined && { value: options.value }),
    ...(options.placeHolder !== undefined && { placeHolder: options.placeHolder }),
    ...(options.password !== undefined && { password: options.password }),
    validateInput: value =>
      ((options.taken ?? []).includes(value.trim()) ? `${value.trim()} is already configured` : undefined),
  });

type Existing = { name: string; raw: Record<string, unknown>; };

const stringOf = (raw: Record<string, unknown>, key: string): string => {
  const value = raw[key];

  return typeof value === "string" ? value : "";
};

/**
 * The same five steps add a configuration or edit one held in extension storage. Editing
 * keeps the stored key unless a new one is typed, since the old one cannot be shown back.
 */
const askConfig = async (runtime: Runtime, existing: Existing | undefined): Promise<void> => {
  const verb = existing === undefined ? "add" : "edit";
  const held = existing?.raw ?? {};
  const endpoint = await ask(`tablet: ${verb} a configuration (1 of 5)`, "Endpoint of an OpenAI compatible server. The request goes to {endpoint}/completions.", {
    placeHolder: "http://127.0.0.1:8080/v1",
    value: stringOf(held, "endpoint"),
  });

  if (endpoint === undefined || endpoint.trim() === "") return;

  const key = await ask(`tablet: ${verb} a configuration (2 of 5)`, existing === undefined
    ? "Api key. Leave empty if the endpoint needs none."
    : "Api key. Leave empty to keep the stored one.", {
    password: true,
  });

  if (key === undefined) return;

  const model = await ask(`tablet: ${verb} a configuration (3 of 5)`, "Model name to send with each request.", {
    placeHolder: "qwen2.5-coder-7b",
    value: stringOf(held, "model"),
  });

  if (model === undefined || model.trim() === "") return;

  const format = await vscode.window.showQuickPick(FORMATS, {
    title: `tablet: ${verb} a configuration (4 of 5)`,
    placeHolder: `How should tablet talk to this model?${existing === undefined ? "" : ` Now ${stringOf(held, "format")}.`}`,
    ignoreFocusOut: true,
  });

  if (format === undefined) return;

  const taken = allConfigs(runtime).configurations.map(held => held.name).filter(name => name !== existing?.name);
  const name = await ask(`tablet: ${verb} a configuration (5 of 5)`, "Name for this configuration.", {
    value: existing?.name ?? model.trim(),
    taken,
  });

  if (name === undefined || name.trim() === "" || taken.includes(name.trim())) return;

  const settled = name.trim();

  if (existing !== undefined && existing.name !== settled) {
    await forgetConfig(runtime, existing.name);

    const oldKey = await runtime.secrets.get(existing.name);

    if (oldKey !== undefined) {
      await runtime.secrets.store(settled, oldKey);
      await runtime.secrets.delete(existing.name);
    }
  }

  if (key !== "") await runtime.secrets.store(settled, key);

  const hasKey = key !== "" || stringOf(held, "apiKey") !== "";

  await saveConfig(runtime, settled, {
    ...held,
    endpoint: endpoint.trim(),
    model: model.trim(),
    format: format.label,
    ...(hasKey && { apiKey: `secretstorage/${settled}` }),
  });

  await runtime.memento.update(OVERRIDE_KEY, settled);
};

const addConfig = (runtime: Runtime): Promise<void> => askConfig(runtime, undefined);

/** A stored configuration edits in place. One from settings.json is edited where it lives. */
const editConfig = async (runtime: Runtime, name: string): Promise<void> => {
  const raw = storedConfigs(runtime)[name];

  if (raw !== undefined && typeof raw === "object" && !Array.isArray(raw)) {
    await askConfig(runtime, { name, raw: raw as Record<string, unknown> });

    return;
  }

  await vscode.commands.executeCommand("workbench.action.openSettingsJson", { revealSetting: { key: "tablet.configurations" } });
};

const pickConfig = async (runtime: Runtime): Promise<void> => {
  const parsed = allConfigs(runtime);

  if (parsed.configurations.length === 0) {
    const add = "Add a configuration";
    const chosen = await vscode.window.showWarningMessage(
      parsed.problems.length > 0 ? `tablet: ${parsed.problems.join("; ")}` : "tablet has no configuration yet.",
      add,
    );

    if (chosen === add) await addConfig(runtime);

    return;
  }

  const settings = vscode.workspace.getConfiguration("tablet");
  const active = runtime.memento.get<string>(OVERRIDE_KEY) ?? settings.get<string>("activeConfiguration") ?? "";
  const stored = new Set(Object.keys(storedConfigs(runtime)));
  const editButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("edit"), tooltip: "Edit this configuration" };

  type PickItem = vscode.QuickPickItem & { action: { kind: "select"; name: string; } | { kind: "add"; }; };

  const items: PickItem[] = [
    ...parsed.configurations.map((held): PickItem => ({
      label: held.name,
      description: `${held.format}, ${held.model}`,
      detail: [
        held.name === active ? "in use" : "",
        stored.has(held.name) ? "added here" : "from settings.json",
      ].filter(part => part !== "").join(", "),
      buttons: [editButton],
      action: { kind: "select", name: held.name },
    })),
    { label: "", kind: vscode.QuickPickItemKind.Separator, action: { kind: "add" } },
    { label: "$(add) Add a configuration", action: { kind: "add" } },
  ];

  const picker = vscode.window.createQuickPick<PickItem>();

  picker.title = "tablet: select configuration";
  picker.placeholder = "Pick one to use, or the pencil to edit it";
  picker.items = items;

  const chosen = await new Promise<{ kind: "pick"; item: PickItem; } | { kind: "edit"; name: string; } | undefined>((resolve) => {
    picker.onDidAccept(() => resolve(picker.selectedItems[0] === undefined ? undefined : { kind: "pick", item: picker.selectedItems[0] }));
    picker.onDidTriggerItemButton(event => resolve({ kind: "edit", name: event.item.label }));
    picker.onDidHide(() => resolve(undefined));
    picker.show();
  });

  picker.dispose();

  if (chosen === undefined) return;

  if (chosen.kind === "edit") {
    await editConfig(runtime, chosen.name);

    return;
  }

  if (chosen.item.action.kind === "add") {
    await addConfig(runtime);

    return;
  }

  await runtime.memento.update(OVERRIDE_KEY, chosen.item.action.name);
};

const removeConfig = async (runtime: Runtime): Promise<void> => {
  const names = Object.keys(storedConfigs(runtime));

  if (names.length === 0) {
    await vscode.window.showInformationMessage(
      "tablet: nothing to remove. Configurations in settings.json are removed by editing settings.json.",
    );

    return;
  }

  const picked = await vscode.window.showQuickPick(names, { title: "tablet: remove a configuration" });

  if (picked === undefined) return;

  await forgetConfig(runtime, picked);
  await runtime.secrets.delete(picked);

  if (runtime.memento.get<string>(OVERRIDE_KEY) === picked) await runtime.memento.update(OVERRIDE_KEY, undefined);
};

const storeKey = async (runtime: Runtime): Promise<void> => {
  const name = await ask("tablet: store a named key", "Name to store it under. A configuration refers to it as secretstorage/NAME.", {});

  if (name === undefined || name.trim() === "") return;

  const value = await ask(`tablet: key for ${name.trim()}`, "The key itself.", { password: true });

  if (value === undefined || value === "") return;

  await runtime.secrets.store(name.trim(), value);
};

const forgetKey = async (runtime: Runtime): Promise<void> => {
  const name = await ask("tablet: forget a named key", "Name it was stored under.", {});

  if (name === undefined || name.trim() === "") return;

  await runtime.secrets.delete(name.trim());
};

const toggleEnabled = async (runtime: Runtime): Promise<void> => {
  await runtime.memento.update(ENABLED_KEY, !isAutomaticEnabled(runtime));
  cancelRequests(runtime);
  showActive(runtime);
};

/**
 * Written to the workspace when there is one, so opting in is a decision per repository
 * and a client's code stays out of the set unless it was asked for.
 */
const toggleCollect = async (): Promise<void> => {
  const target = vscode.workspace.workspaceFolders === undefined
    ? vscode.ConfigurationTarget.Global
    : vscode.ConfigurationTarget.Workspace;

  await vscode.workspace.getConfiguration("tablet").update("collect", !isCollectEnabled(), target);
};

/** Written where the value is defined now, so a workspace value never shadows the choice. */
const setEagerness = async (level: unknown): Promise<void> => {
  const setting = EAGERNESS_SETTINGS.find(held => held === level);

  if (setting === undefined) return;

  const settings = vscode.workspace.getConfiguration("tablet");
  const target = settings.inspect("eagerness")?.workspaceValue === undefined
    ? vscode.ConfigurationTarget.Global
    : vscode.ConfigurationTarget.Workspace;

  await settings.update("eagerness", setting, target);
};

const openDataFolder = async (runtime: Runtime): Promise<void> => {
  const root = collectRoot(runtime.globalStoragePath);

  await mkdir(root, { recursive: true });
  await vscode.env.openExternal(vscode.Uri.file(root));
};

const exportDataset = async (runtime: Runtime): Promise<void> => {
  const exported = await exportRecords(runtime.globalStoragePath, new Date().toISOString());
  const reveal = "Reveal";
  const chosen = await vscode.window.showInformationMessage(`tablet: ${exported.count} record(s) written to ${exported.file}`, reveal);

  if (chosen === reveal) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(exported.file));
};

/**
 * The editor shows one inline edit at a time and only cycles ghost text itself, so
 * another edit is shown by moving it to the front of what tablet holds and asking again,
 * which re-serves the held suggestions in the new order.
 */
const cycleEdits = async (runtime: Runtime, step: 1 | -1): Promise<void> => {
  const served = runtime.lastServed;

  if (served === undefined) return;

  const edits = served.suggestions.filter(held => held.kind !== "completion");

  if (edits.length < 2) return;

  const shift = (step + edits.length) % edits.length;
  const completions = served.suggestions.filter(held => held.kind === "completion");

  runtime.lastServed = { ...served, suggestions: [...edits.slice(shift), ...edits.slice(0, shift), ...completions] };
  await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
};

type MenuItem = vscode.QuickPickItem & { command?: string; };

const toggleIcon = (isOn: boolean): string => (isOn ? "$(pass-filled)" : "$(circle-large-outline)");

/** What the status bar click opens: the two switches first, then the places to go. */
const showMenu = async (runtime: Runtime): Promise<void> => {
  const isOn = isAutomaticEnabled(runtime);
  const isCollecting = isCollectEnabled();
  const active = activeConfig(runtime);

  const items: MenuItem[] = [
    {
      label: `${toggleIcon(isOn)} Automatic suggestions`,
      description: isOn ? "on" : "off, manual trigger still works",
      command: "tablet.toggleEnabled",
    },
    {
      label: `${toggleIcon(isSnoozed(runtime))} Snooze for a minute`,
      description: isSnoozed(runtime) ? "snoozed, pick to resume" : "mutes automatic suggestions",
      command: "tablet.snooze",
    },
    {
      label: `${toggleIcon(isCollecting)} Data collection`,
      description: isCollecting ? "on, local only" : "off",
      detail: "Records each suggestion, its prompt, and what you did next, under this machine's extension storage.",
      command: "tablet.toggleCollect",
    },
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(list-selection) Select configuration",
      description: active.configuration?.name ?? "none selected",
      command: "tablet.selectConfiguration",
    },
    { label: "$(folder-opened) Open data folder", command: "tablet.openDataFolder" },
    { label: "$(package) Export collected records", command: "tablet.exportDataset" },
    { label: "$(output) Show log", command: "tablet.showLog" },
  ];

  const picked = await vscode.window.showQuickPick(items, { title: "tablet", placeHolder: "Toggle a switch or open a view" });

  if (picked?.command !== undefined) await vscode.commands.executeCommand(picked.command);
};

const refreshAfter = async (runtime: Runtime, action: () => Thenable<unknown>): Promise<void> => {
  await action();
  showActive(runtime);
};

export const registerCommands = (runtime: Runtime): vscode.Disposable[] => [
  vscode.commands.registerCommand("tablet.addConfiguration", () => refreshAfter(runtime, () => addConfig(runtime))),
  vscode.commands.registerCommand("tablet.selectConfiguration", () => refreshAfter(runtime, () => pickConfig(runtime))),
  vscode.commands.registerCommand("tablet.removeConfiguration", () => refreshAfter(runtime, () => removeConfig(runtime))),
  vscode.commands.registerCommand("tablet.clearConfigurationOverride", () => refreshAfter(runtime, () => runtime.memento.update(OVERRIDE_KEY, undefined))),
  vscode.commands.registerCommand("tablet.setEagerness", (level: unknown) => setEagerness(level)),
  vscode.commands.registerCommand("tablet.toggleEnabled", () => toggleEnabled(runtime)),
  vscode.commands.registerCommand("tablet.trigger", () => {
    runtime.declined = undefined;

    return vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
  }),
  // Also bound to the suggestions key, so pressing it asks tablet. package.json binds it only
  // while no suggestion is visible.
  vscode.commands.registerCommand("tablet.suggestNow", async () => {
    runtime.declined = undefined;

    await Promise.all([
      vscode.commands.executeCommand("editor.action.triggerSuggest"),
      vscode.commands.executeCommand("editor.action.inlineSuggest.trigger"),
    ]);
  }),
  vscode.commands.registerCommand("tablet.storeKey", () => storeKey(runtime)),
  vscode.commands.registerCommand("tablet.forgetKey", () => forgetKey(runtime)),
  vscode.commands.registerCommand("tablet.showLog", () => runtime.output.show(true)),
  vscode.commands.registerCommand("tablet.showTiming", () => {
    // Written regardless of log level: the reader asked for this report.
    runtime.output.appendLine("timing of recent asks, from the keystroke the editor reported:");

    for (const line of describeTiming(runtime.timing)) runtime.output.appendLine(`  ${line}`);

    runtime.output.show(true);
  }),
  vscode.commands.registerCommand("tablet.menu", () => showMenu(runtime)),
  vscode.commands.registerCommand("tablet.toggleCollect", () => toggleCollect()),
  vscode.commands.registerCommand("tablet.openDataFolder", () => openDataFolder(runtime)),
  vscode.commands.registerCommand("tablet.exportDataset", () => exportDataset(runtime)),
  vscode.commands.registerCommand("tablet.snooze", () => toggleSnooze(runtime)),
  vscode.commands.registerCommand("tablet.nextSuggestion", () => cycleEdits(runtime, 1)),
  vscode.commands.registerCommand("tablet.previousSuggestion", () => cycleEdits(runtime, -1)),
];
