import { handleCodexJevPostToolHook } from "@getpaseo/server/jev-hooks";

interface JevHookInput {
  [Symbol.asyncIterator](): AsyncIterator<string | Buffer>;
}

export interface JevHooksRuntime {
  env: NodeJS.ProcessEnv;
  input: JevHookInput;
  fetch: typeof fetch;
  stdout?: { write(chunk: string): void };
}

export async function runJevPostToolHook(event: string, runtime: JevHooksRuntime): Promise<void> {
  try {
    const stdin = await readStdin(runtime.input, 15_000);
    if (!stdin) return;
    const output = await handleCodexJevPostToolHook({
      event,
      stdin,
      env: runtime.env,
      fetch: runtime.fetch,
    });
    if (output) {
      (runtime.stdout ?? process.stdout).write(`${output}\n`);
    }
  } catch {
    return;
  }
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
