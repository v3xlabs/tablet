import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emptyCache } from "../src/cache";
import { isProseLanguage, parseConfigurations, PROSE_LANGUAGE_DEFAULTS, proseProfile } from "../src/config";
import { type ChangeTracker, trackChange } from "../src/context/recent-edits";
import { complete } from "../src/endpoint";
import { applyEdits } from "../src/format/apply-edits";
import { suggest, type Suggestion, type SuggestResult } from "../src/suggest";
import type { CaseSpec } from "./generate";

const root = path.dirname(fileURLToPath(import.meta.url));
const casesRoot = path.join(root, "cases");

const flagValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);

  return index === -1 ? undefined : process.argv[index + 1];
};

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const ENDPOINT = flagValue("endpoint") ?? "https://ollama.v3x.sh/upstream/sweep-next-edit-v2-7b/v1";
const MODEL = flagValue("model") ?? "sweep-next-edit-v2-7b";
const CONCURRENCY = Number(flagValue("concurrency") ?? 8);
const LIMIT = Number(flagValue("limit") ?? Infinity);
const FILTER = flagValue("filter");
const IS_NO_DIAGNOSTICS = hasFlag("no-diagnostics");
const TIMEOUT_MS = Number(flagValue("timeout") ?? 90_000);
const SAMPLES = Number(flagValue("samples") ?? 1);

const overrides: Record<string, unknown> = {};

for (const key of ["windowLines", "contextLines", "maxTokens", "temperature", "contextFiles", "crossFileCandidates"]) {
  const value = flagValue(key);

  if (value !== undefined) overrides[key] = Number(value);
}

const parsed = parseConfigurations({
  eval: {
    endpoint: ENDPOINT,
    model: MODEL,
    format: "next-edit",
    ...hasFlag("no-format-marker") && { formatMarker: "" },
    ...overrides,
  },
});

const config = parsed.configurations[0];

if (config === undefined) throw new Error(parsed.problems.join("; "));

type Outcome = {
  caseId: string;
  sample: number;
  category: string;
  variant: string;
  language: string;
  outcome: "pass" | "pass-loose" | "format-pass" | "no-op" | "wrong-edit" | "wrong-file" | "false-positive" | "format-wrong" | "error";
  requests: number;
  rounds: number;
  ms: number;
  detail?: string;
};

const loadCase = (caseId: string): { spec: CaseSpec; files: Map<string, string>; expected: Map<string, string>; previous: Map<string, string>; } => {
  const caseFolder = path.join(casesRoot, caseId);
  const spec = JSON.parse(readFileSync(path.join(caseFolder, "case.json"), "utf8")) as CaseSpec;
  const files = new Map<string, string>();
  const expected = new Map<string, string>();
  const previous = new Map<string, string>();

  for (const [filePath, relative] of Object.entries(spec.files)) files.set(filePath, readFileSync(path.join(caseFolder, relative), "utf8"));

  for (const [filePath, relative] of Object.entries(spec.expected)) expected.set(filePath, readFileSync(path.join(caseFolder, relative), "utf8"));

  const previousEntries = Object.entries(spec.previousFiles ?? {});

  for (const [filePath, relative] of previousEntries) previous.set(filePath, readFileSync(path.join(caseFolder, relative), "utf8"));

  return { spec, files, expected, previous };
};

const solid = (text: string): string => text.split("\n").filter(line => line.trim() !== "")
  .join("\n");

type Verdict = { outcome: Outcome["outcome"]; detail?: string; };

const matches = (files: Map<string, string>, expected: Map<string, string>): Verdict | undefined => {
  const pairs = [...expected].map(([filePath, wanted]) => ({ wanted, held: files.get(filePath) ?? "" }));

  if (pairs.every(pair => pair.held === pair.wanted)) return { outcome: "pass" };

  if (pairs.every(pair => solid(pair.held) === solid(pair.wanted))) {
    return { outcome: "pass-loose", detail: "correct except for blank line collateral" };
  }

  return undefined;
};

