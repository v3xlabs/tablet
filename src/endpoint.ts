export type EndpointFailure
  = | { kind: "unreachable"; detail: string; }
    | { kind: "timeout"; }
    | { kind: "aborted"; }
    | { kind: "status"; status: number; detail: string; }
    | { kind: "malformed"; detail: string; };

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
      return `the endpoint answered something unexpected: ${failure.detail}`;
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

const readTexts = (body: unknown): string[] | undefined => {
  if (typeof body !== "object" || body === null) return undefined;

  const choices = (body as { choices?: unknown; }).choices;

  if (!Array.isArray(choices)) return undefined;

  const texts: string[] = [];

  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;

    const text = (choice as { text?: unknown; }).text;

    if (typeof text === "string") texts.push(text);
  }

  return texts;
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
    return { ok: false, failure: { kind: "malformed", detail: String(error) } };
  }

  const texts = readTexts(parsed);

  if (texts === undefined) return { ok: false, failure: { kind: "malformed", detail: "no choices in the body" } };

  return { ok: true, texts };
};
