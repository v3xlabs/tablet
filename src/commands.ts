import * as vscode from "vscode";

import { parseConfigurations } from "./config";
import { ENABLED_KEY, OVERRIDE_KEY, type Runtime } from "./runtime";

const pickConfig = async (runtime: Runtime): Promise<void> => {
  const settings = vscode.workspace.getConfiguration("tablet");
  const parsed = parseConfigurations(settings.get("configurations") ?? {});

  if (parsed.configurations.length === 0) {
    await vscode.window.showWarningMessage(
      parsed.problems.length > 0
        ? `tablet: ${parsed.problems.join("; ")}`
        : "tablet: no configurations are defined under tablet.configurations",
    );

    return;
  }

  const active = runtime.memento.get<string>(OVERRIDE_KEY) ?? settings.get<string>("activeConfiguration") ?? "";

  const picked = await vscode.window.showQuickPick(
    parsed.configurations.map(config => ({
      label: config.name,
      description: `${config.format}, ${config.model}`,
      ...((config.name === active) && { detail: "in use" }),
    })),
    { title: "tablet: select configuration" },
  );

  if (picked === undefined) return;

  await runtime.memento.update(OVERRIDE_KEY, picked.label);
};

const setApiKey = async (runtime: Runtime): Promise<void> => {
  const name = await vscode.window.showInputBox({
    title: "tablet: set an api key",
    prompt: "Name to store it under. Refer to it as secretstorage/NAME in a configuration.",
  });

  if (name === undefined || name === "") return;

  const value = await vscode.window.showInputBox({ title: `tablet: key for ${name}`, password: true });

  if (value === undefined || value === "") return;

  await runtime.secrets.store(name, value);
};

const clearApiKey = async (runtime: Runtime): Promise<void> => {
  const name = await vscode.window.showInputBox({ title: "tablet: clear an api key", prompt: "Name it was stored under" });

  if (name === undefined || name === "") return;

  await runtime.secrets.delete(name);
};

const toggleEnabled = async (runtime: Runtime): Promise<void> => {
  const setting = vscode.workspace.getConfiguration("tablet").get<boolean>("enabled") ?? true;
  const now = runtime.memento.get<boolean>(ENABLED_KEY) ?? setting;

  await runtime.memento.update(ENABLED_KEY, !now);

  await vscode.window.showInformationMessage(`tablet: automatic suggestions ${now ? "off" : "on"}`);
};

export const registerCommands = (runtime: Runtime): vscode.Disposable[] => [
  vscode.commands.registerCommand("tablet.selectConfiguration", () => pickConfig(runtime)),
  vscode.commands.registerCommand("tablet.clearConfigurationOverride", () => runtime.memento.update(OVERRIDE_KEY, undefined)),
  vscode.commands.registerCommand("tablet.toggleEnabled", () => toggleEnabled(runtime)),
  vscode.commands.registerCommand("tablet.trigger", () => vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")),
  vscode.commands.registerCommand("tablet.setApiKey", () => setApiKey(runtime)),
  vscode.commands.registerCommand("tablet.clearApiKey", () => clearApiKey(runtime)),
  vscode.commands.registerCommand("tablet.showLog", () => runtime.output.show(true)),
];
