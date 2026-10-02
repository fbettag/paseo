import type { UsageInput } from "../shared/input.js";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailableUsage,
  windowFromUsedPct,
  type UsageBalance,
  type UsageDetail,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const ORCA_API_BASE = "https://api.orcarouter.ai";
const BILLING_USAGE_URL = `${ORCA_API_BASE}/v1/dashboard/billing/usage`;
const BILLING_SUB_URL = `${ORCA_API_BASE}/v1/dashboard/billing/subscription`;
const FREE_PACKAGE_URL = `${ORCA_API_BASE}/api/free-package/public`;
const CHAT_COMPLETIONS_URL = `${ORCA_API_BASE}/v1/chat/completions`;
const FREE_ROUTER = "orcarouter/free";

interface FreeProbeResult {
  status: FreeStatus;
  retryAfterSeconds: number | null;
}

interface CachedFreeProbe extends FreeProbeResult {
  expiresAt: number;
}

let freeProbeCache: CachedFreeProbe | null = null;

export function resetOrcaFreeProbeCache(): void {
  freeProbeCache = null;
}

const ApiNumberSchema = z.coerce.number().finite();
const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

const BillingUsageSchema = z
  .object({
    total_usage: ApiNumberSchema.optional(),
    totalUsage: ApiNumberSchema.optional(),
  })
  .passthrough();

const BillingSubscriptionSchema = z
  .object({
    has_payment_method: z.boolean().optional(),
    soft_limit_usd: ApiNumberSchema.optional(),
    hard_limit_usd: ApiNumberSchema.optional(),
    access_until: ApiNumberSchema.optional(),
  })
  .passthrough();

const FreeTierRowSchema = z
  .object({
    min_paid_usd: ApiNumberSchema.optional(),
    rpm: ApiNumberSchema.optional(),
    rpd: ApiNumberSchema.optional(),
  })
  .passthrough();