const divergence = (files: Map<string, string>, expected: Map<string, string>): string => {
  for (const [filePath, wanted] of expected) {
    const held = files.get(filePath) ?? "";

    if (held === wanted) continue;

    const firstDiff = [...held].findIndex((ch, index) => ch !== wanted[index]);

    return `${filePath} diverges near offset ${firstDiff}: ${JSON.stringify(held.slice(Math.max(0, firstDiff - 30), firstDiff + 30))}`;
  }

  return "no divergence found";
};

/**
 * A reply carrying several corrections arrives as several suggestions, and a reader
 * accepts them one at a time, re-asking in between. The judge does the same: apply the
 * first suggestion, ask again on the changed text, up to three rounds.
 */
const judgeRound = (spec: CaseSpec, result: SuggestResult, round: number, files: Map<string, string>, expected: Map<string, string>): Verdict | { kind: "applied"; edit: Suggestion & { kind: "edit"; }; } => {
  if (result.kind === "failure") return { outcome: "error", detail: JSON.stringify(result.failure) };

  if (result.kind === "invalid") return { outcome: "error", detail: `template names ${result.unknown.join(", ")}` };

  if (result.kind === "none") {
    if (spec.category === "clean" || spec.category === "secret") return { outcome: "pass" };

    return round === 0
      ? { outcome: "no-op", detail: result.reason }
      : { outcome: "wrong-edit", detail: `stalled after ${round} round(s): ${divergence(files, expected)}` };
  }

  const first = result.suggestions[0];

  if (first === undefined) return { outcome: "no-op", detail: "empty suggestion list" };

  if (spec.category === "clean" || spec.category === "secret") return { outcome: "false-positive", detail: JSON.stringify(first).slice(0, 160) };

  if (first.kind === "format") return spec.allowFormat ? { outcome: "format-pass" } : { outcome: "format-wrong" };

  if (first.kind === "completion") return { outcome: "wrong-edit", detail: "fim completion from a next-edit run" };

  // prose has no single right answer: the inserted text has to hold the expected phrase
  // inside the budget, and a rewritten paragraph fails on the budget
  if (spec.prose !== undefined) {
    if (first.path !== spec.targetPath) return { outcome: "wrong-file", detail: `edit lands in ${first.path}` };

    const held = files.get(first.path) ?? "";

    files.set(first.path, applyEdits(held, [first]));

    if (first.text.length > spec.prose.maxInsertedChars) {
      return { outcome: "wrong-edit", detail: `inserts ${first.text.length} chars, budget is ${spec.prose.maxInsertedChars}` };
    }

    if (!first.text.includes(spec.prose.inserted)) {
      return { outcome: "wrong-edit", detail: `inserted text lacks ${JSON.stringify(spec.prose.inserted)}` };
    }

    return { outcome: "pass" };
  }

  const held = files.get(first.path);

  if (held === undefined) return { outcome: "wrong-file", detail: `edit names ${first.path}, which the case does not hold` };

  if (!expected.has(first.path)) return { outcome: "wrong-file", detail: `edit lands in ${first.path}, which should stay untouched` };

  files.set(first.path, applyEdits(held, [first]));

  return { kind: "applied", edit: first };
};

const askOnce = (prompt: string) => complete({
  endpoint: config.endpoint,
  apiKey: "",
  headers: {},
  model: config.model,
  prompt,
  maxTokens: config.maxTokens,
  temperature: config.temperature,
  stop: config.stop,
  extraBody: {},
  timeoutMs: TIMEOUT_MS,
  signal: new AbortController().signal,
});

const MAX_ROUNDS = 3;

