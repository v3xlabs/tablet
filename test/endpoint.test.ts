import { describe, expect, it } from "vitest";

import { describeFailure, readCompletionBody, readEventStream } from "../src/endpoint";

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

// the server's chunks fall anywhere, including inside a line and inside a character
const streamOf = (lines: string[]): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(lines.join("\n"));
  const chunks = Array.from({ length: Math.ceil(bytes.length / 7) }, (_unused, index) => bytes.slice(index * 7, index * 7 + 7));

  return ReadableStream.from(chunks);
};

describe("readEventStream", () => {
  it("joins interleaved pieces of several samples by their index", async () => {
    const read = await readEventStream(streamOf([
      "data: {\"choices\":[{\"index\":0,\"text\":\"con\"}]}",
      "",
      "data: {\"choices\":[{\"index\":1,\"text\":\"let\"}]}",
      "data: {\"choices\":[{\"index\":0,\"text\":\"st ▁\"}]}",
      "data: {\"choices\":[{\"index\":1,\"text\":\" a\"}]}",
      "data: [DONE]",
    ]));

    expect(read).toEqual({ kind: "texts", texts: ["const ▁", "let a"] });
  });

  it("recognises llama.cpp's own streamed format", async () => {
    expect(await readEventStream(streamOf(["data: {\"content\":\"x\",\"stop\":false}"]))).toEqual({ kind: "native" });
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
