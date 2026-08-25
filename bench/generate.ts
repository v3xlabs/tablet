import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Diagnostic } from "../src/context/diagnostics";
import type { RecentEdit } from "../src/context/recent-edits";
import { burstCases } from "./bursts";
import { diagnoseTypescript } from "./diagnose";
import { applyFault, autoFaults, endOf, type Fault, lineMatching, type Mutation } from "./faults";

const root = path.dirname(fileURLToPath(import.meta.url));
const casesRoot = path.join(root, "cases");

export type CaseSpec = {
  caseId: string;
  category: string;
  variant: "near" | "far" | "away";
  language: string;
  targetPath: string;
  cursor: { line: number; character: number; };
  files: Record<string, string>;
  expected: Record<string, string>;
  candidatePaths: string[];
  recentEdits: RecentEdit[];
  diagnostics: Diagnostic[];
  allowFormat: boolean;
  previousFiles?: Record<string, string>;
  prose?: { inserted: string; maxInsertedChars: number; };
};

type Seed = {
  file: string;
  language: string;
  targetPath: string;
  curated: (lines: string[]) => Fault[];
};

const seeds: Seed[] = [
  {
    file: "series.ts",
    language: "typescript",
    targetPath: "src/series.ts",
    curated: lines => [
      {
        op: "missing-line",
        line: lineMatching(lines, "samples: overflow > 0 ? samples.slice(overflow) : samples,", 0),
        diagnostics: [{ line: lineMatching(lines, "const overflow = samples.length - series.capacity;"), character: 8, severity: "warning", source: "ts", message: "'overflow' is declared but its value is never read." }],
      },
      {
        op: "missing-line",
        line: lineMatching(lines, "const span = spanOf(series);"),
        diagnostics: [{ line: lineMatching(lines, "if (span <= 0) return 0;"), character: 6, severity: "error", source: "ts", message: "Cannot find name 'span'." }],
      },
      {
        op: "typo",
        line: lineMatching(lines, "return series.samples.length / span;"),
        from: "span;",
        to: "spann;",
        diagnostics: [{ line: lineMatching(lines, "return series.samples.length / span;"), character: 33, severity: "error", source: "ts", message: "Cannot find name 'spann'. Did you mean 'span'?" }],
      },
      {
        op: "truncate",
        line: lineMatching(lines, "export const labelled = (series: Series, label: string): Sample[] => {"),
        keep: 43,
      },
      {
        op: "duplicate",
        line: lineMatching(lines, "const samples = [...series.samples, sample];"),
        diagnostics: [{ line: lineMatching(lines, "const samples = [...series.samples, sample];") + 1, character: 8, severity: "error", source: "ts", message: "Cannot redeclare block-scoped variable 'samples'." }],
      },
    ],
  },
  {
    file: "lexer.rs",
    language: "rust",
    targetPath: "src/lexer.rs",
    curated: lines => [
      {
        op: "missing-line",
        line: lineMatching(lines, "tokens.push(token);", 0),
        diagnostics: [{ line: lineMatching(lines, "let token = self.number(d);"), character: 24, severity: "warning", source: "rustc", message: "unused variable: `token`" }],
      },
      {
        op: "missing-line",
        line: lineMatching(lines, "let mut tokens = Vec::new();"),
        diagnostics: [{ line: lineMatching(lines, "while let Some(ch) = self.chars.next()"), character: 8, severity: "error", source: "rustc", message: "cannot find value `tokens` in this scope" }],
      },
      {
        op: "typo",
        line: lineMatching(lines, "Token::Number(text.parse().unwrap_or(0.0))"),
        from: "parse",
        to: "prase",
        diagnostics: [{ line: lineMatching(lines, "Token::Number(text.parse().unwrap_or(0.0))"), character: 27, severity: "error", source: "rustc", message: "no method named `prase` found for struct `String` in the current scope" }],
      },
      {
        op: "truncate",
        line: lineMatching(lines, "while let Some(&next) = self.chars.peek() {", 0),
        keep: 34,
      },
    ],
  },
  {
    file: "settings.rs",
    language: "rust",
    targetPath: "src/settings.rs",
    curated: lines => [
      {
        op: "missing-line",
        line: lineMatching(lines, "let trimmed = line.trim();"),
        diagnostics: [{ line: lineMatching(lines, "if trimmed.is_empty() || trimmed.starts_with('#') {"), character: 15, severity: "error", source: "rustc", message: "cannot find value `trimmed` in this scope" }],
      },
      {
        op: "typo",
        line: lineMatching(lines, "self.get(key)?.parse().ok()"),
        from: "parse",
        to: "prase",
        diagnostics: [{ line: lineMatching(lines, "self.get(key)?.parse().ok()"), character: 23, severity: "error", source: "rustc", message: "no method named `prase` found for reference `&str` in the current scope" }],
      },
      {
        op: "truncate",
        line: lineMatching(lines, "pub fn get_bool(&self, key: &str) -> bool {"),
        keep: 26,
      },
    ],
  },
  {
    file: "todo-list.tsx",
    language: "typescriptreact",
    targetPath: "src/components/todo-list.tsx",
    curated: lines => [
      {
        op: "missing-line",
        line: lineMatching(lines, "</ul>"),
        diagnostics: [{ line: lineMatching(lines, "<ul>"), character: 6, severity: "error", source: "ts", message: "JSX element 'ul' has no corresponding closing tag." }],
      },
      {
        op: "typo",
        line: lineMatching(lines, "setItems(next);", 0),
        from: "setItems",
        to: "setItmes",
        diagnostics: [{ line: lineMatching(lines, "setItems(next);", 0), character: 4, severity: "error", source: "ts", message: "Cannot find name 'setItmes'. Did you mean 'setItems'?" }],
      },
      {
        op: "truncate",
        line: lineMatching(lines, "const toggle = (id: number) => {"),
        keep: 24,
      },
    ],
  },
  {
    file: "route.tsx",
    language: "typescriptreact",
    targetPath: "src/components/route.tsx",
    curated: lines => [
      {
        op: "missing-line",
        line: lineMatching(lines, "</Show>"),
        diagnostics: [{ line: lineMatching(lines, "<Show when="), character: 7, severity: "error", source: "ts", message: "JSX element 'Show' has no corresponding closing tag." }],
      },
      {
        op: "typo",
        line: lineMatching(lines, "const visible = createMemo"),
        from: "expanded()",
        to: "expnded()",
        diagnostics: [{ line: lineMatching(lines, "const visible = createMemo"), character: 34, severity: "error", source: "ts", message: "Cannot find name 'expnded'. Did you mean 'expanded'?" }],
      },
      {
        op: "truncate",
        line: lineMatching(lines, "const total = createMemo"),
        keep: 30,
      },
    ],
  },
  {
    file: "inventory.py",
    language: "python",
    targetPath: "src/inventory.py",
    curated: lines => [
      {
        op: "missing-line",
        line: lineMatching(lines, "total += item.price * item.quantity"),
        diagnostics: [{ line: lineMatching(lines, "return total"), character: 8, severity: "error", source: "Pylance", message: "Expected indented block" }],
      },
      {
        op: "typo",
        line: lineMatching(lines, "held = self.items.get(name)"),
        from: "items",
        to: "itmes",
        diagnostics: [{ line: lineMatching(lines, "held = self.items.get(name)"), character: 20, severity: "error", source: "Pylance", message: "Cannot access attribute \"itmes\" for class \"Inventory\"" }],
      },
      {
        op: "truncate",
        line: lineMatching(lines, "def low_stock(self, threshold: int) -> list[str]:"),
        keep: 30,
      },
    ],
  },
];

