import { describe, expect, it } from "vitest";

import { excerptAround, identifiersOn } from "../src/context/definitions";

describe("identifiersOn", () => {
  it("names the identifiers nearest the cursor first and skips keywords and short names", () => {
    const line = "  const total = computeTotal(items, taxRate) + x;";

    expect(identifiersOn(line, 30).map(held => held.name)).toEqual(["items", "taxRate", "computeTotal", "total"]);
  });

  it("returns each name once", () => {
    expect(identifiersOn("foo(foo, foo)", 0)).toHaveLength(1);
  });
});

describe("excerptAround", () => {
  it("takes a function through its closing brace", () => {
    const lines = ["import x from 'y';", "", "export const add = (a: number, b: number): number => {", "  return a + b;", "};", "", "export const other = 1;"];

    expect(excerptAround(lines, 2)).toEqual({ startLine: 2, lines: ["export const add = (a: number, b: number): number => {", "  return a + b;", "};"] });
  });

  it("stops at twelve lines for a long body", () => {
    const lines = ["const f = () => {", ...Array.from({ length: 30 }, (_unused, index) => `  step${index}();`), "};"];

    expect(excerptAround(lines, 0).lines).toHaveLength(12);
  });

  it("takes a one line definition alone", () => {
    expect(excerptAround(["type Id = string;", "type Other = number;"], 0)).toEqual({ startLine: 0, lines: ["type Id = string;", "type Other = number;"] });
  });
});
