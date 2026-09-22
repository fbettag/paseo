import type { ProviderUsage } from "@getpaseo/protocol/messages";

const SIDE_WINDOW_IDS = new Set(["code_review"]);
const INACTIVE_VALUE = /^(expired|inactive|suspended|invalid|canceled|cancelled|disabled)$/i;
const USAGE_ALIASES: Readonly<Record<string, string>> = { glm: "zai" };

export function usageBlocksProvider(usage: ProviderUsage): boolean {
  if (usage.status !== "available") return false;
  const windows = usage.windows.filter((window) => !SIDE_WINDOW_IDS.has(window.id));
  for (const window of windows) {
    if (typeof window.remainingPct === "number" && window.remainingPct <= 0) return true;
    if (typeof window.usedPct === "number" && window.usedPct >= 100) return true;
  }
  const hasOpenWindow = windows.some(
    (window) => typeof window.remainingPct === "number" && window.remainingPct > 0,
  );
  if (!hasOpenWindow) {
    for (const balance of usage.balances ?? []) {
      if (typeof balance.remaining === "number" && balance.remaining <= 0) return true;
    }
  }
  for (const detail of usage.details ?? []) {
    if (detail.id !== "status" && detail.id !== "valid") continue;
    const value = detail.value.trim();
    if (INACTIVE_VALUE.test(value)) return true;
    if (detail.id === "valid" && /^(false|0|no)$/i.test(value)) return true;
  }
  return false;
}

export function blockedProviderIds(usages: readonly ProviderUsage[]): Set<string> {
  const blocked = new Set<string>();
  for (const usage of usages) {
    if (!usageBlocksProvider(usage)) continue;
    blocked.add(usage.providerId);
    for (const [alias, target] of Object.entries(USAGE_ALIASES)) {
      if (target === usage.providerId) blocked.add(alias);
    }
  }
  return blocked;
}
