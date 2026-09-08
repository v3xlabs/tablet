import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CollectedRecord, redactRecord } from "../src/collect/record";
import { appendRecord, collectRoot, exportRecords } from "../src/collect/store";

const record: CollectedRecord = {
  recordId: "r1",
  timestamp: "2026-09-08T12:00:00.000Z",
  workspace: "tablet",
  path: "src/config.ts",
  languageId: "typescript",
  config: "sweep",
  format: "next-edit",
  cursor: { line: 3, character: 4 },
  window: { startLine: 0, endLine: 4, text: "const key = \"AKIAIOSFODNN7EXAMPLE\";\nconst other = 1;" },
  events: [{ path: "src/config.ts", line: 0, isPredicted: false, before: "password = \"hunter2hunter2\"", after: "password = \"hunter2hunter3\"" }],
  diagnostics: [],
  chunks: [{ path: "src/a.ts", startLine: 0, lines: ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"] }],
  exchanges: [{ prompt: "AKIAIOSFODNN7EXAMPLE", reply: { ok: true, texts: ["AKIAIOSFODNN7EXAMPLE"] }, ms: 12 }],
  suggestions: [{ kind: "completion", text: "AKIAIOSFODNN7EXAMPLE" }],
  outcome: { kind: "rejected" },
  resolution: { kind: "edited", after: "AKIAIOSFODNN7EXAMPLE" },
};

describe("redactRecord", () => {
  it("redacts every string that came from a file", () => {
    const text = JSON.stringify(redactRecord(record));

    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(text).toContain("const other = 1;");
  });
});

describe("store", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(process.cwd(), ".tmp", "collect-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("appends one line per record to a day file per workspace", async () => {
    const first = await appendRecord(root, record);
    const second = await appendRecord(root, { ...record, recordId: "r2" });

    expect(first).toBe(second);
    expect(first).toBe(path.join(collectRoot(root), "tablet", "2026-09-08.jsonl"));

    const text = await readFile(first, "utf8");
    const lines = text.trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ recordId: "r2", outcome: { kind: "rejected" } });
  });

  it("exports every day file into one, and leaves earlier exports out of the next", async () => {
    await appendRecord(root, record);
    await appendRecord(root, { ...record, recordId: "r2", timestamp: "2026-09-09T01:00:00.000Z" });
    await appendRecord(root, { ...record, recordId: "r3", workspace: "other" });

    const first = await exportRecords(root, "2026-09-09T02:00:00.000Z");

    expect(first.count).toBe(3);

    const second = await exportRecords(root, "2026-09-09T03:00:00.000Z");

    expect(second.count).toBe(3);
    const exported = await readFile(second.file, "utf8");

    expect(exported.trim().split("\n")).toHaveLength(3);
  });
});
