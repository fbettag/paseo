import type { Logger } from "pino";

import { JevClient, JevRequestError, noulAnswer } from "./client.js";
import { DEFAULT_TRUNCATE_HEAD_CHARS } from "./admit-text-result.js";

export const COMPACT_KEEP_THRESHOLD = 0.5;
export const COMPACT_MAX_SCORED_TOOLS = 16;

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
      instructions:
        "This conversation is being compacted. Is this past shell/tool result still needed verbatim in the next turns, or can it be dropped because the command can be re-run?",
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
      { considered: snapshots.length, scored: scoredSnapshots.length, keep, drop, droppedChars },
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

export function formatJevCompactStatus(score: {
  scored: number;
  keep: number;
  drop: number;
  droppedChars: number;
}): string {
  if (score.scored === 0) {
    return "Jev compact: no large shell results to score.";
  }
  return `Jev compact: drop ${score.drop}/${score.scored} shell results (${score.droppedChars} chars), keep ${score.keep}.`;
}
