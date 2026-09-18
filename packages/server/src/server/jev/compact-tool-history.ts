import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import { JevClient, JevRequestError, noulAnswer } from "./client.js";
import { DEFAULT_TRUNCATE_HEAD_CHARS, truncateToolResultText } from "./admit-text-result.js";

export const COMPACT_KEEP_THRESHOLD = 0.7;
export const COMPACT_MAX_SCORED_TOOLS = 16;
export const COMPACT_DROP_INSTRUCTIONS =
  "This conversation is being compacted. Should this past shell/tool result stay verbatim for later turns? Answer high only if it contains unique facts that cannot be reconstructed by re-running the command, such as secrets, IDs, error traces, or computed numbers. Long dumps, seq/yes/cat output, directory listings, and logs that can be regenerated should be dropped.";

export interface CompactToolSnapshot {
  itemId: string;
  command: string;
  resultChars: number;
  resultHead: string;
  isError: boolean;
}

export interface CompactToolDecision {
  itemId: string;
  command: string;
  resultChars: number;
  noul: number;
  decision: "keep" | "drop";
}

export interface JevCompactScore {
  considered: number;
  scored: number;
  keep: number;
  drop: number;
  droppedChars: number;
  decisions: CompactToolDecision[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function commandLabel(command: unknown): string {
  if (typeof command === "string" && command.trim().length > 0) return command.trim();
  if (Array.isArray(command)) {
    return command
      .filter((part): part is string => typeof part === "string")
      .join(" ")
      .trim();
  }
  return "";
}

export function snapshotFromCommandExecutionItem(item: unknown): CompactToolSnapshot | null {
  if (!isRecord(item)) return null;
  const itemId = typeof item.id === "string" ? item.id : "";
  const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
  if (!itemId || output.length <= DEFAULT_TRUNCATE_HEAD_CHARS) return null;
  const status = typeof item.status === "string" ? item.status : "";
  const exitCode = item.exitCode;
  const isError = status === "failed" || (typeof exitCode === "number" && exitCode !== 0);
  if (isError) return null;
  const command = commandLabel(item.command) || "shell";
  return {
    itemId,
    command,
    resultChars: output.length,
    resultHead: output.slice(0, 800),
    isError,
  };
}

export function collectCompactToolSnapshots(
  turns: Array<{ items?: unknown[] }>,
): CompactToolSnapshot[] {
  const snapshots: CompactToolSnapshot[] = [];
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      const snapshot = snapshotFromCommandExecutionItem(item);
      if (snapshot) snapshots.push(snapshot);
    }
  }
  return snapshots;
}

export function selectSnapshotsToScore(snapshots: CompactToolSnapshot[]): CompactToolSnapshot[] {
  return [...snapshots]
    .sort((left, right) => right.resultChars - left.resultChars)
    .slice(0, COMPACT_MAX_SCORED_TOOLS);
}

export async function scoreCompactToolHistory(
  client: JevClient,
  snapshots: CompactToolSnapshot[],
  logger?: Logger,
): Promise<JevCompactScore> {
  const scoredSnapshots = selectSnapshotsToScore(snapshots);
  if (scoredSnapshots.length === 0) {
    return {
      considered: snapshots.length,
      scored: 0,
      keep: 0,
      drop: 0,
      droppedChars: 0,
      decisions: [],
    };
  }

  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  for (const snapshot of scoredSnapshots) {
    questions[snapshot.itemId] = {
      type: "noul",
      instructions: COMPACT_DROP_INSTRUCTIONS,
    };
  }

  try {
    const answers = await client.ask({
      state: {
        phase: "compact",
        tools: scoredSnapshots.map((snapshot) => ({
          id: snapshot.itemId,
          command: snapshot.command.slice(0, 200),
          resultChars: snapshot.resultChars,
          resultHead: snapshot.resultHead,
        })),
      },
      questions,
    });
    const decisions: CompactToolDecision[] = [];
    let keep = 0;
    let drop = 0;
    let droppedChars = 0;
    for (const snapshot of scoredSnapshots) {
      const noul = noulAnswer(answers, snapshot.itemId);
      const decision = noul >= COMPACT_KEEP_THRESHOLD ? "keep" : "drop";
      if (decision === "keep") keep += 1;
      else {
        drop += 1;
        droppedChars += snapshot.resultChars;
      }
      decisions.push({
        itemId: snapshot.itemId,
        command: snapshot.command.slice(0, 120),
        resultChars: snapshot.resultChars,
        noul,
        decision,
      });
    }
    logger?.info(
      {
        considered: snapshots.length,
        scored: scoredSnapshots.length,
        keep,
        drop,
        droppedChars,
        decisions: decisions.map((decision) => ({
          itemId: decision.itemId,
          noul: decision.noul,
          decision: decision.decision,
          resultChars: decision.resultChars,
        })),
      },
      "Jev compact scored",
    );
    return {
      considered: snapshots.length,
      scored: scoredSnapshots.length,
      keep,
      drop,
      droppedChars,
      decisions,
    };
  } catch (error) {
    if (error instanceof JevRequestError) {
      logger?.warn({ err: error, considered: snapshots.length }, "Jev compact score failed open");
      return {
        considered: snapshots.length,
        scored: 0,
        keep: 0,
        drop: 0,
        droppedChars: 0,
        decisions: [],
      };
    }
    throw error;
  }
}

