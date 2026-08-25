import { FIM_DEFAULTS, FIM_PLACEHOLDERS } from "./format/fim";
import { NEXT_EDIT_DEFAULTS, NEXT_EDIT_PLACEHOLDERS } from "./format/next-edit";
import { placeholdersIn } from "./format/template";

type Shared = {
  name: string;
  endpoint: string;
  apiKey: string;
  headers: Record<string, string>;
  model: string;
  maxTokens: number;
  temperature: number;
  stop: string[];
  extraBody: Record<string, unknown>;
  template: string;
  chunkTemplate: string;
};

export type Config
  = | (Shared & {
    format: "fim";
    prefixLines: number;
    suffixLines: number;
  })
  | (Shared & {
    format: "next-edit";
    changeTemplate: string;
    diagnosticTemplate: string;
    formatTemplate: string;
    cursorMarker: string;
    formatMarker: string;
    windowLines: number;
    contextLines: number;
    crossFileCandidates: number;
    contextFiles: number;
  });

export type ParseResult = {
  configurations: Config[];
  problems: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringAt = (source: Record<string, unknown>, key: string, fallback: string): string => {
  const value = source[key];

  return typeof value === "string" ? value : fallback;
};

const numberAt = (source: Record<string, unknown>, key: string, fallback: number): number => {
  const value = source[key];

  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const stringsAt = (source: Record<string, unknown>, key: string, fallback: string[]): string[] => {
  const value = source[key];

  if (!Array.isArray(value)) return fallback;

  return value.filter((entry): entry is string => typeof entry === "string");
};

const stringMapAt = (source: Record<string, unknown>, key: string): Record<string, string> => {
  const value = source[key];

  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

const recordAt = (source: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = source[key];

  return isRecord(value) ? value : {};
};

const unknownPlaceholders = (template: string, allowed: string[]): string[] =>
  placeholdersIn(template).filter(name => !allowed.includes(name));

const parseOne = (name: string, raw: unknown, problems: string[]): Config | undefined => {
  if (!isRecord(raw)) {
    problems.push(`${name}: is not an object`);

    return undefined;
  }

  const endpoint = stringAt(raw, "endpoint", "");
  const model = stringAt(raw, "model", "");
  const format = stringAt(raw, "format", "");

  if (endpoint === "") problems.push(`${name}: endpoint is missing`);

  if (model === "") problems.push(`${name}: model is missing`);

  if (format !== "fim" && format !== "next-edit") {
    problems.push(`${name}: format must be "fim" or "next-edit"`);

    return undefined;
  }

  if (endpoint === "" || model === "") return undefined;

  const defaults = format === "fim" ? FIM_DEFAULTS : NEXT_EDIT_DEFAULTS;

  const shared: Shared = {
    name,
    endpoint,
    model,
    apiKey: stringAt(raw, "apiKey", ""),
    headers: stringMapAt(raw, "headers"),
    maxTokens: numberAt(raw, "maxTokens", defaults.maxTokens),
    temperature: numberAt(raw, "temperature", defaults.temperature),
    stop: stringsAt(raw, "stop", defaults.stop),
    extraBody: recordAt(raw, "extraBody"),
    template: stringAt(raw, "template", defaults.template),
    chunkTemplate: stringAt(raw, "chunkTemplate", defaults.chunkTemplate),
  };

  const allowed = format === "fim" ? FIM_PLACEHOLDERS : NEXT_EDIT_PLACEHOLDERS;
  const strays = unknownPlaceholders(shared.template, allowed);

  if (strays.length > 0) {
    problems.push(`${name}: template names ${strays.join(", ")}, which tablet cannot fill for format ${format}`);

    return undefined;
  }

  const chunkStrays = unknownPlaceholders(shared.chunkTemplate, ["path", "text"]);

  if (chunkStrays.length > 0) {
    problems.push(`${name}: chunkTemplate names ${chunkStrays.join(", ")}, expected path or text`);

    return undefined;
  }

  if (format === "fim") {
    return {
      ...shared,
      format,
      prefixLines: numberAt(raw, "prefixLines", FIM_DEFAULTS.prefixLines),
      suffixLines: numberAt(raw, "suffixLines", FIM_DEFAULTS.suffixLines),
    };
  }

  const changeTemplate = stringAt(raw, "changeTemplate", NEXT_EDIT_DEFAULTS.changeTemplate);
  const changeStrays = unknownPlaceholders(changeTemplate, ["path", "before", "after"]);

  if (changeStrays.length > 0) {
    problems.push(`${name}: changeTemplate names ${changeStrays.join(", ")}, expected path, before or after`);

    return undefined;
  }

  const diagnosticTemplate = stringAt(raw, "diagnosticTemplate", NEXT_EDIT_DEFAULTS.diagnosticTemplate);
  const diagnosticStrays = unknownPlaceholders(diagnosticTemplate, ["path", "text"]);

  if (diagnosticStrays.length > 0) {
    problems.push(`${name}: diagnosticTemplate names ${diagnosticStrays.join(", ")}, expected path or text`);

    return undefined;
  }

  const formatTemplate = stringAt(raw, "formatTemplate", NEXT_EDIT_DEFAULTS.formatTemplate);
  const formatStrays = unknownPlaceholders(formatTemplate, ["marker"]);

  if (formatStrays.length > 0) {
    problems.push(`${name}: formatTemplate names ${formatStrays.join(", ")}, expected marker`);

    return undefined;
  }

  return {
    ...shared,
    format,
    changeTemplate,
    diagnosticTemplate,
    formatTemplate,
    cursorMarker: stringAt(raw, "cursorMarker", NEXT_EDIT_DEFAULTS.cursorMarker),
    formatMarker: stringAt(raw, "formatMarker", NEXT_EDIT_DEFAULTS.formatMarker),
    windowLines: numberAt(raw, "windowLines", NEXT_EDIT_DEFAULTS.windowLines),
    contextLines: numberAt(raw, "contextLines", NEXT_EDIT_DEFAULTS.contextLines),
    crossFileCandidates: numberAt(raw, "crossFileCandidates", NEXT_EDIT_DEFAULTS.crossFileCandidates),
    contextFiles: numberAt(raw, "contextFiles", NEXT_EDIT_DEFAULTS.contextFiles),
  };
};

export const parseConfigurations = (raw: unknown): ParseResult => {
  if (!isRecord(raw)) return { configurations: [], problems: ["tablet.configurations is not an object"] };

  const problems: string[] = [];
  const configurations: Config[] = [];

  for (const [name, value] of Object.entries(raw)) {
    const parsed = parseOne(name, value, problems);

    if (parsed !== undefined) configurations.push(parsed);
  }

  return { configurations, problems };
};

export const selectActive = (
  configurations: Config[],
  settingName: string,
  override: string | undefined,
): Config | undefined => {
  const byOverride = configurations.find(entry => entry.name === override);

  if (byOverride !== undefined) return byOverride;

  const bySetting = configurations.find(entry => entry.name === settingName);

  if (bySetting !== undefined) return bySetting;

  return configurations.length === 1 ? configurations[0] : undefined;
};

export const isLanguageEnabled = (languages: Record<string, boolean>, languageId: string): boolean =>
  languages[languageId] ?? languages["*"] ?? true;

export const PROSE_LANGUAGE_DEFAULTS = [
  "markdown",
  "plaintext",
  "text",
  "quarto",
  "rmarkdown",
  "rst",
  "asciidoc",
  "org",
  "latex",
  "tex",
];

export const isProseLanguage = (languages: string[], languageId: string): boolean => languages.includes(languageId);

const PROSE_WINDOW_LINES = 9;
const PROSE_CONTEXT_LINES = 60;
const PROSE_MAX_TOKENS = 160;

/**
 * Prose answers should read as a sentence ending or one precise correction, not a
 * rewritten paragraph: a small window, a small token budget, no formatter offer, and no
 * cross file wandering. Code settings are left untouched.
 */
export const proseProfile = (config: Config): Config =>
  (config.format === "next-edit"
    ? {
        ...config,
        windowLines: Math.min(config.windowLines, PROSE_WINDOW_LINES),
        contextLines: Math.min(config.contextLines, PROSE_CONTEXT_LINES),
        maxTokens: Math.min(config.maxTokens, PROSE_MAX_TOKENS),
        formatMarker: "",
        crossFileCandidates: 0,
        contextFiles: 0,
      }
    : config);
