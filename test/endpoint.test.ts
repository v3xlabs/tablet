import { describe, expect, it } from "vitest";

import { describeFailure, readCompletionBody } from "../src/endpoint";

describe("readCompletionBody", () => {
  it("reads every choice of an openai compatible reply", () => {
    const body = { choices: [{ text: "one" }, { text: "two" }] };

    expect(readCompletionBody(body)).toEqual({ kind: "texts", texts: ["one", "two"] });
  });

  it("recognises llama.cpp's own reply, which has content and no choices", () => {
    const body = { index: 0, content: " 1\nconst b = 2", stop: true };

    expect(readCompletionBody(body)).toEqual({ kind: "native" });
  });

  it("reports a body it cannot read at all", () => {
    expect(readCompletionBody({ result: "?" })).toEqual({ kind: "unreadable" });
  });

  it("treats a reply with no usable choice as an empty answer", () => {
    expect(readCompletionBody({ choices: [] })).toEqual({ kind: "texts", texts: [] });
  });
});

describe("describeFailure", () => {
  it("names the url and the fix when the endpoint misses its /v1 suffix", () => {
    const detail = describeFailure({ kind: "native-api", url: "http://127.0.0.1:8080/completions" });

    expect(detail).toContain("http://127.0.0.1:8080/completions");
    expect(detail).toContain("/v1");
  });

  it("quotes the body it could not read", () => {
    const detail = describeFailure({ kind: "malformed", url: "http://x/completions", detail: "{\"result\":\"?\"}" });

    expect(detail).toContain("http://x/completions");
    expect(detail).toContain("result");
  });
});
