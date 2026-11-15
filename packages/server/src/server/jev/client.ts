import { readFile } from "node:fs/promises";
import type { Logger } from "pino";

export const JEV_DEFAULT_MODEL = "jev-latest";
export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai/v1/systemone";

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
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  logger?: Logger;
}

export class JevRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevRequestError";
  }
}

interface JevApiKeySource {
  apiKey?: string;
  apiKeyFile?: string;
}

function apiKeySource(options: JevClientOptions): JevApiKeySource {
  const env = options.env ?? process.env;
  const apiKey = options.apiKey?.trim() || env.TYPESAFE_API_KEY?.trim();
  if (apiKey) return { apiKey };
  const apiKeyFile = options.apiKeyFile?.trim() || env.TYPESAFE_API_KEY_FILE?.trim();
  return apiKeyFile ? { apiKeyFile } : {};
}

export async function resolveJevApiKey(source: JevApiKeySource): Promise<string | null> {
  if (source.apiKey) return source.apiKey;
  if (!source.apiKeyFile) return null;
  try {
    const value = (await readFile(source.apiKeyFile, "utf8")).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function isLoopbackJevUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
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

function requestHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

export class JevClient {
  private readonly url: string;
  private readonly keySource: JevApiKeySource;
  private apiKey: Promise<string | null> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: Logger;

  constructor(options: JevClientOptions = {}) {
    const env = options.env ?? process.env;
    this.url = options.baseUrl?.trim() || env.PASEO_JEV_BASE_URL?.trim() || DEFAULT_JEV_BASE_URL;
    this.keySource = apiKeySource(options);
    if (!this.keySource.apiKey && !this.keySource.apiKeyFile && !isLoopbackJevUrl(this.url)) {
      throw new JevRequestError("TypeSafe API key is not configured");
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.logger = options.logger;
  }

  private async requireApiKey(): Promise<string | null> {
    this.apiKey ??= resolveJevApiKey(this.keySource);
    const apiKey = await this.apiKey;
    if (!apiKey && !isLoopbackJevUrl(this.url)) {
      this.apiKey = null;
      throw new JevRequestError("TypeSafe API key is not readable");
    }
    return apiKey;
  }

  async ask(params: JevAskParams): Promise<JevAnswers> {
    const model = params.model ?? JEV_DEFAULT_MODEL;
    const questionIds = Object.keys(params.questions);
    const startedAt = Date.now();
    this.logger?.info({ host: requestHost(this.url), model, questionIds }, "Jev request started");
    try {
      const apiKey = await this.requireApiKey();
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          state: params.state,
          questions: params.questions,
        }),
      });
      const text = await response.text();
      const durationMs = Date.now() - startedAt;
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
      const answers = parsed.answers as JevAnswers;
      this.logger?.info(
        {
          host: requestHost(this.url),
          model,
          questionIds,
          status: response.status,
          durationMs,
          answerIds: Object.keys(answers),
        },
        "Jev request succeeded",
      );
      return answers;
    } catch (error) {
      this.logger?.warn(
        {
          host: requestHost(this.url),
          model,
          questionIds,
          durationMs: Date.now() - startedAt,
          err: error,
        },
        "Jev request failed",
      );
      throw error;
    }
  }
}

/** Returns null when neither a TypeSafe key nor a loopback endpoint is configured. */
export function createJevClientFromEnv(
  logger?: Logger,
  env: NodeJS.ProcessEnv = process.env,
): JevClient | null {
  try {
    return new JevClient({ logger, env });
  } catch (error) {
    if (error instanceof JevRequestError) return null;
    throw error;
  }
}
