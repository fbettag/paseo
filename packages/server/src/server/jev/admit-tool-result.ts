import type { Logger } from "pino";

import type { PaseoToolResult } from "../agent/tools/types.js";
import { admitToolResultText, DEFAULT_TRUNCATE_HEAD_CHARS } from "./admit-text-result.js";
import type { JevClient } from "./client.js";

export interface AdmitToolResultInput {
  toolName: string;
  input: unknown;
  result: PaseoToolResult;
  keepThreshold?: number;
  truncateHeadChars?: number;
  logger?: Logger;
}

function resultText(result: PaseoToolResult): string {
  return result.content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

export async function admitPaseoToolResult(
  client: JevClient,
  input: AdmitToolResultInput,
): Promise<PaseoToolResult> {
  const admitted = await admitToolResultText(client, {
    toolName: input.toolName,
    input: input.input,
    text: resultText(input.result),
    isError: input.result.isError,
    keepThreshold: input.keepThreshold,
    truncateHeadChars: input.truncateHeadChars ?? DEFAULT_TRUNCATE_HEAD_CHARS,
    logger: input.logger,
  });
  if (admitted.decision !== "truncate") {
    return input.result;
  }
  return {
    ...input.result,
    content: [{ type: "text", text: admitted.text }],
  };
}
