import type { Logger } from "pino";

import { JevClient, JevRequestError, noulAnswer } from "./client.js";

export const DEFAULT_KEEP_THRESHOLD = 0.5;
export const DEFAULT_TRUNCATE_HEAD_CHARS = 300;

export interface AdmitTextResultInput {
  toolName: string;
  input: unknown;
  text: string;
  isError?: boolean;
  keepThreshold?: number;
  truncateHeadChars?: number;
  logger?: Logger;
}

export type AdmitTextDecision = "keep" | "truncate" | "skip_short" | "skip_error" | "fail_open";

export interface AdmitTextResult {
  decision: AdmitTextDecision;
  text: string;
  noul?: number;
}

export function truncateToolResultText(text: string, headChars: number): string {
  if (text.length <= headChars) return text;
  const omitted = text.length - headChars;
  return `${text.slice(0, headChars)}\n[… ${omitted} chars omitted by Jev …]`;
}

export async function admitToolResultText(
  client: JevClient,
  input: AdmitTextResultInput,
): Promise<AdmitTextResult> {
  const resultChars = input.text.length;
  const truncateHeadChars = input.truncateHeadChars ?? DEFAULT_TRUNCATE_HEAD_CHARS;
  if (resultChars <= truncateHeadChars) {
    input.logger?.debug(
      { toolName: input.toolName, resultChars, decision: "skip_short" },
      "Jev admission skipped",
    );
    return { decision: "skip_short", text: input.text };
  }
  if (input.isError) {
    input.logger?.debug(
      { toolName: input.toolName, resultChars, decision: "skip_error" },
      "Jev admission skipped",
    );
    return { decision: "skip_error", text: input.text };
  }

  try {
    const answers = await client.ask({
      state: {
        tool: input.toolName,
        input: input.input,
        resultChars,
        resultHead: input.text.slice(0, 800),
      },
      questions: {
        keepResult: {
          type: "noul",
          instructions:
            "The coding agent just received this tool result. Is the full verbatim output still needed, or would a short head plus a length note be enough because the tool can be re-run?",
        },
      },
    });
    const keep = noulAnswer(answers, "keepResult");
    if (keep >= (input.keepThreshold ?? DEFAULT_KEEP_THRESHOLD)) {
      input.logger?.info(
        { toolName: input.toolName, resultChars, noul: keep, decision: "keep" },
        "Jev admission keep",
      );
      return { decision: "keep", text: input.text, noul: keep };
    }
    const truncated = truncateToolResultText(input.text, truncateHeadChars);
    input.logger?.info(
      { toolName: input.toolName, resultChars, noul: keep, decision: "truncate" },
      "Jev admission truncate",
    );
    return { decision: "truncate", text: truncated, noul: keep };
  } catch (error) {
    if (error instanceof JevRequestError) {
      input.logger?.warn(
        { toolName: input.toolName, resultChars, decision: "fail_open", err: error },
        "Jev admission failed open",
      );
      return { decision: "fail_open", text: input.text };
    }
    throw error;
  }
}
