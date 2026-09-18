import type { AdmitTextResult, AdmitTextResultInput } from "./admit-text-result.js";

export type CodexJevAdmit = (
  input: Pick<AdmitTextResultInput, "toolName" | "input" | "text" | "isError">,
) => Promise<AdmitTextResult>;

export const CODEX_KEEP_THRESHOLD = 0.7;
export const CODEX_ADMIT_INSTRUCTIONS =
  "Long coding-agent tool output. Prefer truncating dumps that can be reproduced by re-running the same command. Keep the full verbatim bytes only if the next step clearly needs them.";

export function combineCodexExecText(output?: string | null, stderr?: string | null): string {
  return [output, stderr]
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join("\n");
}

export function commandExecutionOutput(item: { [key: string]: unknown }): string {
  return typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
}

export function commandExecutionIsError(item: { [key: string]: unknown }): boolean {
  const status = typeof item.status === "string" ? item.status : "";
  const exitCode = item.exitCode;
  return status === "failed" || (typeof exitCode === "number" && exitCode !== 0);
}

export async function admitCommandExecutionItem(
  admit: CodexJevAdmit | undefined,
  item: { [key: string]: unknown },
): Promise<void> {
  if (!admit) return;
  const output = commandExecutionOutput(item);
  const admitted = await admitCodexExecOutput(admit, {
    command: item.command,
    output,
    isError: commandExecutionIsError(item),
  });
  if (admitted.output !== undefined && admitted.output !== output) {
    item.aggregatedOutput = admitted.output;
  }
}

export async function admitCodexExecOutput(
  admit: CodexJevAdmit | undefined,
  params: {
    command: unknown;
    output?: string | null;
    stderr?: string | null;
    isError: boolean;
  },
): Promise<{ output: string | null | undefined }> {
  if (!admit) {
    return { output: params.output };
  }
  const text = combineCodexExecText(params.output, params.stderr);
  if (text.length === 0) {
    return { output: params.output };
  }
  const admitted = await admit({
    toolName: "shell",
    input: { command: params.command },
    text,
    isError: params.isError,
  });
  if (admitted.decision !== "truncate") {
    return { output: params.output };
  }
  return { output: admitted.text };
}
