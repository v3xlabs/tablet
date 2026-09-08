import { describe, expect, it } from "vitest";

import { parseConfigurations } from "../src/config";
import { speculativeInput } from "../src/speculate";
import type { SuggestInput } from "../src/suggest";

const config = parseConfigurations({ z: { endpoint: "http://x/v1", model: "m", format: "zeta" } }).configurations[0];

if (config === undefined) throw new Error("config");

const input: SuggestInput = {
  configuration: config,
  budget: 3000,
  snapshot: { path: "src/a.ts", languageId: "typescript", lines: ["const a = ", "const b = 2;"], cursorLine: 0, cursorCharacter: 10 },
  chunks: [],
  changes: [{ path: "src/a.ts", line: 0, isPredicted: false, before: "const ", after: "const a = " }],
  diagnostics: [],
  repo: "t",
  previousByPath: new Map(),
  candidatePaths: [],
};

describe("speculativeInput", () => {
  it("applies the edit, moves the cursor to its end, and logs the change as the tracker would", () => {
    const ahead = speculativeInput(input, { kind: "edit", path: "src/a.ts", startLine: 0, startCharacter: 10, endLine: 0, endCharacter: 10, text: "1;\nconst c = 3;" });

    expect(ahead?.snapshot.lines).toEqual(["const a = 1;", "const c = 3;", "const b = 2;"]);
    expect(ahead?.snapshot.cursorLine).toBe(1);
    expect(ahead?.snapshot.cursorCharacter).toBe(12);
    expect(ahead?.changes).toHaveLength(2);
    expect(ahead?.changes[1]).toMatchObject({ path: "src/a.ts", line: 0 });
    expect(ahead?.previousByPath.get("src/a.ts")).toEqual(["const a = ", "const b = 2;"]);
  });

  it("returns nothing for a completion or an edit in another file", () => {
    expect(speculativeInput(input, { kind: "completion", text: "x" })).toBeUndefined();
    expect(speculativeInput(input, { kind: "edit", path: "src/b.ts", startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0, text: "x" })).toBeUndefined();
  });
});
