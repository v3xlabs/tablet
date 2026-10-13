import { describe, expect, it, vi } from "vitest";

import { registerCommands } from "../src/commands";
import type { Runtime } from "../src/runtime";

const state = vi.hoisted(() => ({
  handlers: new Map<string, () => unknown>(),
  executeCommand: vi.fn(async () => {}),
}));

vi.mock("vscode", () => ({
  commands: {
    registerCommand: (name: string, handler: () => unknown) => {
      state.handlers.set(name, handler);

      return { dispose: vi.fn() };
    },
    executeCommand: state.executeCommand,
  },
}));

describe("suggest now", () => {
  it("opens the suggestions list and asks tablet by hand, lifting an earlier refusal", async () => {
    const runtime = { declined: { path: "source.ts", text: "x" } } as Runtime;

    registerCommands(runtime);
    await state.handlers.get("tablet.suggestNow")?.();

    expect(state.executeCommand).toHaveBeenCalledWith("editor.action.triggerSuggest");
    expect(state.executeCommand).toHaveBeenCalledWith("editor.action.inlineSuggest.trigger");
    expect(runtime.declined).toBeUndefined();
  });
});
