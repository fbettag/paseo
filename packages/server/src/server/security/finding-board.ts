import { join } from "node:path";

export type FindingBoardStatus = "open" | "reported" | "chained" | "chained, reported";

export interface FindingBoardEntry {
  status: FindingBoardStatus;
  title: string;
  relativePath: string;
}

const BOARD_LINE = /^-\s+((?:chained, reported|chained|reported|open)\s+\|.+)$/m;

export function boardPathFor(cwd: string, agentId: string): string {
  const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return join(cwd, ".paseo", `security-board-${safe || "campaign"}.md`);
}

export function findingBoardStatus(markdown: string): FindingBoardStatus {
  const chained = markdownHasChain(markdown);
  const reported = markdownIsReported(markdown);
  if (chained && reported) return "chained, reported";
  if (chained) return "chained";
  if (reported) return "reported";
  return "open";
}

export function renderFindingBoard(entries: readonly FindingBoardEntry[]): string {
  const lines = [
    "# Finding board",
    "Built once at session start from the current findings. Do not rebuild this file.",
    "",
  ];
  if (entries.length === 0) {
    lines.push("No current findings.");
  } else {
    for (const entry of entries) lines.push(`- ${formatBoardEntry(entry)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatBoardEntry(entry: FindingBoardEntry): string {
  return `${entry.status} | ${entry.title} | ${entry.relativePath}`;
}

export function boardLooksWritten(content: string): boolean {
  if (!content.includes("# Finding board")) return false;
  if (content.includes("No current findings.")) return true;
  return BOARD_LINE.test(content);
}

export function boardEntryLines(content: string): string[] {
  const lines: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const match = BOARD_LINE.exec(raw.trim());
    if (match?.[1]) lines.push(match[1]);
  }
  return lines.slice(0, 40);
}

export function boardBuilderPrompt(input: {
  boardPath: string;
  scopes: readonly string[];
  files: readonly string[];
}): string {
  const listed = input.files.slice(0, 80);
  const extra = input.files.length - listed.length;
  const lines = [
    "Build the finding board once from the current finding files. Do not rebuild it later.",
    "Read the finding files. Write only the board file. Do not edit application source and do not write a new finding.",
    "Reply with one line: how many findings you marked open, reported, chained, and chained, reported.",
    "Do not paste finding bodies into the reply.",
    `Board file: ${input.boardPath}`,
    "Scopes:",
    ...input.scopes.map((scope) => `- ${scope}`),
    "Mark each current finding with exactly one status:",
    "- open",
    "- reported, when it was already submitted or accepted as a report",
    "- chained, when it is part of an exploit chain or has a Chain: line",
    "- chained, reported, when both are true",
    "Do not mark text that only says never reported, not reported, or reporting bar.",
    "Write this shape:",
    "# Finding board",
    "Built once at session start from the current findings. Do not rebuild this file.",
    "",
    "- <status> | <title> | <relative path>",
    "Current finding files:",
    ...listed.map((file) => `- ${file}`),
  ];
  if (extra > 0) lines.push(`- ${extra} more finding files under the scopes`);
  return lines.join("\n");
}

function markdownHasChain(markdown: string): boolean {
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(?:chain|kette)\s*:\s*\S/i.test(trimmed)) return true;
    if (/^status\s*:/i.test(trimmed) && /\bchained\b/i.test(trimmed)) return true;
  }
  return false;
}

function markdownIsReported(markdown: string): boolean {
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^status\s*:/i.test(trimmed) && !/^reported\s*:/i.test(trimmed)) continue;
    if (/\b(?:never|not)\s+reported\b/i.test(trimmed)) continue;
    if (/\breporting bar\b/i.test(trimmed)) continue;
    if (/^reported\s*:\s*(?:yes|true)\b/i.test(trimmed)) return true;
    if (/^status\s*:.*\breported\b/i.test(trimmed)) return true;
  }
  return false;
}
