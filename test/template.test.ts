import { describe, expect, it } from "vitest";

import { placeholdersIn, render } from "../src/format/template";

describe("render", () => {
  it("substitutes every placeholder", () => {
    const result = render("a{{one}}b{{two}}", { one: "1", two: "2" });

    expect(result).toEqual({ ok: true, text: "a1b2" });
  });

  it("reports a placeholder it cannot fill", () => {
    const result = render("{{prefix}} and {{elsewhere}}", { prefix: "x" });

    expect(result).toEqual({ ok: false, unknown: ["elsewhere"] });
  });

  it("leaves text with no placeholders alone", () => {
    expect(render("<|fim_middle|>", {})).toEqual({ ok: true, text: "<|fim_middle|>" });
  });
});

describe("placeholdersIn", () => {
  it("lists each name once", () => {
    expect(placeholdersIn("{{a}}{{b}}{{a}}")).toEqual(["a", "b"]);
  });
});
