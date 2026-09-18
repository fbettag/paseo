import { JevClient, JevRequestError } from "./client.js";
import { admitToolResultText } from "./admit-text-result.js";

export const CODEX_JEV_HOOK_EVENT = "PostToolUse";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    if (typeof value.output === "string") return value.output;
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return toolResponseText(value.content);
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
): Promise<string | null> {
  if (input.event !== CODEX_JEV_HOOK_EVENT) return null;
  const env = input.env ?? {};
  if (!env.PASEO_AGENT_ID?.trim() || env.PASEO_JEV_TOOL_ADMISSION !== "1") {
    return null;
  }
  const parsed = parseHookEvent(input.stdin);
  if (!parsed || parsed.text.length === 0) return null;

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
      if (error instanceof JevRequestError) return null;
      throw error;
    }
  }
  if (!client) return null;

  const admitted = await admitToolResultText(client, {
    toolName: parsed.toolName,
    input: parsed.input,
    text: parsed.text,
  });
  if (admitted.decision !== "truncate") return null;
  return JSON.stringify({
    decision: "block",
    reason: admitted.text,
    hookSpecificOutput: {
      hookEventName: CODEX_JEV_HOOK_EVENT,
      additionalContext: `Jev truncated a ${parsed.text.length}-char ${parsed.toolName} result.`,
    },
  });
}