const FreePackageSchema = z
  .object({
    data: z
      .object({
        free_tier: z
          .object({
            tiers: z.array(FreeTierRowSchema).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const OrcaErrorSchema = z
  .object({
    error: z
      .object({
        code: ApiOptionalStringSchema,
        type: ApiOptionalStringSchema,
        message: ApiOptionalStringSchema,
        metadata: z
          .object({
            reason: ApiOptionalStringSchema,
            retry_after_seconds: ApiNumberSchema.optional(),
            buy_credits_url: ApiOptionalStringSchema,
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type FreeStatus = "available" | "exhausted" | "rate_limited" | "unknown";

export function orcaKeyPaths(homeDir = homedir()): string[] {
  const paseoHome = process.env["PASEO_HOME"] || join(homeDir, ".paseo");
  return [join(paseoHome, "keys", "orca")];
}

export async function readOrcaKey(homeDir = homedir()): Promise<string | null> {
  const fromEnv = process.env["ORCAROUTER_API_KEY"];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  for (const path of orcaKeyPaths(homeDir)) {
    if (!existsSync(path)) continue;
    try {
      const value = (await fs.readFile(path, "utf8")).trim();
      if (value.length > 0) return value;
    } catch {
      continue;
    }
  }
  return null;
}

export function nextUtcMidnight(now = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  ).toISOString();
}

export function pickFreeTier(
  spendUsd: number | null,
  tiers: Array<{ min_paid_usd?: number; rpm?: number; rpd?: number }>,
): { rpm: number | null; rpd: number | null; minPaidUsd: number } | null {
  if (tiers.length === 0) return null;
  const ranked = [...tiers].sort(
    (left, right) => (left.min_paid_usd ?? 0) - (right.min_paid_usd ?? 0),
  );
  let chosen = ranked[0]!;
  if (typeof spendUsd === "number") {
    for (const tier of ranked) {
      if (spendUsd + 1e-9 >= (tier.min_paid_usd ?? 0)) chosen = tier;
    }
  }
  return {
    rpm: typeof chosen.rpm === "number" ? chosen.rpm : null,
    rpd: typeof chosen.rpd === "number" ? chosen.rpd : null,
    minPaidUsd: chosen.min_paid_usd ?? 0,
  };
}

export function classifyFreeHttp(
  status: number,
  body: unknown,
): {
  status: FreeStatus;
  retryAfterSeconds: number | null;
} {
  const parsed = OrcaErrorSchema.safeParse(body);
  const error = parsed.success ? parsed.data.error : undefined;
  const code = (error?.code ?? "").toLowerCase();
  const reason = (error?.metadata?.reason ?? "").toLowerCase();
  const retryAfter =
    typeof error?.metadata?.retry_after_seconds === "number"
      ? error.metadata.retry_after_seconds
      : null;
  if (
    code === "free_quota_exhausted" ||
    reason === "err_free_used" ||
    (status === 402 && code.includes("free"))
  ) {
    return { status: "exhausted", retryAfterSeconds: null };
  }
  if (
    code === "free_rate_limited" ||
    reason === "err_free_rate" ||
    reason === "err_free_access_denied"
  ) {
    return { status: "rate_limited", retryAfterSeconds: retryAfter };
  }
  if (status >= 200 && status < 300) return { status: "available", retryAfterSeconds: null };
  return { status: "unknown", retryAfterSeconds: null };
}

async function readJson(
  fetchApi: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetchApi(url, {
    signal: AbortSignal.timeout(15_000),
    headers,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function probeCacheExpiry(result: FreeProbeResult, now = Date.now()): number | null {
  if (result.status === "unknown") return null;
  if (result.status === "rate_limited" && result.retryAfterSeconds != null) {
    return now + Math.max(1, result.retryAfterSeconds) * 1000;
  }
  return new Date(nextUtcMidnight(new Date(now))).getTime();
}

async function probeFreeRouterCached(
  fetchApi: typeof fetch,
  token: string,
  now = Date.now(),
): Promise<FreeProbeResult> {
  if (freeProbeCache && now < freeProbeCache.expiresAt) {
    return {
      status: freeProbeCache.status,
      retryAfterSeconds: freeProbeCache.retryAfterSeconds,
    };
  }
  const result = await probeFreeRouter(fetchApi, token);
  const expiresAt = probeCacheExpiry(result, now);
  if (expiresAt != null) {
    freeProbeCache = { ...result, expiresAt };
  }
  return result;
}

async function probeFreeRouter(fetchApi: typeof fetch, token: string): Promise<FreeProbeResult> {
  const response = await fetchApi(CHAT_COMPLETIONS_URL, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: FREE_ROUTER,
      messages: [{ role: "user", content: "." }],
      max_tokens: 1,
      stream: false,
    }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return classifyFreeHttp(response.status, body);
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
  homeDir = homedir(),
): Promise<UsageReport> {
  void input;
  const token = await readOrcaKey(homeDir);
  if (!token) return unavailableUsage();

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  const [usageRes, subRes, freeRes, probe] = await Promise.all([
    readJson(fetchApi, BILLING_USAGE_URL, authHeaders).catch(() => ({ status: 0, body: null })),
    readJson(fetchApi, BILLING_SUB_URL, authHeaders).catch(() => ({ status: 0, body: null })),
    readJson(fetchApi, FREE_PACKAGE_URL, { Accept: "application/json" }).catch(() => ({
      status: 0,
      body: null,
    })),
    probeFreeRouterCached(fetchApi, token).catch(() => ({
      status: "unknown" as const,
      retryAfterSeconds: null,
    })),
  ]);

  if (isAuthFailure(usageRes.status) || isAuthFailure(subRes.status)) return unavailableUsage();
  return buildOrcaUsageReport({
    usageBody: usageRes.body,
    subscriptionBody: subRes.body,
    freePackageBody: freeRes.body,
    probe,
  });
}

function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

function buildOrcaUsageReport(input: {
  usageBody: unknown;
  subscriptionBody: unknown;
  freePackageBody: unknown;
  probe: { status: FreeStatus; retryAfterSeconds: number | null };
}): UsageReport {
  const usage = BillingUsageSchema.safeParse(input.usageBody);
  const subscription = BillingSubscriptionSchema.safeParse(input.subscriptionBody);
  const freePackage = FreePackageSchema.safeParse(input.freePackageBody);
  const spendUsd = usage.success ? (usage.data.total_usage ?? usage.data.totalUsage ?? null) : null;
  const tiers = freePackage.success ? (freePackage.data.data?.free_tier?.tiers ?? []) : [];
  const hasPayment = subscription.success ? subscription.data.has_payment_method === true : false;
  const windows: UsageWindow[] = [];
  const freeWindow = freeAllowanceWindow(input.probe.status, input.probe.retryAfterSeconds);
  if (freeWindow) windows.push(freeWindow);
  return {
    status: "available",
    planLabel: planLabelFor(input.probe.status, hasPayment),
    windows,
    balances: spendBalances(spendUsd),
    details: freeDetails(pickFreeTier(spendUsd, tiers), input.probe.status),
  };
}

function spendBalances(spendUsd: number | null): UsageBalance[] {
  if (typeof spendUsd !== "number") return [];
  return [
    {
      id: "lifetime_spend",
      label: "Lifetime spend",
      used: spendUsd,
      remaining: null,
      limit: null,
      unit: "usd",
      tone: "default",
    },
  ];
}

function freeDetails(
  tier: { rpm: number | null; rpd: number | null } | null,
  status: FreeStatus,
): UsageDetail[] {
  const details: UsageDetail[] = [];
  if (tier?.rpd != null) {
    details.push({ id: "free_rpd", label: "Free daily", value: `${tier.rpd} req` });
  }
  if (tier?.rpm != null) {
    details.push({ id: "free_rpm", label: "Free per minute", value: `${tier.rpm} req` });
  }
  if (status === "exhausted") {
    details.push({ id: "status", label: "Free models", value: "used up", tone: "danger" });
  }
  if (status === "rate_limited") {
    details.push({ id: "status", label: "Free models", value: "rate limited", tone: "warning" });
  }
  return details;
}

export async function identify(_input?: UsageInput, homeDir = homedir()) {
  const key = await readOrcaKey(homeDir);
  return key ? { key: hashAccountKey(key) } : null;
}

function planLabelFor(status: FreeStatus, hasPayment: boolean): string {
  if (status === "exhausted") return "Free used up";
  if (status === "rate_limited") return "Free rate-limited";
  if (status === "available") return "Free";
  if (hasPayment) return "Paid";
  return "Orca";
}

function freeAllowanceWindow(
  status: FreeStatus,
  retryAfterSeconds: number | null,
): UsageWindow | null {
  if (status === "unknown") return null;
  if (status === "available") {
    return windowFromUsedPct({
      id: "free",
      label: "Free allowance",
      utilizationPct: 0,
      tone: toneFromUsedPct(0),
    });
  }
  const resetsAt =
    status === "rate_limited" && retryAfterSeconds != null && retryAfterSeconds > 0
      ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
      : nextUtcMidnight();
  return windowFromUsedPct({
    id: "free",
    label: status === "rate_limited" ? "Free rate limit" : "Free allowance",
    utilizationPct: 100,
    resetsAt,
    tone: status === "rate_limited" ? "warning" : "danger",
  });
}
