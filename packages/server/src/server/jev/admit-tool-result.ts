import type { Logger } from "pino";

import type { PaseoToolResult } from "../agent/tools/types.js";
import { JevClient, JevRequestError, noulAnswer } from "./client.js";

const DEFAULT_KEEP_THRESHOLD = 0.5;
const DEFAULT_TRUNCATE_HEAD_CHARS = 300;

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

function truncateText(text: string, headChars: number): string {
  if (text.length <= headChars) return text;
  const omitted = text.length - headChars;
  return `${text.slice(0, headChars)}\n[… ${omitted} chars omitted by Jev …]`;
}

export async function admitPaseoToolResult(
  client: JevClient,
  input: AdmitToolResultInput,
): Promise<PaseoToolResult> {
  const text = resultText(input.result);
  const resultChars = text.length;
  const truncateHeadChars = input.truncateHeadChars ?? DEFAULT_TRUNCATE_HEAD_CHARS;
  if (resultChars <= truncateHeadChars) {
    input.logger?.debug(
      { toolName: input.toolName, resultChars, decision: "skip_short" },
      "Jev admission skipped",
    );
    return input.result;
  }
  if (input.result.isError) {
    input.logger?.debug(
      { toolName: input.toolName, resultChars, decision: "skip_error" },
      "Jev admission skipped",
    );
    return input.result;
  }

  try {
    const answers = await client.ask({
      state: {
        tool: input.toolName,
        input: input.input,
        resultChars,
        resultHead: text.slice(0, 800),
      },
      questions: {
        keepResult: {
          type: "noul",
          instructions:
            "The coding agent just received this Paseo tool result. Is the full verbatim output still needed, or would a short head plus a length note be enough because the tool can be re-run?",
        },
      },
    });
    const keep = noulAnswer(answers, "keepResult");
    if (keep >= (input.keepThreshold ?? DEFAULT_KEEP_THRESHOLD)) {
      input.logger?.info(
        { toolName: input.toolName, resultChars, noul: keep, decision: "keep" },
        "Jev admission keep",
      );
      return input.result;
    }
    input.logger?.info(
      { toolName: input.toolName, resultChars, noul: keep, decision: "truncate" },
      "Jev admission truncate",
    );
    return {
      ...input.result,
      content: [
        {
          type: "text",
          text: truncateText(text, truncateHeadChars),
        },
      ],
    };
  } catch (error) {
    if (error instanceof JevRequestError) {
      input.logger?.warn(
        { toolName: input.toolName, resultChars, decision: "fail_open", err: error },
        "Jev admission failed open",
      );
      return input.result;
    }
    throw error;
  }
}
