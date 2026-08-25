import { describe, expect, it } from "vitest";

import { filterCompletion } from "../src/format/fim-filter";

const filter = (completion: string, lineSuffix = "", followingLines: string[] = []) =>
  filterCompletion({ completion, lineSuffix, followingLines });

describe("filterCompletion", () => {
  it("drops a completion that is only whitespace", () => {
    expect(filter("   \n\n")).toBeUndefined();
  });

  it("drops trailing blank lines", () => {
    expect(filter("value;\n\n\n")).toBe("value;");
  });

  it("removes text the completion duplicates from the line suffix", () => {
    expect(filter("getName())", ")")).toBe("getName()");
  });

  it("cuts where the completion runs into code that is already below", () => {
    expect(filter("const a = 1;\nconst b = 2;", "", ["", "const b = 2;"])).toBe("const a = 1;");
  });

  it("drops a completion that only repeats the line suffix", () => {
    expect(filter(");", ");")).toBeUndefined();
  });
});
