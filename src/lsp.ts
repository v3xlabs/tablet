import * as vscode from "vscode";

import { excerptAround, identifiersOn } from "./context/definitions";
import type { Chunk } from "./context/ring-buffer";
import { isSecretPath, redactSecrets } from "./context/sanitize";
import { relativePath } from "./runtime";
import type { Snapshot } from "./snapshot";

const MAX_DEFINITIONS = 6;
const LOOKUP_TIMEOUT_MS = 400;
const VISIBLE_SPAN = 20;

type Target = { uri: vscode.Uri; line: number; };

const targetsOf = (found: Array<vscode.Location | vscode.LocationLink> | undefined): Target[] =>
  (found ?? []).map(entry => ("targetUri" in entry
    ? { uri: entry.targetUri, line: (entry.targetSelectionRange ?? entry.targetRange).start.line }
    : { uri: entry.uri, line: entry.range.start.line }));

const withTimeout = <T>(promise: Thenable<T>, fallback: T): Promise<T> =>
  Promise.race([Promise.resolve(promise), new Promise<T>(resolve => setTimeout(() => resolve(fallback), LOOKUP_TIMEOUT_MS))]);

/**
 * What the names on the cursor line mean, asked of the same providers that answer go to
 * definition. Zed reports this as the largest single gain in zeta 2. A definition already
 * on screen, or in a file that holds secrets, is left out.
 */
export const definitionChunks = async (document: vscode.TextDocument, position: vscode.Position, snapshot: Snapshot): Promise<Chunk[]> => {
  const line = snapshot.lines[position.line] ?? "";
  const names = identifiersOn(line, position.character);

  const lookups = names.map(name => withTimeout(
    vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      "vscode.executeDefinitionProvider",
      document.uri,
      new vscode.Position(position.line, name.character),
    ),
    [],
  ));

  const results = await Promise.all(lookups);
  const targets = results.flatMap(found => targetsOf(found));
  const seen = new Set<string>();
  const chunks: Chunk[] = [];

  const chunkFor = async (target: Target): Promise<Chunk | undefined> => {
    const key = `${target.uri.toString()}:${target.line}`;

    if (seen.has(key) || target.uri.scheme !== "file") return undefined;

    seen.add(key);

    const isSameFile = target.uri.toString() === document.uri.toString();

    if (isSameFile && Math.abs(target.line - position.line) <= VISIBLE_SPAN) return undefined;

    const path = relativePath(target.uri);

    if (isSecretPath(path)) return undefined;

    const text = isSameFile ? document : await vscode.workspace.openTextDocument(target.uri);
    const excerpt = excerptAround(text.getText().split(/\r?\n/), target.line);

    return { path, startLine: excerpt.startLine, lines: excerpt.lines.map(held => redactSecrets(held)) };
  };

  for (const target of targets) {
    if (chunks.length >= MAX_DEFINITIONS) break;

    const chunk = await chunkFor(target);

    if (chunk !== undefined) chunks.push(chunk);
  }

  return chunks;
};