const AWAY_OPS = new Set(["indent", "missing-punct", "missing-line"]);

const variantsFor = (mutation: Mutation, lineCount: number): Array<{ variant: "near" | "far" | "away"; cursor: { line: number; character: number; }; }> => {
  const placed: Array<{ variant: "near" | "far" | "away"; cursor: { line: number; character: number; }; }> = [
    { variant: "near", cursor: mutation.cursorNear },
  ];

  if (mutation.truncated) return placed;

  const farLine = mutation.faultLine >= 8 ? mutation.faultLine - 8 : mutation.faultLine + 8;

  if (farLine < lineCount) placed.push({ variant: "far", cursor: endOf(mutation.lines, farLine) });

  const awayLine = mutation.faultLine >= 25 ? mutation.faultLine - 25 : mutation.faultLine + 25;

  if (AWAY_OPS.has(mutation.category) && lineCount >= 55 && awayLine < lineCount) {
    placed.push({ variant: "away", cursor: endOf(mutation.lines, awayLine) });
  }

  return placed;
};

const written: CaseSpec[] = [];

const writeCase = (spec: Omit<CaseSpec, "files" | "expected" | "previousFiles"> & {
  files: Record<string, string[]>;
  expected: Record<string, string[]>;
  previousFiles?: Record<string, string[]>;
}): void => {
  const caseFolder = path.join(casesRoot, spec.caseId);

  mkdirSync(path.join(caseFolder, "files"), { recursive: true });
  mkdirSync(path.join(caseFolder, "expected"), { recursive: true });

  const files: Record<string, string> = {};
  const expected: Record<string, string> = {};

  // written the way an editor saves them, with one final newline, so the harness's own
  // tail policy stays silent unless a case is about the tail
  for (const [filePath, lines] of Object.entries(spec.files)) {
    const relative = path.join("files", path.basename(filePath));

    writeFileSync(path.join(caseFolder, relative), `${lines.join("\n")}\n`);
    files[filePath] = relative;
  }

  for (const [filePath, lines] of Object.entries(spec.expected)) {
    const relative = path.join("expected", path.basename(filePath));

    writeFileSync(path.join(caseFolder, relative), `${lines.join("\n")}\n`);
    expected[filePath] = relative;
  }

  const previousEntries = Object.entries(spec.previousFiles ?? {});
  const previousFiles: Record<string, string> = {};

  if (previousEntries.length > 0) {
    mkdirSync(path.join(caseFolder, "previous"), { recursive: true });

    for (const [filePath, lines] of previousEntries) {
      const relative = path.join("previous", path.basename(filePath));

      writeFileSync(path.join(caseFolder, relative), `${lines.join("\n")}\n`);
      previousFiles[filePath] = relative;
    }
  }

  const specMeta: Omit<CaseSpec, "files" | "expected" | "previousFiles"> = spec;
  const held: CaseSpec = {
    ...specMeta,
    files,
    expected,
    ...(previousEntries.length > 0 && { previousFiles }),
  };

  writeFileSync(path.join(caseFolder, "case.json"), `${JSON.stringify(held, undefined, 2)}\n`);
  written.push(held);
};

