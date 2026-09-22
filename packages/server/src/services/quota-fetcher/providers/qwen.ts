import type { Logger } from "pino";
import type { ProviderUsage } from "../../../server/messages.js";
import { readPaseoKey } from "../paseo-key.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import { exhaustedUsage, fetchProviderApi, unavailableUsage } from "../usage.js";

const QWEN_MODELS_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models";

interface QwenQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  paseoHome?: string;
}

export class QwenQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "qwen";
  readonly displayName = "Qwen";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly paseoHome?: string;

  constructor(options: QwenQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.paseoHome = options.paseoHome;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token =
      process.env["QWEN_API_KEY"]?.trim() || (await readPaseoKey("qwen", this.paseoHome));
    if (!token) return unavailableUsage(this);

    const res = await fetchProviderApi(this.fetchApi, QWEN_MODELS_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (res.ok) {
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: "available",
        planLabel: "Token Plan",
        windows: [],
        balances: [],
        details: [],
        error: null,
      };
    }

    const body = (await res.text()).toLowerCase();
    if (res.status === 401 || res.status === 403 || quotaExhausted(res.status, body)) {
      return exhaustedUsage(this, "Token Plan");
    }
    this.logger.debug({ status: res.status }, "Qwen usage fetch failed");
    return unavailableUsage(this);
  }
}

function quotaExhausted(status: number, body: string): boolean {
  if (status !== 429) return false;
  return (
    body.includes("insufficient_quota") ||
    body.includes("quota exceeded") ||
    body.includes("allocated quota exceeded")
  );
}
