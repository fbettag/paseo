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
  const display = title || sourceTitle(content) || "";
  return {
    title: display || "Finding",
    summary: summaryLine(body, display),
    ...(severity ? { severity } : {}),
    ...(chain ? { chain } : {}),
  };
}

export async function summarizeFindingFile(filePath: string, cwd: string): Promise<FindingCard> {
  const parsed = parseFindingPath(filePath, cwd);
  const fallbackTitle = humanizeFindingFileName(parsed.fileName);
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

const TITLE_LIMIT = 140;

function humanizeFindingFileName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/i, "");
  const words = stem.split(/[-_]+/).filter((word) => word.length > 0);
  if (words.length === 0) return stem || fileName;
  return words
    .map((word, index) => {
      if (/^f\d+$/i.test(word)) return word.toUpperCase();
      if (index > 0) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function sourceTitle(content: string): string | null {
  const parts: string[] = [];
  const lines = content.split(/\r?\n/);
  const limit = Math.min(lines.length, 40);
  for (let index = 0; index < limit; index += 1) {
    const raw = lines[index] ?? "";
    const subject = subjectText(raw);
    if (subject && isUsefulTitle(subject)) return clipTitle(subject);
    if (isNoiseHeader(raw)) {
      if (parts.length > 0 && isParagraphBreak(raw)) break;
      continue;
    }
    if (isSourceCodeLine(raw)) break;
    const text = commentText(raw);
    if (!isUsefulTitle(text)) continue;
    parts.push(text);
    const joined = parts.join(" ");
    if (/[.!?]\)?$/.test(text) || joined.length >= TITLE_LIMIT) return clipTitle(joined);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!isUsefulTitle(joined)) return null;
  return clipTitle(joined);
}

function summaryLine(body: readonly string[], title: string): string {
  for (const raw of body) {
    if (isNoiseHeader(raw)) continue;
    const text = commentText(raw);
    if (!text) continue;
    if (title && (text === title || title.includes(text))) continue;
    return text.slice(0, 240);
  }
  return "";
}

function subjectText(line: string): string | null {
  const match = /^Subject:\s*(.+)$/i.exec(line.trim());
  if (!match?.[1]) return null;
  return match[1].replace(/^(?:\[[^\]]+\]\s*)+/, "").trim();
}

function isNoiseHeader(raw: string): boolean {
  const line = raw.trim();
  if (!line || line.startsWith("#!")) return true;
  if (isPreprocessor(line) || isGitHeader(line) || isBareDelimiter(line)) return true;
  const text = commentText(line);
  if (!text) return true;
  if (/^(?:-{2,}|[=~*]{3,})\s*$/.test(text)) return true;
  if (/^(?:-{2,}\s*)?source commits?$/i.test(text)) return true;
  if (/^spdx-license-identifier:/i.test(text)) return true;
  if (/^copyright\b/i.test(text)) return true;
  if (/^(?:severity|schwere|chain|kette|status|reported)\s*:/i.test(text)) return true;
  return false;
}

function isPreprocessor(line: string): boolean {
  return /^#(?:include|define|if|ifdef|ifndef|pragma|error|undef|else|elif|endif|line)\b/.test(
    line,
  );
}

function isGitHeader(line: string): boolean {
  if (/^From [0-9a-fA-F]{40}\b/.test(line)) return true;
  if (/^(?:From|Date):\s/.test(line)) return true;
  return /^(?:diff --git|index |---|\+\+\+|@@ )/.test(line);
}

function isBareDelimiter(line: string): boolean {
  return /^(?:\/\*+|\*\/|\*+|\/\/|#)$/.test(line);
}

function isParagraphBreak(raw: string): boolean {
  const line = raw.trim();
  return line.length === 0 || isBareDelimiter(line);
}

function isSourceCodeLine(raw: string): boolean {
  const line = raw.trim();
  if (!line || line.startsWith("/*") || line.startsWith("*") || line.startsWith("//")) return false;
  if (line.startsWith("#")) return false;
  if (
    /^(?:typedef|struct|enum|union|static|extern|const|unsigned|signed|void|int|char|long|short|size_t|bool)\b/.test(
      line,
    )
  ) {
    return true;
  }
  if (/^(?:uint\d+_t|int\d+_t|float|double)\b/.test(line)) return true;
  if (/[{};]\s*$/.test(line)) return true;
  return /^(?:set|export|local)\s+/.test(line);
}

function commentText(line: string): string {
  let text = line.trim();
  text = text.replace(/^\/\*+\s?/, "");
  text = text.replace(/\s*\*+\/$/, "");
  text = text.replace(/^(?:\*\s?|\/\/\s?|#\s?)/, "");
  return text.trim();
}

function isUsefulTitle(text: string): boolean {
  const words = text.match(/[A-Za-z][A-Za-z0-9_+-]*/g) ?? [];
  return words.length >= 2 && words.join("").length >= 8;
}

function clipTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= TITLE_LIMIT) return flat;
  const cut = flat.slice(0, TITLE_LIMIT);
  const space = cut.lastIndexOf(" ");
  return (space > 40 ? cut.slice(0, space) : cut).trim();
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
