import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);
export const FINDINGS_WATCH_MS = 2_000;

export interface FindingCard {
  path: string;
  relativePath: string;
  engagement?: string;
  host?: string;
  class?: string;
  title: string;
  summary: string;
  severity?: string;
}

export interface ParsedFindingPath {
  path: string;
  relativePath: string;
  engagement?: string;
  host?: string;
  class?: string;
  fileName: string;
}

export async function listFindingFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  await walk(root, false, found);
  found.sort();
  return found;
}

export function countFindingFiles(files: readonly string[]): number {
  return files.length;
}

export function parseFindingPath(filePath: string, cwd: string): ParsedFindingPath {
  const relativePath = relative(cwd, filePath).split("\\").join("/");
  const parts = relativePath.split("/").filter(Boolean);
  const fileName = parts.at(-1) ?? basename(filePath);
  const findingsIdx = parts.lastIndexOf("findings");
  const engagementsIdx = parts.indexOf("engagements");
  const outIdx = parts.indexOf("out");
  const engagement =
    engagementsIdx >= 0 && outIdx === engagementsIdx + 2 ? parts[engagementsIdx + 1] : undefined;
  const host = outIdx >= 0 && findingsIdx === outIdx + 2 ? parts[outIdx + 1] : undefined;
  const findingClass =
    findingsIdx >= 0 && findingsIdx + 1 < parts.length - 1 ? parts[findingsIdx + 1] : undefined;
  return {
    path: filePath,
    relativePath,
    fileName,
    ...(engagement ? { engagement } : {}),
    ...(host ? { host } : {}),
    ...(findingClass ? { class: findingClass } : {}),
  };
}

export function parseFindingMarkdown(content: string): {
  title: string;
  summary: string;
  severity?: string;
} {
  const lines = content.split(/\r?\n/);
  let title = "";
  let severity: string | undefined;
  const body: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading && !title) {
      title = heading[1].trim();
      continue;
    }
    const sev = /^(?:severity|schwere)\s*:\s*(.+)$/i.exec(line);
    if (sev) {
      severity = sev[1].trim();
      continue;
    }
    body.push(line);
  }
  const summary = (body[0] ?? "").slice(0, 240);
  return {
    title: title || summary.slice(0, 80) || "Finding",
    summary,
    ...(severity ? { severity } : {}),
  };
}

export async function summarizeFindingFile(filePath: string, cwd: string): Promise<FindingCard> {
  const parsed = parseFindingPath(filePath, cwd);
  const fallbackTitle = parsed.fileName.replace(/\.md$/i, "");
  let title = fallbackTitle;
  let summary = "";
  let severity: string | undefined;
  try {
    const markdown = parseFindingMarkdown(await readFile(filePath, "utf8"));
    title = markdown.title === "Finding" ? fallbackTitle : markdown.title;
    summary = markdown.summary;
    severity = markdown.severity;
  } catch {
    // Keep the file name when the finding cannot be read yet.
  }
  return {
    path: parsed.path,
    relativePath: parsed.relativePath,
    title,
    summary,
    ...(parsed.engagement ? { engagement: parsed.engagement } : {}),
    ...(parsed.host ? { host: parsed.host } : {}),
    ...(parsed.class ? { class: parsed.class } : {}),
    ...(severity ? { severity } : {}),
  };
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
