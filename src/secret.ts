export type SecretSpec
  = | { kind: "literal"; value: string; }
    | { kind: "env"; name: string; }
    | { kind: "storage"; name: string; };

export type SecretSource = {
  environment: Record<string, string | undefined>;
  read: (name: string) => Thenable<string | undefined>;
};

export type SecretResult
  = | { ok: true; value: string; }
    | { ok: false; problem: string; };

const ENV_PREFIX = "os.environ/";
const STORAGE_PREFIX = "secretstorage/";

export const parseSecretSpec = (raw: string): SecretSpec => {
  if (raw.startsWith(ENV_PREFIX)) return { kind: "env", name: raw.slice(ENV_PREFIX.length) };

  if (raw.startsWith(STORAGE_PREFIX)) return { kind: "storage", name: raw.slice(STORAGE_PREFIX.length) };

  return { kind: "literal", value: raw };
};

export const resolveSecret = async (spec: SecretSpec, source: SecretSource): Promise<SecretResult> => {
  if (spec.kind === "literal") return { ok: true, value: spec.value };

  if (spec.kind === "env") {
    const value = source.environment[spec.name];

    return value === undefined || value === ""
      ? { ok: false, problem: `the environment variable ${spec.name} is not set for this editor` }
      : { ok: true, value };
  }

  const stored = await source.read(spec.name);

  return stored === undefined || stored === ""
    ? { ok: false, problem: `no key named ${spec.name} is stored, run the "tablet: Store a named key" command` }
    : { ok: true, value: stored };
};

export const resolveAll = async (
  values: Record<string, string>,
  source: SecretSource,
): Promise<{ ok: true; values: Record<string, string>; } | { ok: false; problem: string; }> => {
  const resolved: Record<string, string> = {};

  for (const [key, raw] of Object.entries(values)) {
    const result = await resolveSecret(parseSecretSpec(raw), source);

    if (!result.ok) return { ok: false, problem: `${key}: ${result.problem}` };

    resolved[key] = result.value;
  }

  return { ok: true, values: resolved };
};
