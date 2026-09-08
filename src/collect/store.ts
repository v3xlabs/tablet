import type { Dirent } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CollectedRecord } from "./record";
import { redactRecord } from "./record";

const safeName = (name: string): string => name.replaceAll(/[^\w.-]+/g, "_");

export const collectRoot = (globalStoragePath: string): string => path.join(globalStoragePath, "collect");

const dayOf = (timestamp: string): string => timestamp.slice(0, 10);

/** One file per workspace per day, appended as records complete. */
export const appendRecord = async (globalStoragePath: string, record: CollectedRecord): Promise<string> => {
  const folder = path.join(collectRoot(globalStoragePath), safeName(record.workspace));
  const file = path.join(folder, `${dayOf(record.timestamp)}.jsonl`);

  await mkdir(folder, { recursive: true });
  await appendFile(file, `${JSON.stringify(redactRecord(record))}\n`, "utf8");

  return file;
};

const entriesOf = async (folder: string): Promise<Dirent[]> => {
  try {
    return await readdir(folder, { withFileTypes: true });
  }
  catch {
    return [];
  }
};

const jsonlFilesUnder = async (folder: string): Promise<string[]> => {
  const entries = await entriesOf(folder);
  const found: string[] = [];

  for (const entry of entries) {
    const full = path.join(folder, entry.name);

    if (entry.isDirectory()) found.push(...await jsonlFilesUnder(full));
    else if (entry.name.endsWith(".jsonl") && !entry.name.startsWith("tablet-dataset-")) found.push(full);
  }

  return found.toSorted((left, right) => left.localeCompare(right));
};

/** Concatenates every day file into one, which is the hand-off shape: one file, one record per line. */
export const exportRecords = async (globalStoragePath: string, timestamp: string): Promise<{ file: string; count: number; }> => {
  const root = collectRoot(globalStoragePath);
  const files = await jsonlFilesUnder(root);
  const parts: string[] = [];
  let count = 0;

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lines = text.split("\n").filter(line => line !== "");

    count += lines.length;
    parts.push(...lines);
  }

  const out = path.join(root, `tablet-dataset-${timestamp.replaceAll(":", "-")}.jsonl`);

  await mkdir(root, { recursive: true });
  await writeFile(out, parts.length === 0 ? "" : `${parts.join("\n")}\n`, "utf8");

  return { file: out, count };
};