const runCase = async (caseId: string, sample: number): Promise<Outcome> => {
  const { spec, files, expected, previous } = loadCase(caseId);

  const effective = isProseLanguage(PROSE_LANGUAGE_DEFAULTS, spec.language) ? proseProfile(config) : config;

  const tracker: ChangeTracker = {
    lastText: new Map([...files].map(([heldPath, text]) => [heldPath, text])),
    previousByPath: new Map([...previous].map(([heldPath, text]) => [heldPath, text.split("\n")])),
    log: { edits: [...spec.recentEdits], limit: 8 },
  };

  let requests = 0;
  let rounds = 0;
  let hasLeaked = false;
  const started = Date.now();

  // for a secret case the outcome is not enough: the file must reach no prompt at all,
  // so every prompt is checked for a line of it on the way out
  const secretLines = spec.category === "secret"
    ? Array.from(files.values())
        .flatMap(text => text.split("\n"))
        .map(line => line.trim())
        .filter(line => line.length > 12)
    : [];

  const dependencies = {
    complete: async (prompt: string) => {
      requests++;

      if (secretLines.some(line => prompt.includes(line))) hasLeaked = true;

      for (let attempt = 0; attempt < 8; attempt++) {
        const answer = await askOnce(prompt);

        if (answer.ok || answer.failure.kind !== "status" || answer.failure.status !== 429) return answer;

        const jitter = Math.random() * 1000;
        const backoff = (1 << attempt) * 1000;

        await new Promise(resolve => setTimeout(resolve, backoff + jitter));
      }

      return askOnce(prompt);
    },
    readFile: async (filePath: string) => files.get(filePath)?.split("\n"),
    diagnosticsFor: (filePath: string) => (IS_NO_DIAGNOSTICS || filePath !== spec.targetPath ? [] : spec.diagnostics),
    cache: emptyCache<Suggestion[]>(4),
  };

  let verdict: Verdict = { outcome: "wrong-edit", detail: `still diverging after ${MAX_ROUNDS} rounds: ${divergence(files, expected)}` };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const target = files.get(spec.targetPath);

    if (target === undefined) throw new Error(`${caseId}: target file missing`);

    const result = await suggest(
      {
        configuration: effective,
        snapshot: {
          path: spec.targetPath,
          languageId: spec.language,
          lines: target.split("\n"),
          cursorLine: Math.min(spec.cursor.line, target.split("\n").length - 1),
          cursorCharacter: spec.cursor.character,
        },
        chunks: [],
        changes: tracker.log.edits,
        diagnostics: IS_NO_DIAGNOSTICS ? [] : spec.diagnostics,
        repo: "bench",
        previousByPath: tracker.previousByPath,
        candidatePaths: spec.candidatePaths,
      },
      dependencies,
    );

    rounds = round + 1;

    const judged = judgeRound(spec, result, round, files, expected);

    if (!("kind" in judged)) {
      verdict = judged;
      break;
    }

    // the accepted suggestion fires a document change live, so the next round is asked
    // with the model's own edit in the log and the pre-acceptance text pinned
    trackChange(tracker, judged.edit.path, judged.edit.path, files.get(judged.edit.path) ?? "");

    const settled = matches(files, expected);

    if (settled !== undefined) {
      verdict = settled;
      break;
    }

    verdict = { outcome: "wrong-edit", detail: `still diverging after ${round + 1} round(s): ${divergence(files, expected)}` };
  }

  if (hasLeaked) verdict = { outcome: "wrong-edit", detail: "a prompt carried a line of the secret file" };

  return {
    caseId,
    sample,
    category: spec.category,
    variant: spec.variant,
    language: spec.language,
    outcome: verdict.outcome,
    requests,
    rounds,
    ms: Date.now() - started,
    ...(verdict.detail !== undefined && { detail: verdict.detail }),
  };
};

const caseIds = readdirSync(casesRoot)
  .filter(name => FILTER === undefined || name.includes(FILTER))
  .toSorted((left, right) => left.localeCompare(right))
  .slice(0, LIMIT);

const queue = caseIds.flatMap(caseId =>
  Array.from({ length: SAMPLES }, (_, sample) => ({ caseId, sample })));

