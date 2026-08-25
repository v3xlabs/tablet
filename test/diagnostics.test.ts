import { describe, expect, it } from "vitest";

import { describeDiagnostic, renderDiagnostics } from "../src/context/diagnostics";
import { NEXT_EDIT_DEFAULTS } from "../src/format/next-edit";

const unused = {
  line: 7,
  character: 2,
  severity: "warning",
  source: "eslint",
  message: "'x' is assigned a value but never used",
};

describe("describeDiagnostic", () => {
  it("reports the position the way an editor does, counting from one", () => {
    expect(describeDiagnostic(unused)).toBe("8:3 warning eslint: 'x' is assigned a value but never used");
  });

  it("leaves out a source the linter did not give", () => {
    expect(describeDiagnostic({ ...unused, source: undefined })).toBe("8:3 warning: 'x' is assigned a value but never used");
  });
});

describe("renderDiagnostics", () => {
  it("renders nothing at all when the file is clean", () => {
    expect(renderDiagnostics(NEXT_EDIT_DEFAULTS.diagnosticTemplate, "src/test.ts", [])).toEqual({ ok: true, prompt: "" });
  });

  it("frames every diagnostic under the path", () => {
    const rendered = renderDiagnostics(NEXT_EDIT_DEFAULTS.diagnosticTemplate, "src/test.ts", [unused, { ...unused, line: 9 }]);

    expect(rendered).toEqual({
      ok: true,
      prompt: "<|file_sep|>diagnostics/src/test.ts\n"
        + "8:3 warning eslint: 'x' is assigned a value but never used\n"
        + "10:3 warning eslint: 'x' is assigned a value but never used\n",
    });
  });

  it("reports a template naming something it cannot fill", () => {
    expect(renderDiagnostics("{{severity}}", "src/test.ts", [unused])).toEqual({ ok: false, unknown: ["severity"] });
  });
});
