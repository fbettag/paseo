import { describe, expect, it } from "vitest";

import { classifyOrcaUsageSkip, UsageSkipError } from "./usage-error.js";

const LIVE_402 = `{"name":"APIError","data":{"message":"your orcarouter/free allowance is used up — top up your balance and call a specific model with wallet billing to keep going https://www.orcarouter.ai/console/billing?ref=err_free_used#add-credits","statusCode":402,"responseBody":"{\\"error\\":{\\"code\\":\\"free_quota_exhausted\\",\\"message\\":\\"your orcarouter/free allowance is used up\\",\\"metadata\\":{\\"reason\\":\\"err_free_used\\"},\\"type\\":\\"insufficient_quota\\"}}"}}`;

describe("classifyOrcaUsageSkip", () => {
  it("reads the live OpenCode 402 envelope as free usage", () => {
    expect(classifyOrcaUsageSkip(new Error(LIVE_402))).toBe("free");
  });

  it("reads a free rate-limit 429", () => {
    expect(
      classifyOrcaUsageSkip(
        JSON.stringify({
          error: { code: "free_rate_limited", metadata: { reason: "err_free_rate" } },
        }),
      ),
    ).toBe("free");
  });

  it("reads a wallet quota 403 as credits", () => {
    expect(
      classifyOrcaUsageSkip({
        error: { code: "insufficient_user_quota", message: "token quota is not enough" },
      }),
    ).toBe("credits");
  });

  it("returns the UsageSkipError kind", () => {
    expect(classifyOrcaUsageSkip(new UsageSkipError("free"))).toBe("free");
    expect(classifyOrcaUsageSkip(new UsageSkipError("credits"))).toBe("credits");
  });

  it("ignores unrelated failures", () => {
    expect(
      classifyOrcaUsageSkip(new Error("ProcessTransport is not ready for writing")),
    ).toBeNull();
  });
});
