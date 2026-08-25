import { describe, expect, it } from "vitest";

import { hasSecret, isSecretPath, redactSecrets } from "../src/context/sanitize";

describe("isSecretPath", () => {
  it("flags env files", () => {
    expect(isSecretPath(".env")).toBe(true);
    expect(isSecretPath(".env.local")).toBe(true);
    expect(isSecretPath(".env.production")).toBe(true);
    expect(isSecretPath("config/.env.staging")).toBe(true);
  });

  it("flags key and credential files", () => {
    expect(isSecretPath("keys/id_rsa")).toBe(true);
    expect(isSecretPath("certs/server.pem")).toBe(true);
    expect(isSecretPath("secrets.json")).toBe(true);
    expect(isSecretPath("config/credentials.json")).toBe(true);
  });

  it("leaves ordinary source files alone", () => {
    expect(isSecretPath("src/series.ts")).toBe(false);
    expect(isSecretPath("docs/notes.md")).toBe(false);
    expect(isSecretPath("Cargo.toml")).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("replaces a private key block", () => {
    const text = "const key = `-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----`;";

    expect(redactSecrets(text)).toBe("const key = `<redacted>`;");
  });

  it("replaces token-shaped values", () => {
    expect(redactSecrets("const token = ghp_abcdefghijklmnopqrstuvwxyz0123456789AB;")).toContain("<redacted>");
    expect(redactSecrets("const aws = AKIAIOSFODNN7EXAMPLE;")).toContain("<redacted>");
  });

  it("replaces a secret assignment but keeps the key name", () => {
    const redacted = redactSecrets("const config = { password: 'hunter2hunter2' };");

    expect(redacted).toContain("password:");
    expect(redacted).toContain("<redacted>");
    expect(redacted).not.toContain("hunter2hunter2");
  });

  it("leaves ordinary code alone", () => {
    expect(redactSecrets("const sum = a + b;")).toBe("const sum = a + b;");
  });
});

describe("hasSecret", () => {
  it("detects a token the model might autocomplete", () => {
    expect(hasSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789AB")).toBe(true);
    expect(hasSecret("password: hunter2hunter2")).toBe(true);
  });

  it("passes ordinary text", () => {
    expect(hasSecret("const sum = a + b;")).toBe(false);
  });
});
