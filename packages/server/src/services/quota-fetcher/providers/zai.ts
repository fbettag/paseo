import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageDetail } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import { readPaseoKey } from "../paseo-key.js";
import {
  ApiOptionalStringSchema,
  exhaustedUsage,
  fetchProviderApi,
  unavailableUsage,
} from "../usage.js";

const ZaiUsageResponseSchema = z.object({
  data: z
    .array(
      z.object({
        productName: ApiOptionalStringSchema,
        status: ApiOptionalStringSchema,
        purchaseTime: ApiOptionalStringSchema,
        valid: ApiOptionalStringSchema,
      }),
    )
    .optional(),
});

interface ZaiQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  paseoHome?: string;
}

export class ZaiQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "zai";
  readonly displayName = "Z.ai";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly paseoHome?: string;

  constructor(options: ZaiQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.paseoHome = options.paseoHome;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token = await this.readToken();
    if (!token) return unavailableUsage(this);

    const res = await fetchProviderApi(
      this.fetchApi,
      "https://api.z.ai/api/biz/subscription/list",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
    );

    if (res.status === 401 || res.status === 403) {
      return exhaustedUsage(this, "Subscription");
    }
    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Z.ai usage fetch failed");
      return unavailableUsage(this);
    }

    const resp = ZaiUsageResponseSchema.parse(await res.json());
    const sub = resp.data?.find((item) => item.status?.toUpperCase() === "VALID");
    if (!sub) return exhaustedUsage(this, "Subscription");

    const details: ProviderUsageDetail[] = [];
    if (sub.status) details.push({ id: "status", label: "Status", value: sub.status });
    if (sub.valid) details.push({ id: "valid", label: "Valid", value: sub.valid });
    if (sub.purchaseTime) {
      details.push({ id: "purchase_time", label: "Purchased", value: sub.purchaseTime });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: sub.productName || null,
      windows: [],
      balances: [],
      details,
      error: null,
    };
  }

  private async readToken(): Promise<string | null> {
    const fromEnv = process.env["ZAI_API_KEY"]?.trim() || process.env["GLM_API_KEY"]?.trim();
    if (fromEnv) return fromEnv;
    return (
      (await readPaseoKey("glm", this.paseoHome)) ?? (await readPaseoKey("zai", this.paseoHome))
    );
  }
}
