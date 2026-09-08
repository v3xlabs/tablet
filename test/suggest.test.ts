import { describe, expect, it } from "vitest";

import { emptyCache } from "../src/cache";
import { parseConfigurations } from "../src/config";
import { focusLine } from "../src/context/recent-files";
import type { CompletionResult } from "../src/endpoint";
import type { Snapshot } from "../src/snapshot";
import { suggest, type Suggestion } from "../src/suggest";

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
      diagnosticsFor: () => [],
      cache: emptyCache<Suggestion[]>(8),
    },
  };
};

const input = (overrides: Partial<Parameters<typeof suggest>[0]>) => ({
  configuration: fim,
  budget: 6000,
  snapshot,
  chunks: [],
  changes: [],
  diagnostics: [],
  repo: "tablet",
  previousByPath: new Map<string, string[]>(),
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

    expect(await suggest(input({}), d)).toEqual({ kind: "none", reason: "every completion was discarded as unusable" });
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
    const result = await suggest(input({
      configuration: nextEdit,
      snapshot: editable,
      diagnostics: [{ line: 1, character: 15, severity: "error", source: "ts", message: "Type 'string' is not assignable to type 'number'." }],
    }), d);

    expect(result).toEqual({
      kind: "suggestions",
      suggestions: [{
        kind: "edit",
        path: "src/user.ts",
        startLine: 1,
        startCharacter: 15,
        endLine: 1,
        endCharacter: 21,
        text: "number",
      }],
    });
  });

  it("carries a deletion through as an empty replacement", async () => {
    const emptied: Snapshot = {
      path: "src/test.ts",
      languageId: "typescript",
      lines: ["const a = 1;", "", "", "};"],
      cursorLine: 0,
      cursorCharacter: 12,
    };

    const { deps: d } = dependencies([{ ok: true, texts: ["const a = 1;"] }]);
    const result = await suggest(input({
      configuration: nextEdit,
      snapshot: emptied,
      changes: [{ path: "src/test.ts", line: 0, isPredicted: false, before: "const a = 1;\n\n", after: "const a = 1;" }],
    }), d);

    expect(result).toEqual({
      kind: "suggestions",
      suggestions: [{
        kind: "edit",
        path: "src/test.ts",
        startLine: 0,
        startCharacter: 12,
        endLine: 3,
        endCharacter: 2,
        text: "",
      }],
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
        changes: [{ path: "src/user.ts", line: 0, isPredicted: false, before: "  name: string;", after: "  displayName: string;" }],
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
        startCharacter: 36,
        endLine: 0,
        endCharacter: 37,
        text: "displayN",
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

  it("shows a recently edited candidate its pre-burst text as the original window", async () => {
    const unchanged = { ok: true as const, texts: ["type User = {\n  displayName: string;\n};"] };
    const elsewhere = { ok: true as const, texts: ["export const greet = (u: User) => u.displayName;"] };

    const { prompts, deps: d } = dependencies([unchanged, elsewhere], {
      "src/greet.ts": ["export const greet = (u: User) => u.name;"],
    });

    await suggest(
      input({
        configuration: nextEdit,
        snapshot: editable,
        candidatePaths: ["src/greet.ts"],
        changes: [{ path: "src/user.ts", line: 0, isPredicted: false, before: "  name: string;", after: "  displayName: string;" }],
        previousByPath: new Map([["src/greet.ts", ["export const greet = (u: User) => u.OLD;"]]]),
      }),
      d,
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("original/src/greet.ts");
    expect(prompts[1]).toContain("export const greet = (u: User) => u.OLD;");
  });
});

describe("suggest, asking around a diagnostic", () => {
  const lines = Array.from({ length: 40 }, (_, index) => (index === 30 ? "const x30 = ;" : `const x${index} = ${index};`));

  const farFault: Snapshot = {
    path: "src/list.ts",
    languageId: "typescript",
    lines,
    cursorLine: 2,
    cursorCharacter: 5,
  };

  const diagnostics = [{ line: 30, character: 12, severity: "error", source: "ts", message: "Expression expected." }];

  it("asks a second window around a far diagnostic when the cursor window is clean", async () => {
    const unchanged = { ok: true as const, texts: [lines.slice(0, 21).join("\n")] };
    const fixed = { ok: true as const, texts: [lines.slice(20, 40).map(line => (line === "const x30 = ;" ? "const x30 = 30;" : line))
      .join("\n")] };

    const { prompts, deps: d } = dependencies([unchanged, fixed]);
    const result = await suggest(input({ configuration: noCrossFile, snapshot: farFault, diagnostics }), d);

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain("<|cursor|>");
    expect(result).toEqual({
      kind: "suggestions",
      suggestions: [{
        kind: "edit",
        path: "src/list.ts",
        startLine: 30,
        startCharacter: 12,
        endLine: 30,
        endCharacter: 12,
        text: "30",
      }],
    });
  });

  it("leaves the second ask alone when the diagnostic sits at the cursor", async () => {
    const atCursor = { ...farFault, cursorLine: 30, cursorCharacter: 12 };
    const unchanged = { ok: true as const, texts: [lines.slice(20, 40).join("\n")] };
    const { prompts, deps: d } = dependencies([unchanged]);

    await suggest(input({ configuration: noCrossFile, snapshot: atCursor, diagnostics }), d);

    expect(prompts).toHaveLength(1);
  });
});

describe("focusLine", () => {
  it("points at the line still holding the identifier the edit removed", () => {
    const lines = ["import {User} from './user';", "", "const a = user.name;"];
    const changes = [{ path: "src/user.ts", line: 0, isPredicted: false, before: "  name: string;", after: "  displayName: string;" }];

    expect(focusLine(lines, changes)).toBe(2);
  });

  it("falls back to the top of the file when nothing was removed", () => {
    expect(focusLine(["a", "b"], [])).toBe(0);
  });
});

describe("suggest, saying why nothing came back", () => {
  it("names the file the model left alone", async () => {
    const unchanged = { ok: true as const, texts: ["type User = {\n  displayName: string;\n};"] };
    const { deps: d } = dependencies([unchanged]);

    const result = await suggest(
      input({
        configuration: noCrossFile,
        snapshot: {
          path: "src/user.ts",
          languageId: "typescript",
          lines: ["type User = {", "  displayName: string;", "};", ""],
          cursorLine: 1,
          cursorCharacter: 13,
        },
      }),
      d,
    );

    expect(result).toEqual({ kind: "none", reason: "the model returned src/user.ts unchanged" });
  });
});

const tailSnapshot = (lines: string[]): Snapshot => ({
  path: "src/tail.ts",
  languageId: "typescript",
  lines,
  cursorLine: 0,
  cursorCharacter: 12,
});

describe("suggest, refusing a secret file", () => {
  const dotenv: Snapshot = {
    path: ".env",
    languageId: "dotenv",
    lines: ["STRIPE_SECRET_KEY=sk_live_51H8xQ2eZvKYlo2Cabcdefghij", "PORT=3000"],
    cursorLine: 1,
    cursorCharacter: 9,
  };

  it("sends no prompt and says why", async () => {
    const { prompts, deps: d } = dependencies([{ ok: true, texts: ["PORT=3000\nHOST=localhost"] }]);
    const result = await suggest(input({ configuration: nextEdit, snapshot: dotenv }), d);

    expect(prompts).toEqual([]);
    expect(result).toEqual({ kind: "none", reason: "the file holds secrets, so nothing was sent" });
  });

  it("refuses on the completion format too", async () => {
    const { prompts, deps: d } = dependencies([{ ok: true, texts: ["localhost"] }]);

    await suggest(input({ configuration: fim, snapshot: dotenv }), d);

    expect(prompts).toEqual([]);
  });
});

describe("suggest, owning the file tail", () => {
  const settled = { ok: true as const, texts: ["const a = 1;"] };

  it("offers the missing final newline itself once the model settles", async () => {
    const { deps: d } = dependencies([settled]);
    const result = await suggest(input({ configuration: noCrossFile, snapshot: tailSnapshot(["const a = 1;"]) }), d);

    expect(result).toEqual({
      kind: "suggestions",
      suggestions: [{
        kind: "edit",
        path: "src/tail.ts",
        startLine: 0,
        startCharacter: 12,
        endLine: 0,
        endCharacter: 12,
        text: "\n",
      }],
    });
  });

  it("trims a run of blank lines at the end to one", async () => {
    const { deps: d } = dependencies([settled]);
    const result = await suggest(input({ configuration: noCrossFile, snapshot: tailSnapshot(["const a = 1;", "", "", ""]) }), d);

    expect(result).toEqual({
      kind: "suggestions",
      suggestions: [{
        kind: "edit",
        path: "src/tail.ts",
        startLine: 1,
        startCharacter: 0,
        endLine: 3,
        endCharacter: 0,
        text: "",
      }],
    });
  });

  it("stays quiet when the file already ends with one newline", async () => {
    const { deps: d } = dependencies([settled]);
    const result = await suggest(input({ configuration: noCrossFile, snapshot: tailSnapshot(["const a = 1;", ""]) }), d);

    expect(result).toEqual({ kind: "none", reason: "the model returned src/tail.ts unchanged" });
  });
});

describe("suggest, showing recent files to the model", () => {
  it("puts a window of each recent file in the prompt, around what the change removed", async () => {
    const { prompts, deps: d } = dependencies([{ ok: true, texts: ["unchanged"] }], {
      "src/greet.ts": ["import x from \"y\";", "", "const greet = (user) => user.name;"],
    });

    await suggest(
      input({
        configuration: nextEdit,
        candidatePaths: ["src/greet.ts"],
        changes: [{ path: "src/user.ts", line: 0, isPredicted: false, before: "  name: string;", after: "  displayName: string;" }],
      }),
      d,
    );

    expect(prompts[0]).toContain("<|file_sep|>src/greet.ts\n");
    expect(prompts[0]).toContain("const greet = (user) => user.name;");
  });

  it("redacts a secret held in a cross-file candidate before it reaches the prompt", async () => {
    const { prompts, deps: d } = dependencies([{ ok: true, texts: ["unchanged"] }], {
      "src/config.ts": ["export const token = \"ghp_abcdefghijklmnopqrstuvwxyz0123456789AB\";"],
    });

    await suggest(
      input({
        configuration: nextEdit,
        candidatePaths: ["src/config.ts"],
        changes: [{ path: "src/user.ts", line: 0, isPredicted: false, before: "  name: string;", after: "  displayName: string;" }],
      }),
      d,
    );

    expect(prompts[0]).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789AB");
    expect(prompts[0]).toContain("<redacted>");
  });
});

describe("suggest, zeta at a flagged line", () => {
  const zeta = config({ endpoint: "http://x/v1", model: "m", format: "zeta", windowLines: 5, contextFiles: 0 });

  const far: Snapshot = {
    path: "src/far.ts",
    languageId: "typescript",
    lines: Array.from({ length: 40 }, (_unused, index) => (index === 30 ? "const broken = ;" : `const line${index} = ${index};`)),
    cursorLine: 2,
    cursorCharacter: 0,
  };

  it("asks again with the cursor on the diagnostic when the cursor window comes back unchanged", async () => {
    const unchanged = { ok: true as const, texts: ["<|marker_1|><|marker_1|>"] };
    const fixed = { ok: true as const, texts: ["<|marker_1|>const line28 = 28;\nconst line29 = 29;\nconst broken = 0;\nconst line31 = 31;\nconst line32 = 32;\n<|marker_2|>"] };
    const { deps: d, prompts } = dependencies([unchanged, fixed]);
    const result = await suggest(
      input({ configuration: zeta, snapshot: far, diagnostics: [{ line: 30, character: 15, severity: "error", source: "ts", message: "Expression expected." }] }),
      d,
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("const broken = <|user_cursor|>;");
    expect(result).toEqual({
      kind: "suggestions",
      suggestions: [{ kind: "edit", path: "src/far.ts", startLine: 30, startCharacter: 15, endLine: 30, endCharacter: 15, text: "0" }],
    });
  });
});
