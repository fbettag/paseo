import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { handleCodexJevPostToolHook } from "@getpaseo/server/jev-hooks";

interface JevHookInput {
  [Symbol.asyncIterator](): AsyncIterator<string | Buffer>;
  isTTY?: boolean;
}

export interface JevHooksRuntime {
  env: NodeJS.ProcessEnv;
  input: JevHookInput;
  fetch: typeof fetch;
  stdout?: { write(chunk: string): void };
}

export async function runJevPostToolHook(event: string, runtime: JevHooksRuntime): Promise<void> {
  try {
    const stdin = await readHookStdin(runtime.input);
    if (!stdin) {
      recordJevHookDecision(runtime.env, { decision: "skip_empty", event });
      return;
    }
    const outcome = await handleCodexJevPostToolHook({
      event,
      stdin,
      env: runtime.env,
      fetch: runtime.fetch,
    });
    recordJevHookDecision(runtime.env, {
      event,
      decision: outcome.decision,
      toolName: outcome.toolName,
      resultChars: outcome.resultChars,
      noul: outcome.noul,
    });
    if (outcome.stdout) {
      (runtime.stdout ?? process.stdout).write(`${outcome.stdout}\n`);
    }
  } catch (error) {
    recordJevHookDecision(runtime.env, {
      event,
      decision: "fail_open",
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

function recordJevHookDecision(env: NodeJS.ProcessEnv, entry: Record<string, unknown>): void {
  try {
    const home = env.PASEO_HOME?.trim();
    if (!home) return;
    appendFileSync(
      path.join(home, "jev-hook.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), agentId: env.PASEO_AGENT_ID ?? null, ...entry })}\n`,
    );
  } catch {
    return;
  }
}

async function readHookStdin(input: JevHookInput): Promise<string | null> {
  if (input === process.stdin) {
    if (input.isTTY) return null;
    try {
      const raw = readFileSync(0, "utf8");
      return raw.length > 0 ? raw : null;
    } catch {
      return null;
    }
  }
  return readStdin(input, 15_000);
}

async function readStdin(input: JevHookInput, timeoutMs: number): Promise<string | null> {
  const iterator = input[Symbol.asyncIterator]();
  const chunks: string[] = [];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await withTimeout(iterator.next(), remaining);
    if (!next) {
      await iterator.return?.();
      return chunks.length > 0 ? chunks.join("") : null;
    }
    if (next.done) return chunks.join("");
    chunks.push(String(next.value));
  }
  await iterator.return?.();
  return chunks.length > 0 ? chunks.join("") : null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), Math.max(1, ms));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
