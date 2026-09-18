import { JevClient, JevRequestError } from "./client.js";
import { admitToolResultText, type AdmitTextDecision } from "./admit-text-result.js";

export const CODEX_JEV_HOOK_EVENT = "PostToolUse";
const CODEX_KEEP_THRESHOLD = 0.7;

export interface CodexPostToolHookEnv {
  PASEO_AGENT_ID?: string;
  PASEO_JEV_TOOL_ADMISSION?: string;
  PASEO_JEV_BASE_URL?: string;
  TYPESAFE_API_KEY?: string;
  TYPESAFE_API_KEY_FILE?: string;
}

export interface HandleCodexJevPostToolHookInput {
  event: string;
  stdin: string;
  env?: CodexPostToolHookEnv;
  client?: JevClient | null;
  fetch?: typeof fetch;
}

export interface CodexJevHookOutcome {
  stdout: string | null;
  decision: AdmitTextDecision | "skip_env" | "skip_event" | "skip_empty";
  toolName?: string;
  resultChars?: number;
  noul?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TEXT_FIELDS = [
  "output",
  "stdout",
  "stderr",
  "aggregated_output",
  "text",
  "content",
  "result",
  "data",
] as const;

export function toolResponseText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map(toolResponseText)
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (isRecord(value)) {
    const parts: string[] = [];
    if (typeof value.stdout === "string") parts.push(value.stdout);
    if (typeof value.stderr === "string") parts.push(value.stderr);
    if (parts.length > 0) return parts.join("\n");
    for (const field of TEXT_FIELDS) {
      const candidate = value[field];
      if (typeof candidate === "string" && candidate.length > 0) return candidate;
      if (Array.isArray(candidate)) {
        const nested = toolResponseText(candidate);
        if (nested.length > 0) return nested;
      }
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

function parseHookEvent(stdin: string): { toolName: string; input: unknown; text: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const toolName =
    typeof parsed.tool_name === "string" && parsed.tool_name.length > 0
      ? parsed.tool_name
      : "unknown";
  return {
    toolName,
    input: parsed.tool_input,
    text: toolResponseText(parsed.tool_response),
  };
}

export async function handleCodexJevPostToolHook(
  input: HandleCodexJevPostToolHookInput,
): Promise<CodexJevHookOutcome> {
  if (input.event !== CODEX_JEV_HOOK_EVENT) {
    return { stdout: null, decision: "skip_event" };
  }
  const env = input.env ?? {};
  if (!env.PASEO_AGENT_ID?.trim() || env.PASEO_JEV_TOOL_ADMISSION !== "1") {
    return { stdout: null, decision: "skip_env" };
  }
  const parsed = parseHookEvent(input.stdin);
  if (!parsed || parsed.text.length === 0) {
    return { stdout: null, decision: "skip_empty", toolName: parsed?.toolName, resultChars: 0 };
  }

  let client = input.client;
  if (client === undefined) {
    try {
      client = new JevClient({
        baseUrl: env.PASEO_JEV_BASE_URL,
        apiKey: env.TYPESAFE_API_KEY,
        apiKeyFile: env.TYPESAFE_API_KEY_FILE,
        fetch: input.fetch,
      });
    } catch (error) {
      if (error instanceof JevRequestError) {
        return {
          stdout: null,
          decision: "fail_open",
          toolName: parsed.toolName,
          resultChars: parsed.text.length,
        };
      }
      throw error;
    }
  }
  if (!client) {
    return {
      stdout: null,
      decision: "fail_open",
      toolName: parsed.toolName,
      resultChars: parsed.text.length,
    };
  }

  const admitted = await admitToolResultText(client, {
    toolName: parsed.toolName,
    input: parsed.input,
    text: parsed.text,
    keepThreshold: CODEX_KEEP_THRESHOLD,
    instructions:
      "Long coding-agent tool output. Prefer truncating dumps that can be reproduced by re-running the same command. Keep the full verbatim bytes only if the next step clearly needs them.",
  });
  if (admitted.decision !== "truncate") {
    return {
      stdout: null,
      decision: admitted.decision,
      toolName: parsed.toolName,
      resultChars: parsed.text.length,
      noul: admitted.noul,
    };
  }
  return {
    stdout: JSON.stringify({
      decision: "block",
      reason: admitted.text,
      hookSpecificOutput: {
        hookEventName: CODEX_JEV_HOOK_EVENT,
        additionalContext: `Jev truncated a ${parsed.text.length}-char ${parsed.toolName} result.`,
      },
    }),
    decision: "truncate",
    toolName: parsed.toolName,
    resultChars: parsed.text.length,
    noul: admitted.noul,
  };
}
