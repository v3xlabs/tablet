import path from "node:path";

import typescript from "typescript";

import type { Diagnostic } from "../src/context/diagnostics";

const options: typescript.CompilerOptions = {
  strict: true,
  noEmit: true,
  noUnusedLocals: true,
  target: typescript.ScriptTarget.ES2023,
  lib: ["lib.es2023.d.ts"],
  module: typescript.ModuleKind.ESNext,
  moduleResolution: typescript.ModuleResolutionKind.Bundler,
  jsx: typescript.JsxEmit.ReactJSX,
};

// the seeds are standalone snippets, so anything about unresolvable modules, the absent
// jsx runtime types, or the implicit any that unresolved imports leak into callback
// parameters is noise rather than a fault in the snippet
const UNRESOLVABLE_WORLD_CODES = new Set([2307, 2792, 2875, 7006, 7016, 7026]);

const libraryFolder = path.dirname(typescript.getDefaultLibFilePath(options));
const libraryCache = new Map<string, typescript.SourceFile | undefined>();

const librarySourceFile = (libraryPath: string): typescript.SourceFile | undefined => {
  if (!libraryCache.has(libraryPath)) {
    const text = typescript.sys.readFile(libraryPath);

    libraryCache.set(libraryPath, text === undefined ? undefined : typescript.createSourceFile(libraryPath, text, typescript.ScriptTarget.ES2023));
  }

  return libraryCache.get(libraryPath);
};

const severityOf = (category: typescript.DiagnosticCategory): string | undefined => {
  if (category === typescript.DiagnosticCategory.Error) return "error";

  if (category === typescript.DiagnosticCategory.Warning) return "warning";

  return undefined;
};

export const diagnoseTypescript = (fileName: string, text: string): Diagnostic[] => {
  const sourceFile = typescript.createSourceFile(fileName, text, typescript.ScriptTarget.ES2023, true);

  const host: typescript.CompilerHost = {
    getSourceFile: requested => (requested === fileName ? sourceFile : librarySourceFile(requested)),
    getDefaultLibFileName: () => typescript.getDefaultLibFilePath(options),
    getDefaultLibLocation: () => libraryFolder,
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: requested => requested,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: requested => requested === fileName,
    readFile: requested => (requested === fileName ? text : undefined),
  };

  const program = typescript.createProgram([fileName], options, host);
  const raw = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];

  return raw.flatMap((held): Diagnostic[] => {
    if (held.file === undefined || held.start === undefined) return [];

    if (UNRESOLVABLE_WORLD_CODES.has(held.code)) return [];

    // tsc grades unused locals as errors, but editors surface them softly, and the
    // corpus records them the way an editor would
    const severity = held.reportsUnnecessary === undefined ? severityOf(held.category) : "warning";

    if (severity === undefined) return [];

    const { line, character } = held.file.getLineAndCharacterOfPosition(held.start);

    return [{ line, character, severity, source: "ts", message: typescript.flattenDiagnosticMessageText(held.messageText, "\n") }];
  });
};
