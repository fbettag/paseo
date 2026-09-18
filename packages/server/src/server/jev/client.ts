import { readFileSync } from "node:fs";

import { DEFAULT_JEV_API_KEY_FILE, DEFAULT_JEV_BASE_URL } from "./defaults.js";

export const JEV_DEFAULT_MODEL = "jev-latest";

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion;
export type JevQuestions = Record<string, JevQuestion>;
export type JevState = string | Record<string, unknown> | unknown[];

export interface JevNoulAnswer {
  noul: number;
}

export interface JevChoiceAnswer {
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer;
export type JevAnswers = Record<string, JevAnswer>;

export interface JevAskParams {
  state: JevState;
  questions: JevQuestions;
  model?: string;
}

export interface JevClientOptions {
  baseUrl?: string;
  apiKey?: string;
  apiKeyFile?: string;
  fetch?: typeof fetch;
}

export class JevRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevRequestError";
  }
}

export function resolveJevApiKey(options: {
  apiKey?: string;
  apiKeyFile?: string;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const env = options.env ?? process.env;
  const direct = options.apiKey?.trim() || env.TYPESAFE_API_KEY?.trim();
  if (direct) return direct;
  const filePath =
    options.apiKeyFile?.trim() || env.TYPESAFE_API_KEY_FILE?.trim() || DEFAULT_JEV_API_KEY_FILE;
  try {
    const value = readFileSync(filePath, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function noulAnswer(answers: JevAnswers, name: string): number {
  const answer = answers[name];
  const noul = answer && "noul" in answer ? answer.noul : undefined;
  if (typeof noul !== "number" || !Number.isFinite(noul)) {
    throw new JevRequestError(`Invalid Jev noul answer for ${name}`);
  }
  return noul;
}

export class JevClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    const apiKey = resolveJevApiKey(options);
    if (!apiKey) {
      throw new JevRequestError("TypeSafe API key is not configured");
    }
    this.apiKey = apiKey;
    this.url = options.baseUrl?.trim() || DEFAULT_JEV_BASE_URL;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async ask(params: JevAskParams): Promise<JevAnswers> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: params.model ?? JEV_DEFAULT_MODEL,
        state: params.state,
        questions: params.questions,
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new JevRequestError(`Jev request failed (${response.status}): ${text.slice(0, 200)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new JevRequestError("Jev returned malformed JSON");
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("answers" in parsed) ||
      parsed.answers === null ||
      typeof parsed.answers !== "object"
    ) {
      throw new JevRequestError("Jev response is missing answers");
    }
    return parsed.answers as JevAnswers;
  }
}
