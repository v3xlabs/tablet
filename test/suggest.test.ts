import { describe, expect, it } from "vitest";

import { emptyCache } from "../src/cache";
import { parseConfigurations } from "../src/config";
import type { CompletionResult } from "../src/endpoint";
import type { Snapshot } from "../src/snapshot";
import { focusLine, suggest, type Suggestion } from "../src/suggest";

const config = (raw: Record<string, unknown>) => {
  const parsed = parseConfigurations({ one: raw });
  const first = parsed.configurations[0];

  if (first === undefined) throw new Error(parsed.problems.join("; "));

  return first;
};

const fim = config({ endpoint: "http://x/v1", model: "m", format: "fim" });
const nextEdit = config({ endpoint: "http://x/v1", model: "m", format: "next-edit", windowLines: 40 });
const noCrossFile = config({ endpoint: "http://x/v1", model: "m", format: "next-edit", crossFileCandidates: 0 });

const snapshot: Snapshot = {
  path: "src/user.ts",
  languageId: "typescript",
  lines: ["const greeting = ", "const other = 2;"],
  cursorLine: 0,
  cursorCharacter: 17,
};

const dependencies = (answers: CompletionResult[], files: Record<string, string[]> = {}) => {
  const prompts: string[] = [];

  return {
    prompts,
    deps: {
      complete: async (prompt: string) => {
        prompts.push(prompt);

        return answers[Math.min(prompts.length - 1, answers.length - 1)] ?? { ok: true as const, texts: [] };
      },
      readFile: async (path: string) => files[path],
      cache: emptyCache<Suggestion[]>(8),
    },
  };
};

const input = (overrides: Partial<Parameters<typeof suggest>[0]>) => ({
  configuration: fim,
  snapshot,
  chunks: [],
  changes: [],
  repo: "tablet",
  previousLines: undefined,
  candidatePaths: [],
  ...overrides,
});

describe("suggest, fill in the middle", () => {
  it("returns one suggestion per distinct choice", async () => {
    const { deps: d } = dependencies([{ ok: true, texts: ["\"hello\";", "\"hi\";", "\"hello\";"] }]);
    const result = await suggest(input({}), d);

    expect(result).toEqual({
      kind: "suggestions",
      suggestions: [
        { kind: "completion", text: "\"hello\";" },
        { kind: "completion", text: "\"hi\";" },
      ],
    });
  });

  it("answers a repeated request from the cache", async () => {
    const { prompts, deps: d } = dependencies([{ ok: true, texts: ["\"hello\";"] }]);

    await suggest(input({}), d);
    await suggest(input({}), d);

    expect(prompts).toHaveLength(1);
  });

  it("reports nothing when every choice is filtered out", async () => {
    const { deps: d } = dependencies([{ ok: true, texts: [" ".repeat(3), ""] }]);

    expect(await suggest(input({}), d)).toEqual({ kind: "none" });
  });

  it("passes an endpoint failure back", async () => {
    const { deps: d } = dependencies([{ ok: false, failure: { kind: "timeout" } }]);

    expect(await suggest(input({}), d)).toEqual({ kind: "failure", failure: { kind: "timeout" } });
  });

  it("reports a template it cannot fill", async () => {
    const { deps: d } = dependencies([{ ok: true, texts: ["x"] }]);
    const broken = { ...fim, template: "{{prefix}}{{nonsense}}" };

    expect(await suggest(input({ configuration: broken }), d)).toEqual({ kind: "invalid", unknown: ["nonsense"] });
  });
});

describe("suggest, next edit", () => {
  const editable: Snapshot = {
    path: "src/user.ts",
    languageId: "typescript",
    lines: ["type User = {", "  displayName: string;", "};"],
    cursorLine: 1,
    cursorCharacter: 13,
  };

  it("turns a rewritten window into an edit", async () => {
    const { deps: d } = dependencies([{ ok: true, texts: ["type User = {\n  displayName: number;\n};"] }]);
    const result = await suggest(input({ configuration: nextEdit, snapshot: editable }), d);

    expect(result).toEqual({
      kind: "suggestions",
      suggestions: [{ kind: "edit", path: "src/user.ts", startLine: 1, endLine: 2, text: "  displayName: number;" }],
    });
  });

  it("asks about another file when the local window comes back unchanged", async () => {
    const unchanged = { ok: true as const, texts: ["type User = {\n  displayName: string;\n};"] };
    const elsewhere = { ok: true as const, texts: ["export const greet = (u: User) => u.displayName;"] };

    const { prompts, deps: d } = dependencies([unchanged, elsewhere], {
      "src/greet.ts": ["export const greet = (u: User) => u.name;"],
    });

    const result = await suggest(
      input({
        configuration: nextEdit,
        snapshot: editable,
        candidatePaths: ["src/greet.ts"],
        changes: [{ path: "src/user.ts", before: "  name: string;", after: "  displayName: string;" }],
      }),
      d,
    );

    expect(prompts).toHaveLength(2);
    expect(result).toEqual({
      kind: "suggestions",
      suggestions: [{
        kind: "edit",
        path: "src/greet.ts",
        startLine: 0,
        endLine: 1,
        text: "export const greet = (u: User) => u.displayName;",
      }],
    });
  });

  it("stops at the local answer when there is one", async () => {
    const { prompts, deps: d } = dependencies([{ ok: true, texts: ["type User = {\n  displayName: number;\n};"] }], {
      "src/greet.ts": ["export const greet = (u: User) => u.name;"],
    });

    await suggest(input({ configuration: nextEdit, snapshot: editable, candidatePaths: ["src/greet.ts"] }), d);

    expect(prompts).toHaveLength(1);
  });

  it("does not ask about other files when the budget is zero", async () => {
    const { prompts, deps: d } = dependencies([{ ok: true, texts: ["type User = {\n  displayName: string;\n};"] }], {
      "src/greet.ts": ["export const greet = (u: User) => u.name;"],
    });

    await suggest(
      input({
        configuration: noCrossFile,
        snapshot: editable,
        candidatePaths: ["src/greet.ts"],
      }),
      d,
    );

    expect(prompts).toHaveLength(1);
  });
});

describe("focusLine", () => {
  it("points at the line still holding the identifier the edit removed", () => {
    const lines = ["import {User} from './user';", "", "const a = user.name;"];
    const changes = [{ path: "src/user.ts", before: "  name: string;", after: "  displayName: string;" }];

    expect(focusLine(lines, changes)).toBe(2);
  });

  it("falls back to the top of the file when nothing was removed", () => {
    expect(focusLine(["a", "b"], [])).toBe(0);
  });
});
