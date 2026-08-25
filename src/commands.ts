import * as vscode from "vscode";

import { allConfigs, ENABLED_KEY, forgetConfig, OVERRIDE_KEY, type Runtime, saveConfig, storedConfigs } from "./runtime";

const FORMATS = [
  { label: "fim", detail: "fill in the middle, completes where the cursor is" },
  { label: "next-edit", detail: "rewrites a window of code, and can propose an edit in another file" },
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

const addConfig = async (runtime: Runtime): Promise<void> => {
  const endpoint = await ask("tablet: add a configuration (1 of 5)", "Endpoint of an OpenAI compatible server. The request goes to {endpoint}/completions.", {
    placeHolder: "http://127.0.0.1:8080/v1",
  });

  if (endpoint === undefined || endpoint.trim() === "") return;

  const key = await ask("tablet: add a configuration (2 of 5)", "Api key. Leave empty if the endpoint needs none.", {
    password: true,
  });

  if (key === undefined) return;

  const model = await ask("tablet: add a configuration (3 of 5)", "Model name to send with each request.", {
    placeHolder: "qwen2.5-coder-7b",
  });

  if (model === undefined || model.trim() === "") return;

  const format = await vscode.window.showQuickPick(FORMATS, {
    title: "tablet: add a configuration (4 of 5)",
    placeHolder: "How should tablet talk to this model?",
    ignoreFocusOut: true,
  });

  if (format === undefined) return;

  const taken = allConfigs(runtime).configurations.map(held => held.name);
  const name = await ask("tablet: add a configuration (5 of 5)", "Name for this configuration.", {
    value: model.trim(),
    taken,
  });

  if (name === undefined || name.trim() === "" || taken.includes(name.trim())) return;

  const settled = name.trim();

  if (key !== "") await runtime.secrets.store(settled, key);

  await saveConfig(runtime, settled, {
    endpoint: endpoint.trim(),
    model: model.trim(),
    format: format.label,
    ...(key !== "" && { apiKey: `secretstorage/${settled}` }),
  });

  await runtime.memento.update(OVERRIDE_KEY, settled);
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

  const picked = await vscode.window.showQuickPick(
    parsed.configurations.map(held => ({
      label: held.name,
      description: `${held.format}, ${held.model}`,
      detail: [
        held.name === active ? "in use" : "",
        stored.has(held.name) ? "added here" : "from settings.json",
      ].filter(part => part !== "").join(", "),
    })),
    { title: "tablet: select configuration" },
  );

  if (picked === undefined) return;

  await runtime.memento.update(OVERRIDE_KEY, picked.label);
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
  const setting = vscode.workspace.getConfiguration("tablet").get<boolean>("enabled") ?? true;
  const now = runtime.memento.get<boolean>(ENABLED_KEY) ?? setting;

  await runtime.memento.update(ENABLED_KEY, !now);

  await vscode.window.showInformationMessage(`tablet: automatic suggestions ${now ? "off" : "on"}`);
};

export const registerCommands = (runtime: Runtime): vscode.Disposable[] => [
  vscode.commands.registerCommand("tablet.addConfiguration", () => addConfig(runtime)),
  vscode.commands.registerCommand("tablet.selectConfiguration", () => pickConfig(runtime)),
  vscode.commands.registerCommand("tablet.removeConfiguration", () => removeConfig(runtime)),
  vscode.commands.registerCommand("tablet.clearConfigurationOverride", () => runtime.memento.update(OVERRIDE_KEY, undefined)),
  vscode.commands.registerCommand("tablet.toggleEnabled", () => toggleEnabled(runtime)),
  vscode.commands.registerCommand("tablet.trigger", () => vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")),
  vscode.commands.registerCommand("tablet.storeKey", () => storeKey(runtime)),
  vscode.commands.registerCommand("tablet.forgetKey", () => forgetKey(runtime)),
  vscode.commands.registerCommand("tablet.showLog", () => runtime.output.show(true)),
];