console.log(`${caseIds.length} case(s) against ${ENDPOINT} (${MODEL}), concurrency ${CONCURRENCY}${IS_NO_DIAGNOSTICS ? ", diagnostics stripped" : ""}${SAMPLES > 1 ? `, ${SAMPLES} samples each` : ""}`);

const outcomes: Outcome[] = [];

const isPass = (outcome: Outcome): boolean => ["pass", "pass-loose", "format-pass"].includes(outcome.outcome);

const worker = async (): Promise<void> => {
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const outcome = await runCase(next.caseId, next.sample);

    outcomes.push(outcome);
    process.stdout.write(isPass(outcome) ? "." : "x");
  }
};

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log("");

const tally = (label: string, key: (outcome: Outcome) => string): void => {
  const groups = new Map<string, Outcome[]>();

  for (const outcome of outcomes) {
    const group = groups.get(key(outcome)) ?? [];

    group.push(outcome);
    groups.set(key(outcome), group);
  }

  console.log(`\nby ${label}:`);

  const ordered = [...groups].toSorted((left, right) => left[0].localeCompare(right[0]));

  for (const [name, group] of ordered) {
    const passed = group.filter(isPass).length;

    console.log(`  ${name.padEnd(20)} ${String(passed).padStart(3)}/${String(group.length).padEnd(3)} ${Math.round((passed / group.length) * 100)}%`);
  }
};

const passed = outcomes.filter(isPass).length;
const strict = outcomes.filter(outcome => outcome.outcome === "pass" || outcome.outcome === "format-pass").length;
const meanMs = Math.round(outcomes.reduce((sum, held) => sum + held.ms, 0) / Math.max(1, outcomes.length));

console.log(`\noverall: ${passed}/${outcomes.length} (${Math.round((passed / Math.max(1, outcomes.length)) * 100)}%), strict ${strict}/${outcomes.length}, mean ${meanMs}ms/case`);

if (SAMPLES > 1) {
  const byCase = new Map<string, Outcome[]>();

  for (const outcome of outcomes) {
    const group = byCase.get(outcome.caseId) ?? [];

    group.push(outcome);
    byCase.set(outcome.caseId, group);
  }

  let anyPassed = 0;

  for (const group of byCase.values()) {
    if (group.some(isPass)) anyPassed++;
  }

  console.log(`any-sample: ${anyPassed}/${byCase.size} case(s) passed with at least one sample`);
}

tally("category", outcome => outcome.category);
tally("variant", outcome => outcome.variant);
tally("language", outcome => outcome.language);
tally("outcome", outcome => outcome.outcome);

const failures = outcomes.filter(outcome => !isPass(outcome));

if (failures.length > 0) {
  const noops = failures.filter(f => f.outcome === "no-op");
  const other = failures.filter(f => f.outcome !== "no-op");

  if (other.length > 0) {
    console.log("\nfailures:");

    const ordered = other.toSorted((left, right) => left.caseId.localeCompare(right.caseId));

    for (const failure of ordered) {
      console.log(`  ${failure.caseId}: ${failure.outcome}${failure.detail === undefined ? "" : ` (${failure.detail.slice(0, 140)})`}`);
    }
  }

  if (noops.length > 0) {
    console.log(`\nmodel had nothing to change on ${noops.length} broken case(s):`);

    const ordered = noops.toSorted((left, right) => left.caseId.localeCompare(right.caseId));

    for (const failure of ordered) {
      console.log(`  ${failure.caseId}${failure.detail === undefined ? "" : ` (${failure.detail.slice(0, 100)})`}`);
    }
  }
}

mkdirSync(path.join(root, "results"), { recursive: true });

const stamp = new Date().toISOString()
  .replaceAll(":", "-");
const resultPath = path.join(root, "results", `run-${stamp}.jsonl`);

writeFileSync(resultPath, outcomes.map(outcome => JSON.stringify(outcome)).join("\n"));
console.log(`\nraw results: ${resultPath}`);
