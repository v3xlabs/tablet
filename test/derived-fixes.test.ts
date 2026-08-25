import { describe, expect, it } from "vitest";

import { emptyCache } from "../src/cache";
import { parseConfigurations } from "../src/config";
import type { CompletionResult } from "../src/endpoint";
import type { Snapshot } from "../src/snapshot";
import { suggest, type Suggestion } from "../src/suggest";

const noCrossFile = (() => {
  const parsed = parseConfigurations({ one: { endpoint: "http://x/v1", model: "m", format: "next-edit", crossFileCandidates: 0 } });
  const first = parsed.configurations[0];

  if (first === undefined) throw new Error(parsed.problems.join("; "));

  return first;
})();

const dependencies = (answers: CompletionResult[]) => {
  const prompts: string[] = [];

  return {
    prompts,
    deps: {
      complete: async (prompt: string) => {
        prompts.push(prompt);

        return answers[Math.min(prompts.length - 1, answers.length - 1)] ?? { ok: true as const, texts: [] };
      },
      readFile: async (): Promise<string[] | undefined> => [],
      diagnosticsFor: () => [],
      cache: emptyCache<Suggestion[]>(8),
    },
  };
};

const blank: Snapshot = {
  path: "src/test.ts",
  languageId: "typescript",
  lines: [""],
  cursorLine: 0,
  cursorCharacter: 0,
};

const input = (overrides: Partial<Parameters<typeof suggest>[0]>) => ({
  configuration: noCrossFile,
  snapshot: blank,
  chunks: [],
  changes: [],
  diagnostics: [],
  repo: "tablet",
  previousByPath: new Map<string, string[]>(),
  candidatePaths: [],
  ...overrides,
});

describe("suggest, ranking several corrections from one reply", () => {
  it("puts the fix at the flagged line ahead of an invention further away", async () => {
    const broken: Snapshot = {
      path: "src/test.ts",
      languageId: "typescript",
      lines: ["const hello = () => {", "      log(\"hi\");", "};", "", "const other = 1;"],
      cursorLine: 4,
      cursorCharacter: 16,
    };

    const reply = { ok: true as const, texts: ["const hello = () => {\n  log(\"hi\");\n};\n\nconst other = 1;\n\nhello();"] };
    const { deps: d } = dependencies([reply]);

    const result = await suggest(
      input({
        configuration: noCrossFile,
        snapshot: broken,
        diagnostics: [{ line: 1, character: 0, severity: "warning", source: "eslint", message: "Expected indentation of 2 spaces but found 6." }],
      }),
      d,
    );

    expect(result.kind).toBe("suggestions");

    const suggestions = result.kind === "suggestions" ? result.suggestions : [];

    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toEqual({
      kind: "edit",
      path: "src/test.ts",
      startLine: 1,
      startCharacter: 2,
      endLine: 1,
      endCharacter: 6,
      text: "",
    });
  });

  it("answers a fix on the cursor line without asking the model at all", async () => {
    const trailing: Snapshot = {
      path: "src/test.ts",
      languageId: "typescript",
      lines: ["const hello = () => {", "  log(\"hi\");     ", "};"],
      cursorLine: 1,
      cursorCharacter: 12,
    };

    const { deps: d, prompts } = dependencies([{ ok: true as const, texts: [] }]);
    const result = await suggest(input({ configuration: noCrossFile, snapshot: trailing }), d);

    expect(prompts).toHaveLength(0);
    expect(result).toEqual({
      kind: "suggestions",
      suggestions: [{
        kind: "edit",
        path: "src/test.ts",
        startLine: 1,
        startCharacter: 12,
        endLine: 1,
        endCharacter: 17,
        text: "",
      }],
    });
  });

  it("offers the formatter for drift no diagnostic explains, once the model has nothing", async () => {
    const drifted: Snapshot = {
      path: "src/test.rs",
      languageId: "rust",
      lines: ["fn main() {", "    let a = 1;", "         let b = 2;", "    let c = 3;", "}"],
      cursorLine: 0,
      cursorCharacter: 0,
    };

    const { deps: d } = dependencies([{ ok: true as const, texts: [] }]);
    const result = await suggest(input({ configuration: noCrossFile, snapshot: drifted }), d);

    expect(result).toEqual({ kind: "suggestions", suggestions: [{ kind: "format", path: "src/test.rs" }] });
  });
});
