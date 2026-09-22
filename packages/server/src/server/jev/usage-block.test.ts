import { describe, expect, it } from "vitest";

import type { ProviderUsage } from "@getpaseo/protocol/messages";
import { blockedProviderIds, usageBlocksProvider } from "./usage-block.js";

function usage(
  overrides: Partial<ProviderUsage> & Pick<ProviderUsage, "providerId">,
): ProviderUsage {
  return {
    displayName: overrides.providerId,
    status: "available",
    planLabel: null,
    windows: [],
    balances: [],
    details: [],
    error: null,
    ...overrides,
  };
}

describe("usageBlocksProvider", () => {
  it("blocks an account whose usage window is spent", () => {
    expect(
      usageBlocksProvider(
        usage({
          providerId: "codex",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 100, remainingPct: 0 }],
        }),
      ),
    ).toBe(true);
  });

  it("ignores a failed usage lookup", () => {
    expect(
      usageBlocksProvider(
        usage({
          providerId: "qwen",
          status: "unavailable",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 100, remainingPct: 0 }],
        }),
      ),
    ).toBe(false);
    expect(
      usageBlocksProvider(usage({ providerId: "claude", status: "error", error: "down" })),
    ).toBe(false);
  });

  it("does not block on a side quota while the main window is open", () => {
    expect(
      usageBlocksProvider(
        usage({
          providerId: "codex",
          windows: [
            { id: "session", label: "Session", usedPct: 10, remainingPct: 90 },
            { id: "code_review", label: "Code review", usedPct: 100, remainingPct: 0 },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("blocks an inactive subscription reported by the provider", () => {
    expect(
      usageBlocksProvider(
        usage({
          providerId: "zai",
          details: [{ id: "status", label: "Status", value: "expired" }],
        }),
      ),
    ).toBe(true);
  });
});

describe("blockedProviderIds", () => {
  it("applies a Z.ai block to the glm provider", () => {
    const blocked = blockedProviderIds([
      usage({
        providerId: "zai",
        windows: [{ id: "monthly", label: "Monthly", usedPct: 100, remainingPct: 0 }],
      }),
    ]);
    expect(blocked.has("zai")).toBe(true);
    expect(blocked.has("glm")).toBe(true);
    expect(blocked.has("qwen")).toBe(false);
  });
});
