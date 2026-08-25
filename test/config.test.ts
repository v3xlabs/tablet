import { describe, expect, it } from "vitest";

import { isLanguageEnabled, isProseLanguage, parseConfigurations, proseProfile, selectActive } from "../src/config";

const local = {
  endpoint: "http://127.0.0.1:8080/v1",
  model: "qwen2.5-coder-7b",
  format: "fim",
};

describe("parseConfigurations", () => {
  it("fills the defaults for the format", () => {
    const parsed = parseConfigurations({ local });
    const config = parsed.configurations[0];

    expect(parsed.problems).toEqual([]);
    expect(config?.name).toBe("local");
    expect(config?.template).toContain("{{prefix}}");
    expect(config?.format === "fim" && config.prefixLines).toBe(128);
  });

  it("reports a missing endpoint instead of throwing", () => {
    const parsed = parseConfigurations({ broken: { model: "m", format: "fim" } });

    expect(parsed.configurations).toEqual([]);
    expect(parsed.problems).toEqual(["broken: endpoint is missing"]);
  });

  it("rejects a format it cannot serve", () => {
    const parsed = parseConfigurations({ broken: { ...local, format: "chat" } });

    expect(parsed.problems[0]).toContain("format must be");
  });

  it("rejects a template naming something it cannot fill", () => {
    const parsed = parseConfigurations({ broken: { ...local, template: "{{prefix}}{{diff}}" } });

    expect(parsed.configurations).toEqual([]);
    expect(parsed.problems[0]).toContain("diff");
  });

  it("accepts a template that renames the markers", () => {
    const parsed = parseConfigurations({
      custom: { ...local, template: "<PRE>{{prefix}}<SUF>{{suffix}}<MID>" },
    });

    expect(parsed.configurations[0]?.template).toBe("<PRE>{{prefix}}<SUF>{{suffix}}<MID>");
  });

  it("keeps the good configurations when one is broken", () => {
    const parsed = parseConfigurations({ local, broken: { format: "fim" } });

    expect(parsed.configurations.map(entry => entry.name)).toEqual(["local"]);
    expect(parsed.problems).toHaveLength(2);
  });
});

describe("selectActive", () => {
  const configurations = parseConfigurations({
    local,
    other: { ...local, model: "other" },
  }).configurations;

  it("prefers the session override", () => {
    expect(selectActive(configurations, "local", "other")?.name).toBe("other");
  });

  it("falls back to the setting when the override names nothing", () => {
    expect(selectActive(configurations, "local", "deleted")?.name).toBe("local");
  });

  it("uses the only configuration when nothing is named", () => {
    const single = parseConfigurations({ local }).configurations;

    expect(selectActive(single, "", undefined)?.name).toBe("local");
  });

  it("selects nothing when several exist and none is named", () => {
    expect(selectActive(configurations, "", undefined)).toBeUndefined();
  });
});

describe("isLanguageEnabled", () => {
  it("prefers the language over the fallback", () => {
    expect(isLanguageEnabled({ "*": true, "markdown": false }, "markdown")).toBe(false);
  });

  it("uses the fallback for a language nobody listed", () => {
    expect(isLanguageEnabled({ "*": false }, "rust")).toBe(false);
  });
});

describe("proseProfile", () => {
  const nextEdit = parseConfigurations({
    local: { endpoint: "http://x/v1", model: "m", format: "next-edit" },
  }).configurations[0];

  it("bounds the window, the context, and the budget", () => {
    if (nextEdit === undefined) throw new Error("config missing");

    const prose = proseProfile(nextEdit);

    expect(prose.format === "next-edit" && prose.windowLines).toBe(9);
    expect(prose.format === "next-edit" && prose.contextLines).toBe(60);
    expect(prose.maxTokens).toBe(160);
    expect(prose.format === "next-edit" && prose.formatMarker).toBe("");
    expect(prose.format === "next-edit" && prose.crossFileCandidates).toBe(0);
  });

  it("never widens a smaller configuration", () => {
    const small = parseConfigurations({
      local: { endpoint: "http://x/v1", model: "m", format: "next-edit", windowLines: 5, maxTokens: 64 },
    }).configurations[0];

    if (small === undefined) throw new Error("config missing");

    const prose = proseProfile(small);

    expect(prose.format === "next-edit" && prose.windowLines).toBe(5);
    expect(prose.maxTokens).toBe(64);
  });

  it("leaves a fim configuration alone", () => {
    const fim = parseConfigurations({ local }).configurations[0];

    if (fim === undefined) throw new Error("config missing");

    expect(proseProfile(fim)).toEqual(fim);
  });
});

describe("isProseLanguage", () => {
  it("matches only listed languages", () => {
    expect(isProseLanguage(["markdown"], "markdown")).toBe(true);
    expect(isProseLanguage(["markdown"], "rust")).toBe(false);
  });
});
