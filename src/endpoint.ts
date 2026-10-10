export type EndpointFailure
  = | { kind: "unreachable"; detail: string; }
    | { kind: "timeout"; }
    | { kind: "aborted"; }
    | { kind: "context"; promptTokens: number; contextSize: number; }
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
    case "context": {
      return `the prompt was ${failure.promptTokens} tokens and the endpoint holds ${failure.contextSize}`;
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

/**
 * llama.cpp refuses a prompt over its slot with a 400 that names both sizes. Reading
 * them is what lets the next request fit instead of failing the same way.
 */
export const readContextOverflow = (body: string): EndpointFailure | undefined => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  }
  catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;

  const error = (parsed as { error?: unknown; }).error;

  if (typeof error !== "object" || error === null) return undefined;

  const { type, n_prompt_tokens: promptTokens, n_ctx: contextSize } = error as { type?: unknown; n_prompt_tokens?: unknown; n_ctx?: unknown; };

  if (type !== "exceed_context_size_error" || typeof promptTokens !== "number" || typeof contextSize !== "number") return undefined;

  return { kind: "context", promptTokens, contextSize };
};

export type BodyRead
  = | { kind: "texts"; texts: string[]; }
    | { kind: "native"; }
    | { kind: "unreadable"; };

type ChoicesRead
  = | { kind: "choices"; choices: Array<{ index: number; text: string; }>; }
    | { kind: "native"; }
    | { kind: "unreadable"; };

/**
 * llama.cpp serves its own format at {base}/completions and the OpenAI one at
 * {base}/v1/completions, so an endpoint missing the /v1 suffix answers with content
 * rather than choices. Telling those two apart is the difference between a useful
 * message and "no choices in the body".
 */
const readChoices = (body: unknown): ChoicesRead => {
  if (typeof body !== "object" || body === null) return { kind: "unreadable" };

  if (!("choices" in body) || !Array.isArray(body.choices)) {
    return "content" in body && typeof body.content === "string"
      ? { kind: "native" }
      : { kind: "unreadable" };
  }

  const choices: unknown[] = body.choices;
  const read: Array<{ index: number; text: string; }> = [];

  for (const [position, choice] of choices.entries()) {
    if (typeof choice !== "object" || choice === null || !("text" in choice) || typeof choice.text !== "string") continue;

    const index = "index" in choice && typeof choice.index === "number" ? choice.index : position;

    read.push({ index, text: choice.text });
  }

  return { kind: "choices", choices: read };
};

export const readCompletionBody = (body: unknown): BodyRead => {
  const read = readChoices(body);

  return read.kind === "choices" ? { kind: "texts", texts: read.choices.map(choice => choice.text) } : read;
};

/**
 * Joins server-sent completion chunks into one text per choice. Each `data:` line holds
 * a body shaped like a whole reply, carrying the next piece of each choice it names.
 */
export const readEventStream = async (body: ReadableStream<Uint8Array>): Promise<BodyRead> => {
  const texts = new Map<number, string>();
  const decoder = new TextDecoder();
  let held = "";

  const readLine = (line: string): BodyRead | "done" | undefined => {
    if (!line.startsWith("data:")) return undefined;

    const data = line.slice("data:".length).trim();

    if (data === "[DONE]") return "done";

    const read = readChoices(JSON.parse(data));

    if (read.kind !== "choices") return read;

    for (const choice of read.choices) texts.set(choice.index, (texts.get(choice.index) ?? "") + choice.text);

    return undefined;
  };

  const collected = (): BodyRead => ({
    kind: "texts",
    texts: [...texts].toSorted(([left], [right]) => left - right).map(([, text]) => text),
  });

  for await (const bytes of body) {
    held += decoder.decode(bytes, { stream: true });

    const lines = held.split("\n");

    held = lines.pop() ?? "";

    for (const line of lines) {
      const read = readLine(line);

      if (read === "done") return collected();

      if (read !== undefined) return read;
    }
  }

  const last = readLine(held + decoder.decode());

  return last === undefined || last === "done" ? collected() : last;
};

export const complete = async (request: CompletionRequest): Promise<CompletionResult> => {
  const url = `${request.endpoint.replace(/\/+$/, "")}/completions`;
  const timeout = AbortSignal.timeout(request.timeoutMs);

  // streamed so that an abort closes the connection mid-generation: llama.cpp keeps
  // decoding a plain request whose client has gone, holding a slot the next ask needs
  const body = {
    ...request.extraBody,
    model: request.model,
    prompt: request.prompt,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    stop: request.stop,
    stream: true,
  };

  const failureOf = (error: unknown): EndpointFailure => {
    if (request.signal.aborted) return { kind: "aborted" };

    if (timeout.aborted) return { kind: "timeout" };

    return { kind: "unreachable", detail: String(error) };
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
    return { ok: false, failure: failureOf(error) };
  }

  if (!response.ok) {
    const detail = await readBody(response);
    const overflow = readContextOverflow(detail);

    if (overflow !== undefined) return { ok: false, failure: overflow };

    return { ok: false, failure: { kind: "status", status: response.status, detail: detail.slice(0, 400) } };
  }

  const isStream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  let read: BodyRead;

  try {
    read = isStream && response.body !== null
      ? await readEventStream(response.body)
      : readCompletionBody(await response.json());
  }
  catch (error) {
    if (request.signal.aborted || timeout.aborted) return { ok: false, failure: failureOf(error) };

    return { ok: false, failure: { kind: "malformed", url, detail: String(error) } };
  }

  if (read.kind === "native") return { ok: false, failure: { kind: "native-api", url } };

  if (read.kind === "unreadable") return { ok: false, failure: { kind: "malformed", url, detail: "no choices in the reply" } };

  return { ok: true, texts: read.texts };
};
