import * as vscode from "vscode";

import type { Config } from "../config";
import type { Runtime } from "../runtime";
import { relativePath } from "../runtime";
import type { Suggestion } from "../suggest";
import { applyEdits } from "./apply-edits";
import { padEdit, reduceToEdit } from "./window-diff";

export const uriFor = (path: string): vscode.Uri | undefined => {
  const folder = vscode.workspace.workspaceFolders?.[0];

  return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, path);
};

/**
 * A jump costs a keypress of its own: the first tab moves, the second accepts. That price
 * is only worth paying when the edit starts somewhere the reader cannot see. An edit
 * beginning on the cursor line, or anywhere on screen, is offered for accepting straight
 * away. A jump to the line the cursor is already on would also never resolve: the editor
 * keeps offering the jump and the reader never reaches the edit behind it.
 */
const requiresJump = (target: vscode.TextDocument, isSameFile: boolean, start: vscode.Position, cursor: vscode.Position): boolean => {
  if (!isSameFile) return true;

  if (start.line === cursor.line) return false;

  const editor = vscode.window.visibleTextEditors.find(held => held.document === target);

  return !(editor?.visibleRanges.some(range => range.contains(start)) ?? false);
};

const editItem = async (suggestion: Suggestion, document: vscode.TextDocument, config: Config, cursor: vscode.Position): Promise<vscode.InlineCompletionItem | undefined> => {
  if (suggestion.kind !== "edit") return undefined;

  const isSameFile = suggestion.path === relativePath(document.uri);
  const uri = isSameFile ? document.uri : uriFor(suggestion.path);

  if (uri === undefined) return undefined;

  // an insertion sitting exactly where the cursor is, is what the reader is typing towards,
  // so it belongs in the ordinary suggestion slot rather than as an edit with a jump
  const isEmptyRange = suggestion.startLine === suggestion.endLine
    && suggestion.startCharacter === suggestion.endCharacter;

  const isAtCursor = isSameFile
    && isEmptyRange
    && suggestion.startLine === cursor.line
    && suggestion.startCharacter === cursor.character;

  if (isAtCursor) return new vscode.InlineCompletionItem(suggestion.text, new vscode.Range(cursor, cursor));

  const target = isSameFile ? document : await vscode.workspace.openTextDocument(uri);
  const lastLine = target.lineCount - 1;

  const padded = padEdit(
    {
      startLine: Math.min(suggestion.startLine, lastLine),
      startCharacter: suggestion.startCharacter,
      endLine: Math.min(suggestion.endLine, lastLine),
      endCharacter: suggestion.endCharacter,
      text: suggestion.text,
    },
    target.getText().split(/\r?\n/),
  );

  const start = new vscode.Position(padded.startLine, padded.startCharacter);
  const end = new vscode.Position(padded.endLine, Math.min(padded.endCharacter, target.lineAt(padded.endLine).range.end.character));
  const range = new vscode.Range(start, end);

  if (target.getText(range) === padded.text) return undefined;

  const item = new vscode.InlineCompletionItem(padded.text, range);

  item.isInlineEdit = true;
  item.showInlineEditMenu = true;

  if (requiresJump(target, isSameFile, start, cursor)) item.jumpToPosition = start;

  if (isSameFile) {
    if (config.format === "next-edit") {
      // showRange hides the edit whenever the cursor is outside it, so it has to cover the
      // cursor as well as the edit: an edit offered without a jump is otherwise invisible
      // from a cursor further away than the padding
      const span = Math.max(1, config.windowLines);
      const shownFrom = Math.max(0, Math.min(start.line, cursor.line) - span);
      const shownUpto = Math.min(lastLine, Math.max(end.line, cursor.line) + span);

      item.showRange = new vscode.Range(shownFrom, 0, shownUpto, 0);
    }
  }
  else {
    item.uri = uri;
  }

  return item;
};

