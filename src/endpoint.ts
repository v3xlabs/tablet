export type EndpointFailure
  = | { kind: "unreachable"; detail: string; }
    | { kind: "timeout"; }
    | { kind: "aborted"; }
    | { kind: "status"; status: number; detail: string; }
    | { kind: "malformed"; url: string; detail: string; }
    | { kind: "native-api"; url: string; };

export type CompletionResult
  = | { ok: true; texts: string[]; }
    | { ok: false; failure: EndpointFailure; };

export type CompletionRequest = {
  endpoint: string;
  apiKey: string;
  headers: Record<string, string>;
  model: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
  stop: string[];
  extraBody: Record<string, unknown>;
  timeoutMs: number;
  signal: AbortSignal;
};

export const describeFailure = (failure: EndpointFailure): string => {
  switch (failure.kind) {
    case "unreachable": {
      return `endpoint unreachable: ${failure.detail}`;
    }
    case "timeout": {
      return "the endpoint did not answer in time";
    }
    case "aborted": {
      return "cancelled";
    }
    case "status": {
      return `the endpoint answered ${failure.status}: ${failure.detail}`;
    }
    case "malformed": {
      return `${failure.url} answered something unexpected: ${failure.detail}`;
    }
    case "native-api": {
      return `${failure.url} answered in llama.cpp's own format instead of the OpenAI one. Point endpoint at the OpenAI compatible base, which usually ends in /v1.`;
    }
  }
};

const readBody = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  }
  catch {
    return "";
  }
};

export type BodyRead
  = | { kind: "texts"; texts: string[]; }
    | { kind: "native"; }
    | { kind: "unreadable"; };

/**
 * llama.cpp serves its own format at {base}/completions and the OpenAI one at
 * {base}/v1/completions, so an endpoint missing the /v1 suffix answers with content
 * rather than choices. Telling those two apart is the difference between a useful
 * message and "no choices in the body".
 */
export const readCompletionBody = (body: unknown): BodyRead => {
  if (typeof body !== "object" || body === null) return { kind: "unreadable" };

  const choices = (body as { choices?: unknown; }).choices;

  if (!Array.isArray(choices)) {
    return typeof (body as { content?: unknown; }).content === "string"
      ? { kind: "native" }
      : { kind: "unreadable" };
  }

  const texts: string[] = [];

  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;

    const text = (choice as { text?: unknown; }).text;

    if (typeof text === "string") texts.push(text);
  }

  return { kind: "texts", texts };
};

export const complete = async (request: CompletionRequest): Promise<CompletionResult> => {
  const url = `${request.endpoint.replace(/\/+$/, "")}/completions`;
  const timeout = AbortSignal.timeout(request.timeoutMs);

  const body = {
    ...request.extraBody,
    model: request.model,
    prompt: request.prompt,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    stop: request.stop,
    stream: false,
  };

  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(request.apiKey !== "" && { authorization: `Bearer ${request.apiKey}` }),
        ...request.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([request.signal, timeout]),
    });
  }
  catch (error) {
    if (request.signal.aborted) return { ok: false, failure: { kind: "aborted" } };

    if (timeout.aborted) return { ok: false, failure: { kind: "timeout" } };

    return { ok: false, failure: { kind: "unreachable", detail: String(error) } };
  }

  if (!response.ok) {
    const detail = await readBody(response);

    return { ok: false, failure: { kind: "status", status: response.status, detail: detail.slice(0, 400) } };
  }

  let parsed: unknown;

  try {
    parsed = await response.json();
  }
  catch (error) {
    return { ok: false, failure: { kind: "malformed", url, detail: String(error) } };
  }

  const read = readCompletionBody(parsed);

  if (read.kind === "native") return { ok: false, failure: { kind: "native-api", url } };

  if (read.kind === "unreadable") {
    return { ok: false, failure: { kind: "malformed", url, detail: JSON.stringify(parsed).slice(0, 300) } };
  }

  return { ok: true, texts: read.texts };
};
