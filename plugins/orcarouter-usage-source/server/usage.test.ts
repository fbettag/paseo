import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyFreeHttp,
  fetchUsage,
  identify,
  nextUtcMidnight,
  pickFreeTier,
  resetOrcaFreeProbeCache,
} from "./usage.js";

function mockFetch(handlers: Map<string, (init?: RequestInit) => Response>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const key = url.toString();
    const handler = handlers.get(key);
    if (!handler) throw new Error(`Unmocked fetch: ${key}`);
    return handler(init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const FREE_PACKAGE = {
  data: {
    free_tier: {
      tiers: [
        { min_paid_usd: 0, rpm: 10, rpd: 50 },
        { min_paid_usd: 20, rpm: 20, rpd: 800 },
      ],
    },
  },
  success: true,
};

describe("orcarouter usage source", () => {
  let homeDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "orca-usage-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    process.env["PASEO_HOME"] = join(homeDir, ".paseo");
    delete process.env["ORCAROUTER_API_KEY"];
    resetOrcaFreeProbeCache();
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });

  function writeKey(value: string): void {
    const dir = join(homeDir, ".paseo", "keys");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "orca"), value);
  }

  function defaultHandlers(overrides: Map<string, (init?: RequestInit) => Response> = new Map()) {
    const handlers = new Map<string, (init?: RequestInit) => Response>([
      [
        "https://api.orcarouter.ai/v1/dashboard/billing/usage",
        () => jsonResponse({ object: "list", total_usage: 2099.94 }),
      ],
      [
        "https://api.orcarouter.ai/v1/dashboard/billing/subscription",
        () => jsonResponse({ object: "billing_subscription", has_payment_method: true }),
      ],
      ["https://api.orcarouter.ai/api/free-package/public", () => jsonResponse(FREE_PACKAGE)],
      [
        "https://api.orcarouter.ai/v1/chat/completions",
        () =>
          jsonResponse(
            {
              error: {
                code: "free_quota_exhausted",
                type: "insufficient_quota",
                message: "your orcarouter/free allowance is used up",
                metadata: { reason: "err_free_used" },
              },
            },
            402,
          ),
      ],
    ]);
    for (const [url, handler] of overrides) handlers.set(url, handler);
    return handlers;
  }

  it("returns unavailable without a key", async () => {
    const report = await fetchUsage({}, mockFetch(new Map()), homeDir);
    expect(report.status).toBe("unavailable");
    expect(await identify({}, homeDir)).toBeNull();
  });

  it("shows free allowance used up from a 402 probe", async () => {
    writeKey("sk-orca-test");
    const report = await fetchUsage({}, mockFetch(defaultHandlers()), homeDir);
    expect(report.status).toBe("available");
    expect(report.planLabel).toBe("Free used up");
    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "free",
        label: "Free allowance",
        usedPct: 100,
        remainingPct: 0,
        tone: "danger",
        resetsAt: nextUtcMidnight(),
      }),
    ]);
    expect(report.balances).toEqual([
      expect.objectContaining({
        id: "lifetime_spend",
        used: 2099.94,
        unit: "usd",
      }),
    ]);
    expect(report.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "free_rpd", value: "800 req" }),
        expect.objectContaining({ id: "status", value: "used up", tone: "danger" }),
      ]),
    );
  });

  it("shows a live free allowance when the probe succeeds", async () => {
    writeKey("sk-orca-test");
    const handlers = defaultHandlers(
      new Map([
        [
          "https://api.orcarouter.ai/v1/chat/completions",
          () => jsonResponse({ id: "chatcmpl-1", choices: [] }),
        ],
      ]),
    );
    const report = await fetchUsage({}, mockFetch(handlers), homeDir);
    expect(report.planLabel).toBe("Free");
    expect(report.windows[0]).toMatchObject({
      id: "free",
      usedPct: 0,
      remainingPct: 100,
      tone: "ok",
    });
  });

  it("shows a free rate-limit window with retry-after", async () => {
    writeKey("sk-orca-test");
    const handlers = defaultHandlers(
      new Map([
        [
          "https://api.orcarouter.ai/v1/chat/completions",
          () =>
            jsonResponse(
              {
                error: {
                  code: "free_rate_limited",
                  type: "rate_limit_error",
                  metadata: { reason: "err_free_rate", retry_after_seconds: 37 },
                },
              },
              429,
            ),
        ],
      ]),
    );
    const report = await fetchUsage({}, mockFetch(handlers), homeDir);
    expect(report.planLabel).toBe("Free rate-limited");
    expect(report.windows[0]?.id).toBe("free");
    expect(report.windows[0]?.usedPct).toBe(100);
    expect(report.windows[0]?.tone).toBe("warning");
    expect(report.windows[0]?.resetsAt).toEqual(expect.any(String));
  });

  it("probes orcarouter/free at most once until the UTC day rolls", async () => {
    writeKey("sk-orca-test");
    let probes = 0;
    const handlers = defaultHandlers(
      new Map([
        [
          "https://api.orcarouter.ai/v1/chat/completions",
          () => {
            probes += 1;
            return jsonResponse(
              {
                error: {
                  code: "free_quota_exhausted",
                  metadata: { reason: "err_free_used" },
                },
              },
              402,
            );
          },
        ],
      ]),
    );
    const fetchApi = mockFetch(handlers);
    await fetchUsage({}, fetchApi, homeDir);
    await fetchUsage({}, fetchApi, homeDir);
    expect(probes).toBe(1);
  });

  it("reads ORCAROUTER_API_KEY from the environment", async () => {
    process.env["ORCAROUTER_API_KEY"] = "sk-orca-env";
    let authorization: string | null = null;
    const fetchApi = mockFetch(
      defaultHandlers(
        new Map([
          [
            "https://api.orcarouter.ai/v1/dashboard/billing/usage",
            (init) => {
              authorization = new Headers(init?.headers).get("Authorization");
              return jsonResponse({ total_usage: 1 });
            },
          ],
        ]),
      ),
    );
    const report = await fetchUsage({}, fetchApi, homeDir);
    expect(authorization).toBe("Bearer sk-orca-env");
    expect(report.status).toBe("available");
    expect(await identify({}, homeDir)).toEqual({ key: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
});

describe("classifyFreeHttp", () => {
  it("maps 402 free_quota_exhausted to exhausted", () => {
    expect(
      classifyFreeHttp(402, {
        error: { code: "free_quota_exhausted", metadata: { reason: "err_free_used" } },
      }),
    ).toEqual({ status: "exhausted", retryAfterSeconds: null });
  });

  it("maps 429 err_free_rate to rate_limited", () => {
    expect(
      classifyFreeHttp(429, {
        error: {
          code: "free_rate_limited",
          metadata: { reason: "err_free_rate", retry_after_seconds: 12 },
        },
      }),
    ).toEqual({ status: "rate_limited", retryAfterSeconds: 12 });
  });
});

describe("pickFreeTier", () => {
  it("selects the highest unlocked spend tier", () => {
    expect(
      pickFreeTier(2099.94, [
        { min_paid_usd: 0, rpm: 10, rpd: 50 },
        { min_paid_usd: 20, rpm: 20, rpd: 800 },
      ]),
    ).toEqual({ rpm: 20, rpd: 800, minPaidUsd: 20 });
    expect(
      pickFreeTier(0, [
        { min_paid_usd: 0, rpm: 10, rpd: 50 },
        { min_paid_usd: 20, rpm: 20, rpd: 800 },
      ]),
    ).toEqual({ rpm: 10, rpd: 50, minPaidUsd: 0 });
  });
});