export function formatJevCompactStatus(
  score: {
    scored: number;
    keep: number;
    drop: number;
    droppedChars: number;
  },
  options?: { applied?: boolean },
): string {
  if (score.scored === 0) {
    return "Jev compact: no large shell results to score.";
  }
  const summary = `Jev compact: drop ${score.drop}/${score.scored} shell results (${score.droppedChars} chars), keep ${score.keep}.`;
  if (options?.applied) {
    return `${summary} Codex history rewritten.`;
  }
  return summary;
}

export interface CodexRolloutRewriteResult {
  text: string;
  applied: number;
  droppedChars: number;
}

export function findCodexRolloutFile(codexHome: string, sessionId: string): string | null {
  const sessionsDir = path.join(codexHome, "sessions");
  const suffix = `-${sessionId}.jsonl`;
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir, { recursive: true, encoding: "utf8" });
  } catch {
    return null;
  }
  for (const relative of entries) {
    const name = path.basename(relative);
    if (name.startsWith("rollout-") && name.endsWith(suffix)) {
      return path.join(sessionsDir, relative);
    }
  }
  return null;
}

export function applyDroppedOutputsToCodexRollout(
  jsonl: string,
  decisions: CompactToolDecision[],
): CodexRolloutRewriteResult {
  const drops = decisions.filter((decision) => decision.decision === "drop");
  if (drops.length === 0) {
    return { text: jsonl, applied: 0, droppedChars: 0 };
  }
  const unused = [...drops];
  const calls = new Map<string, string>();
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
    if (!isRecord(record) || !isRecord(record.payload)) return line;
    const payload = record.payload;
    const payloadType = typeof payload.type === "string" ? payload.type : "";
    if (payloadType === "custom_tool_call" || payloadType === "function_call") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      if (callId) {
        calls.set(callId, toolCallInputText(payload));
      }
      return line;
    }
    if (payloadType !== "custom_tool_call_output" && payloadType !== "function_call_output") {
      return line;
    }
    const callId = typeof payload.call_id === "string" ? payload.call_id : "";
    const inputText = callId ? (calls.get(callId) ?? "") : "";
    const dropIndex = unused.findIndex((decision) =>
      toolInputMatchesCommand(inputText, decision.command),
    );
    if (dropIndex < 0) return line;
    const [decision] = unused.splice(dropIndex, 1);
    if (!decision) return line;
    const nextPayload = { ...payload, output: truncateToolOutputValue(payload.output) };
    applied += 1;
    droppedChars += decision.resultChars;
    return JSON.stringify({ ...record, payload: nextPayload });
  });
  return { text: rewritten.join("\n"), applied, droppedChars };
}

export function rewriteCodexRolloutFile(
  filePath: string,
  decisions: CompactToolDecision[],
): CodexRolloutRewriteResult {
  const original = readFileSync(filePath, "utf8");
  const result = applyDroppedOutputsToCodexRollout(original, decisions);
  if (result.applied === 0) return result;
  const tempPath = `${filePath}.jev-tmp`;
  writeFileSync(tempPath, result.text);
  renameSync(tempPath, filePath);
  return result;
}

function toolCallInputText(payload: Record<string, unknown>): string {
  const parts = [payload.input, payload.arguments, payload.name, payload.command];
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (part == null) return "";
      return JSON.stringify(part);
    })
    .filter((part) => part.length > 0)
    .join(" ");
}

function unwrapQuoted(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function commandMatchNeedles(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) return [];
  const needles = [trimmed];
  const wrapped = trimmed.match(/^(?:\/bin\/)?(?:ba)?sh\s+-[lc]+\s+(.+)$/);
  if (wrapped) {
    needles.push(unwrapQuoted(wrapped[1]));
  }
  return needles.filter((needle) => needle.length > 0);
}

function toolInputMatchesCommand(inputText: string, command: string): boolean {
  return commandMatchNeedles(command).some((needle) => inputText.includes(needle));
}

function truncateToolOutputValue(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(truncateToolOutputValue(JSON.parse(value)));
      } catch {
        return truncateToolResultText(value, DEFAULT_TRUNCATE_HEAD_CHARS);
      }
    }
    return truncateToolResultText(value, DEFAULT_TRUNCATE_HEAD_CHARS);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => truncateToolOutputValue(entry));
  }
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = { ...value };
  if (typeof next.output === "string") {
    next.output = truncateToolResultText(next.output, DEFAULT_TRUNCATE_HEAD_CHARS);
  } else if ("output" in next) {
    next.output = truncateToolOutputValue(next.output);
  }
  if (typeof next.text === "string") {
    next.text = truncateToolOutputValue(next.text);
  }
  return next;
}
