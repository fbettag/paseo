import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_TRUNCATE_HEAD_CHARS, truncateToolResultText } from "./admit-text-result.js";
import type { CompactToolDecision, CompactToolSnapshot } from "./compact-tool-history.js";

export interface GrokHistoryRewriteResult {
  text: string;
  applied: number;
  droppedChars: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function grokToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (isRecord(entry) && typeof entry.text === "string") return entry.text;
        return "";
      })
      .join("");
  }
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return "";
}

export function grokCallCommand(name: string, args: unknown): string {
  let raw = "";
  if (typeof args === "string") raw = args;
  else if (args != null) raw = JSON.stringify(args);
  return `${name} ${raw}`.trim();
}

export function collectGrokCompactSnapshots(jsonl: string): CompactToolSnapshot[] {
  const calls = new Map<string, { name: string; command: string }>();
  const snapshots: CompactToolSnapshot[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (record.type === "assistant" && Array.isArray(record.tool_calls)) {
      for (const call of record.tool_calls) {
        if (!isRecord(call)) continue;
        const id = typeof call.id === "string" ? call.id : "";
        const name = typeof call.name === "string" ? call.name : "tool";
        if (!id) continue;
        calls.set(id, { name, command: grokCallCommand(name, call.arguments) });
      }
      continue;
    }
    if (record.type !== "tool_result") continue;
    const itemId = typeof record.tool_call_id === "string" ? record.tool_call_id : "";
    const output = grokToolResultText(record.content);
    if (!itemId || output.length <= DEFAULT_TRUNCATE_HEAD_CHARS) continue;
    const call = calls.get(itemId);
    snapshots.push({
      itemId,
      command: call?.command ?? call?.name ?? "tool",
      resultChars: output.length,
      resultHead: output.slice(0, 800),
      isError: false,
    });
  }
  return snapshots;
}

export function findGrokChatHistoryFile(grokHome: string, sessionId: string): string | null {
  const sessionsDir = path.join(grokHome, "sessions");
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir, { recursive: true, encoding: "utf8" });
  } catch {
    return null;
  }
  const needle = path.join(sessionId, "chat_history.jsonl");
  for (const relative of entries) {
    if (
      relative === needle ||
      relative.endsWith(`/${needle}`) ||
      relative.endsWith(`\\${needle}`)
    ) {
      return path.join(sessionsDir, relative);
    }
  }
  return null;
}

export function applyDroppedOutputsToGrokChatHistory(
  jsonl: string,
  decisions: CompactToolDecision[],
): GrokHistoryRewriteResult {
  const drops = new Map(
    decisions
      .filter((decision) => decision.decision === "drop")
      .map((decision) => [decision.itemId, decision]),
  );
  if (drops.size === 0) {
    return { text: jsonl, applied: 0, droppedChars: 0 };
  }
  const lines = jsonl.split("\n");
  let applied = 0;
  let droppedChars = 0;
  const rewritten = lines.map((line) => {
    if (line.trim().length === 0) return line;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return line;
    }
    if (!isRecord(record) || record.type !== "tool_result") return line;
    const itemId = typeof record.tool_call_id === "string" ? record.tool_call_id : "";
    const decision = drops.get(itemId);
    if (!decision) return line;
    drops.delete(itemId);
    applied += 1;
    droppedChars += decision.resultChars;
    return JSON.stringify({
      ...record,
      content: truncateToolResultText(
        grokToolResultText(record.content),
        DEFAULT_TRUNCATE_HEAD_CHARS,
      ),
    });
  });
  return { text: rewritten.join("\n"), applied, droppedChars };
}

export function rewriteGrokChatHistoryFile(
  filePath: string,
  decisions: CompactToolDecision[],
): GrokHistoryRewriteResult {
  const original = readFileSync(filePath, "utf8");
  const result = applyDroppedOutputsToGrokChatHistory(original, decisions);
  if (result.applied === 0) return result;
  const tempPath = `${filePath}.jev-tmp`;
  writeFileSync(tempPath, result.text);
  renameSync(tempPath, filePath);
  return result;
}
