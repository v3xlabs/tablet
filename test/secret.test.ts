import { describe, expect, it } from "vitest";

import { parseSecretSpec, resolveSecret, type SecretSource } from "../src/secret";

const source = (environment: Record<string, string | undefined>, stored?: string): SecretSource => ({
  environment,
  read: async () => stored,
});

describe("parseSecretSpec", () => {
  it("reads an environment reference", () => {
    expect(parseSecretSpec("os.environ/MY_KEY")).toEqual({ kind: "env", name: "MY_KEY" });
  });

  it("reads a secret storage reference", () => {
    expect(parseSecretSpec("secretstorage/work")).toEqual({ kind: "storage", name: "work" });
  });

  it("treats anything else as the key itself", () => {
    expect(parseSecretSpec("sk-abc")).toEqual({ kind: "literal", value: "sk-abc" });
  });
});

describe("resolveSecret", () => {
  it("reads the environment", async () => {
    const result = await resolveSecret({ kind: "env", name: "K" }, source({ K: "v" }));

    expect(result).toEqual({ ok: true, value: "v" });
  });

  it("names the variable that is missing", async () => {
    const result = await resolveSecret({ kind: "env", name: "K" }, source({}));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain("K");
  });

  it("reads secret storage", async () => {
    const result = await resolveSecret({ kind: "storage", name: "work" }, source({}, "stored"));

    expect(result).toEqual({ ok: true, value: "stored" });
  });

  it("treats an empty stored key as missing", async () => {
    const result = await resolveSecret({ kind: "storage", name: "work" }, source({}, ""));

    expect(result.ok).toBe(false);
  });
});
