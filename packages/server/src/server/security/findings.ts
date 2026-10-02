import { readdir } from "node:fs/promises";
import { join } from "node:path";

const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

export async function listFindingFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  await walk(root, false, found);
  found.sort();
  return found;
}

export function countFindingFiles(files: readonly string[]): number {
  return files.length;
}

async function walk(dir: string, underFindings: boolean, found: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const isFindingsDir = underFindings || entry.name === "findings";
    if (entry.isDirectory()) {
      await walk(path, isFindingsDir, found);
      continue;
    }
    if (entry.isFile() && underFindings) found.push(path);
  }
}