rmSync(casesRoot, { recursive: true, force: true });

for (const seed of seeds) {
  const text = readFileSync(path.join(root, "seeds", seed.file), "utf8");
  const lines = text.split("\n");

  if (lines[lines.length - 1] === "") lines.pop();

  const faults = [...autoFaults(lines, seed.language), ...seed.curated(lines)];

  for (const fault of faults) {
    const mutation = applyFault(lines, fault, seed.language);

    // whitespace faults are the linter's domain and keep their eslint-shaped entries;
    // everything else in ts and tsx carries what the compiler actually says, which for a
    // dropped semicolon is nothing at all
    const isCompilerChecked = seed.language.startsWith("typescript")
      && mutation.category !== "indent"
      && mutation.category !== "trailing";

    const diagnostics = isCompilerChecked
      ? diagnoseTypescript(seed.file, mutation.lines.join("\n"))
      : mutation.diagnostics;

    for (const { variant, cursor } of variantsFor(mutation, mutation.lines.length)) {
      writeCase({
        caseId: `${seed.file.replace(/\.\w+$/, "")}-${mutation.category}-l${mutation.faultLine + 1}-${variant}`,
        category: mutation.category,
        variant,
        language: seed.language,
        targetPath: seed.targetPath,
        cursor,
        files: { [seed.targetPath]: mutation.lines },
        expected: { [seed.targetPath]: lines },
        candidatePaths: [],
        recentEdits: [],
        diagnostics,
        allowFormat: mutation.allowFormat,
      });
    }
  }

  const middle = Math.floor(lines.length / 2);

  for (const [variant, cursorLine] of [["near", middle], ["far", Math.max(0, middle - 8)]] as const) {
    writeCase({
      caseId: `${seed.file.replace(/\.\w+$/, "")}-clean-${variant}`,
      category: "clean",
      variant,
      language: seed.language,
      targetPath: seed.targetPath,
      cursor: endOf(lines, cursorLine),
      files: { [seed.targetPath]: lines },
      expected: {},
      candidatePaths: [],
      recentEdits: [],
      diagnostics: [],
      allowFormat: false,
    });
  }
}

const readSeed = (file: string): string[] => {
  const lines = readFileSync(path.join(root, "seeds", file), "utf8").split("\n");

  if (lines[lines.length - 1] === "") lines.pop();

  return lines;
};