/**
 * The model only says that formatting is what it wants. What formatting means is the
 * language's own formatter, so its edits are what gets offered, never a guess at them.
 */
const formatItem = async (document: vscode.TextDocument, cursor: vscode.Position): Promise<vscode.InlineCompletionItem | undefined> => {
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>(
    "vscode.executeFormatDocumentProvider",
    document.uri,
    { tabSize: 2, insertSpaces: true },
  );

  if (edits === undefined || edits.length === 0) return undefined;

  const before = document.getText();

  const after = applyEdits(before, edits.map(edit => ({
    startLine: edit.range.start.line,
    startCharacter: edit.range.start.character,
    endLine: edit.range.end.line,
    endCharacter: edit.range.end.character,
    text: edit.newText,
  })));

  const reduced = reduceToEdit(before.split(/\r?\n/), after.split(/\r?\n/), 0);

  if (reduced === undefined) return undefined;

  const padded = padEdit({ ...reduced, endLine: Math.min(reduced.endLine, document.lineCount - 1) }, before.split(/\r?\n/));
  const endCharacter = Math.min(padded.endCharacter, document.lineAt(padded.endLine).range.end.character);
  const start = new vscode.Position(padded.startLine, padded.startCharacter);
  const end = new vscode.Position(padded.endLine, endCharacter);
  const item = new vscode.InlineCompletionItem(padded.text, new vscode.Range(start, end));

  item.isInlineEdit = true;
  item.showInlineEditMenu = true;

  if (requiresJump(document, true, start, cursor)) item.jumpToPosition = start;

  return item;
};

/**
 * The model never asks for the formatter by itself and leaves pure whitespace faults
 * alone. When it has nothing to say and the formatter would change a line the linter is
 * flagging, the formatter offer is made here instead of waiting for the model to make it.
 */
export const formatFallback = async (runtime: Runtime, document: vscode.TextDocument, cursor: vscode.Position): Promise<vscode.InlineCompletionItem | undefined> => {
  const declined = runtime.declined;

  if (declined !== undefined && declined.path === relativePath(document.uri) && declined.text === document.getText()) {
    return undefined;
  }

  const flagged = vscode.languages.getDiagnostics(document.uri).map(entry => entry.range.start.line);

  if (flagged.length === 0) return undefined;

  const item = await formatItem(document, cursor);
  const range = item?.range;

  if (item === undefined || range === undefined) return undefined;

  return flagged.some(line => line >= range.start.line && line <= range.end.line) ? item : undefined;
};

/** What the editor was actually handed, which is the last place a suggestion can go missing. */
export const describeItem = (item: vscode.InlineCompletionItem): string => {
  const where = item.range === undefined
    ? "at the cursor"
    : `${item.range.start.line}:${item.range.start.character} to ${item.range.end.line}:${item.range.end.character}`;

  // an inline edit only renders when the editor was started with enable-proposed-api, and
  // there is no way to ask it whether that happened, so the reminder rides along here
  const kind = item.isInlineEdit === true ? "edit, needs enable-proposed-api to render," : "completion";

  return `${kind} ${where} ${JSON.stringify(String(item.insertText).slice(0, 60))}`;
};

export const itemsFor = async (
  suggestions: Suggestion[],
  document: vscode.TextDocument,
  position: vscode.Position,
  config: Config,
): Promise<vscode.InlineCompletionItem[]> => {
  const items: vscode.InlineCompletionItem[] = [];

  for (const suggestion of suggestions) {
    if (suggestion.kind === "completion") {
      items.push(new vscode.InlineCompletionItem(suggestion.text, new vscode.Range(position, position)));

      continue;
    }

    if (suggestion.kind === "format") {
      const formatted = await formatItem(document, position);

      if (formatted !== undefined) items.push(formatted);

      continue;
    }

    const item = await editItem(suggestion, document, config, position);

    if (item !== undefined) items.push(item);
  }

  return items;
};
