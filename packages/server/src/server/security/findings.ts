import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);
export const FINDINGS_WATCH_MS = 2_000;

export interface FindingAlsoFound {
  relativePath: string;
  providerId?: string;
  modelId?: string;
}

export interface FindingCard {
  path: string;
  relativePath: string;
  engagement?: string;
  host?: string;
  class?: string;
  title: string;
  summary: string;
  severity?: string;
  providerId?: string;
  modelId?: string;
  chain?: string;
  prior?: boolean;
  alsoFoundBy?: FindingAlsoFound[];
}

export interface ParsedFindingPath {
  path: string;
  relativePath: string;
  engagement?: string;
  host?: string;
  class?: string;
  fileName: string;
}

const GENERIC_SCOPE_NAMES = new Set([
  "build",
  "dist",
  "engagements",
  "findings",
  "git",
  "node_modules",
  "out",
  "poc",
  "research",
  "review",
  "src",
]);

export function resolveFindingScopes(input: {
  topLevel: readonly string[];
  engagements: readonly string[];
  text: string;
}): string[] {
  const scopes: string[] = [];
  const seen = new Set<string>();
  const add = (scope: string) => {
    if (seen.has(scope)) return;
    seen.add(scope);
    scopes.push(scope);
  };
  for (const name of input.topLevel) {
    if (!isCampaignToken(name, input.text)) continue;
    add(`${name}/`);
  }
  for (const name of input.engagements) {
    if (!isCampaignToken(name, input.text)) continue;
    add(`engagements/${name}/`);
  }
  for (const name of input.topLevel) {
    if (!scopes.some((scope) => scope === `${name}/` || scope === `engagements/${name}/`)) continue;
    add(`engagements/${name}/`);
  }
  return scopes;
}

function isCampaignToken(name: string, text: string): boolean {
  const token = name.trim().toLowerCase();
  if (token.length < 4 || GENERIC_SCOPE_NAMES.has(token)) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(text);
}

export async function listFindingFiles(
  root: string,
  options?: { scopes?: readonly string[] },
): Promise<string[]> {
  const scopes = options?.scopes;
  if (scopes && scopes.length === 0) return [];
  const found: string[] = [];
  if (scopes) {
    for (const scope of scopes) {
      const parts = scope.split("/").filter(Boolean);
      await walk(join(root, ...parts), false, found);
    }
  } else {
    await walk(root, false, found);
  }
  const unique = [...new Set(found)];
  unique.sort();
  if (!scopes) return unique;
  return unique.filter((filePath) => {
    const relativePath = relative(root, filePath).split("\\").join("/");
    return scopes.some(
      (scope) => relativePath === scope.slice(0, -1) || relativePath.startsWith(scope),
    );
  });
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
  chain?: string;
} {
  const lines = content.split(/\r?\n/);
  let title = "";
  let severity: string | undefined;
  let chain: string | undefined;
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
    const linked = /^(?:chain|kette)\s*:\s*(.+)$/i.exec(line);
    if (linked) {
      chain = linked[1].trim();
      continue;
    }
    body.push(line);
  }
  const summary = (body[0] ?? "").slice(0, 240);
  return {
    title: title || summary.slice(0, 80) || "Finding",
    summary,
    ...(severity ? { severity } : {}),
    ...(chain ? { chain } : {}),
  };
}

export async function summarizeFindingFile(filePath: string, cwd: string): Promise<FindingCard> {
  const parsed = parseFindingPath(filePath, cwd);
  const fallbackTitle = parsed.fileName.replace(/\.md$/i, "");
  let title = fallbackTitle;
  let summary = "";
  let severity: string | undefined;
  let chain: string | undefined;
  try {
    const markdown = parseFindingMarkdown(await readFile(filePath, "utf8"));
    title = markdown.title === "Finding" ? fallbackTitle : markdown.title;
    summary = markdown.summary;
    severity = markdown.severity;
    chain = markdown.chain;
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
    ...(chain ? { chain } : {}),
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