const userLines = readSeed("user.ts");
const profileLines = readSeed("profile.ts");
const staleProfile = profileLines.map(line => line.replaceAll("user.displayName", "user.name"));
const renameEdit: RecentEdit = {
  path: "src/user.ts",
  before: "export type User = {\n  id: string;\n  name: string;\n  email: string;\n};",
  after: "export type User = {\n  id: string;\n  displayName: string;\n  email: string;\n};",
};

for (const [variant, cursor] of [
  ["near", endOf(staleProfile, 2)],
  ["far", endOf(staleProfile, 8)],
] as const) {
  writeCase({
    caseId: `profile-stale-rename-${variant}`,
    category: "stale-rename",
    variant,
    language: "typescript",
    targetPath: "src/profile.ts",
    cursor,
    files: { "src/profile.ts": staleProfile, "src/user.ts": userLines },
    expected: { "src/profile.ts": profileLines },
    candidatePaths: ["src/user.ts"],
    recentEdits: [renameEdit],
    diagnostics: [
      { line: 2, character: 52, severity: "error", source: "ts", message: "Property 'name' does not exist on type 'User'." },
      { line: 5, character: 7, severity: "error", source: "ts", message: "Property 'name' does not exist on type 'User'." },
    ],
    allowFormat: false,
  });
}

writeCase({
  caseId: "user-stale-rename-cross",
  category: "stale-rename-cross",
  variant: "away",
  language: "typescript",
  targetPath: "src/user.ts",
  cursor: { line: 2, character: 15 },
  files: { "src/user.ts": userLines, "src/profile.ts": staleProfile },
  expected: { "src/profile.ts": profileLines },
  candidatePaths: ["src/profile.ts"],
  recentEdits: [renameEdit],
  diagnostics: [],
  allowFormat: false,
});

const staleUser = userLines.map(line => (line.includes("`${user.displayName} <${user.email}>`") ? line.replaceAll("user.displayName", "user.name") : line));

for (const [variant, cursor] of [
  ["near", endOf(staleUser, 7)],
  ["far", endOf(staleUser, 13)],
] as const) {
  writeCase({
    caseId: `user-stale-rename-local-${variant}`,
    category: "stale-rename",
    variant,
    language: "typescript",
    targetPath: "src/user.ts",
    cursor,
    files: { "src/user.ts": staleUser },
    expected: { "src/user.ts": userLines },
    candidatePaths: [],
    recentEdits: [renameEdit],
    diagnostics: [
      { line: 7, character: 10, severity: "error", source: "ts", message: "Property 'name' does not exist on type 'User'." },
    ],
    allowFormat: false,
  });
}

for (const authored of burstCases) writeCase(authored);

const notesStale = [
  "# Release checklist",
  "",
  "The build pipeline runs on every push to the main branch. Once the",
  "artifacts are published, the release notes must be updated before",
  "",
  "## Packaging",
  "",
  "| step | command | owner |",
  "| --- | --- | --- |",
  "| build | pnpm build | ci |",
  "| sign | ./scripts/sign.sh | ops |",
  "| publish | pnpm publsh | ops |",
];

writeCase({
  caseId: "prose-sentence-near",
  category: "prose",
  variant: "near",
  language: "markdown",
  targetPath: "docs/notes.md",
  cursor: endOf(notesStale, 3),
  files: { "docs/notes.md": notesStale },
  expected: {},
  candidatePaths: [],
  recentEdits: [],
  diagnostics: [],
  allowFormat: false,
  prose: { inserted: "release", maxInsertedChars: 40 },
});

writeCase({
  caseId: "prose-table-near",
  category: "prose",
  variant: "near",
  language: "markdown",
  targetPath: "docs/notes.md",
  cursor: endOf(notesStale, notesStale.length - 1),
  files: { "docs/notes.md": notesStale },
  expected: {},
  candidatePaths: [],
  recentEdits: [],
  diagnostics: [],
  allowFormat: false,
  prose: { inserted: "publish", maxInsertedChars: 14 },
});

const byCategory = new Map<string, number>();

for (const held of written) byCategory.set(held.category, (byCategory.get(held.category) ?? 0) + 1);

console.log(`${written.length} cases`);

const ordered = [...byCategory].toSorted((left, right) => right[1] - left[1]);

for (const [category, count] of ordered) {
  console.log(`  ${category}: ${count}`);
}
