import { describe, expect, it } from "vitest";

import {
  expandSlots,
  parseCatalogModel,
  parseModelRef,
  roundRobinByProvider,
  runCampaign,
  startDelayMs,
  type CampaignClock,
  type CampaignItem,
  type CampaignPorts,
} from "./campaign.js";

function identityShuffle<T>(items: T[]): T[] {
  return [...items];
}

function clock(now = 0): CampaignClock & { advance(ms: number): void } {
  let current = now;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    sleep: async (ms: number) => {
      await Promise.resolve();
      current += ms;
    },
  };
}

function ports(overrides: Partial<CampaignPorts> = {}): CampaignPorts {
  return {
    blockedProviders: async () => new Set(),
    runWorker: async (item) => ({ text: item.key, findingsCount: 1 }),
    orderItems: identityShuffle,
    clock: clock(),
    ...overrides,
  };
}

describe("parseModelRef", () => {
  it("splits on the first slash so orca vendor paths stay intact", () => {
    expect(parseModelRef("grok/grok-4.6")).toEqual({
      providerId: "grok",
      modelId: "grok-4.6",
    });
    expect(parseModelRef("orcarouter/orca/orcacyber-zero-1.0")).toEqual({
      providerId: "orcarouter",
      modelId: "orca/orcacyber-zero-1.0",
    });
    expect(parseModelRef("orcarouter/orcarouter/free")).toEqual({
      providerId: "orcarouter",
      modelId: "orcarouter/free",
    });
    expect(parseModelRef("orcarouter/orcarouter/orcarouter/free")).toEqual({
      providerId: "orcarouter",
      modelId: "orcarouter/free",
    });
    expect(parseModelRef("grok")).toBeNull();
    expect(parseModelRef("/model")).toBeNull();
  });

  it("strips a catalog provider prefix from OpenCode vendor ids", () => {
    expect(parseCatalogModel("orcarouter", "orcarouter/orcarouter/free")).toEqual({
      providerId: "orcarouter",
      modelId: "orcarouter/free",
    });
    expect(parseCatalogModel("grok", "grok-4.6")).toEqual({
      providerId: "grok",
      modelId: "grok-4.6",
    });
  });
});

describe("expandSlots", () => {
  it("expands replica counts", () => {
    expect(
      expandSlots(
        [
          { model: "grok/grok-4.6", replicas: 2 },
          { model: "glm/glm-5.3-flash", replicas: 1 },
        ],
        null,
      ).map((item) => item.key),
    ).toEqual(["grok/grok-4.6#1", "grok/grok-4.6#2", "glm/glm-5.3-flash#1"]);
  });

  it("uses two replicas of the manager model when slots are empty", () => {
    expect(
      expandSlots([], { providerId: "grok", modelId: "grok-4.6" }).map((item) => item.key),
    ).toEqual(["grok/grok-4.6#1", "grok/grok-4.6#2"]);
  });
});

describe("runCampaign", () => {
  it("skips a blocked provider after the wait budget", async () => {
    const reports = await runCampaign({
      slots: [
        { model: "grok/grok-4.6", replicas: 1 },
        { model: "glm/glm-5.3-flash", replicas: 1 },
      ],
      fallback: null,
      maxParallel: 2,
      staggerMs: 0,
      usageWaitMs: 0,
      usagePollMs: 1000,
      goal: "scan",
      workerPrompt: (item, goal) => `${goal}:${item.key}`,
      signal: new AbortController().signal,
      ports: ports({
        blockedProviders: async () => new Set(["glm"]),
      }),
    });
    expect(
      reports
        .map((report) => [report.key, report.status] as const)
        .sort((left, right) => left[0].localeCompare(right[0])),
    ).toEqual([
      ["glm/glm-5.3-flash#1", "skipped-usage"],
      ["grok/grok-4.6#1", "completed"],
    ]);
  });

  it("records a failed worker without aborting the rest of the fleet", async () => {
    const reports = await runCampaign({
      slots: [
        { model: "grok/grok-4.6", replicas: 1 },
        { model: "kimi/kimi-for-coding", replicas: 1 },
      ],
      fallback: null,
      maxParallel: 2,
      staggerMs: 0,
      usageWaitMs: 0,
      usagePollMs: 1000,
      goal: "scan",
      workerPrompt: (item) => item.key,
      signal: new AbortController().signal,
      ports: ports({
        runWorker: async (item: CampaignItem) => {
          if (item.providerId === "kimi") throw new Error("boom");
          return { text: "ok", findingsCount: 2 };
        },
      }),
    });
    expect(reports.find((report) => report.providerId === "grok")?.status).toBe("completed");
    expect(reports.find((report) => report.providerId === "kimi")).toMatchObject({
      status: "failed",
      error: "boom",
    });
  });

  it("classifies an Orca 402 as skipped free usage and skips the other replica", async () => {
    const calls: string[] = [];
    const reports = await runCampaign({
      slots: [{ model: "orcarouter/orcarouter/orcarouter/free", replicas: 2 }],
      fallback: null,
      maxParallel: 1,
      staggerMs: 0,
      usageWaitMs: 0,
      usagePollMs: 1000,
      goal: "scan",
      workerPrompt: (item) => item.key,
      signal: new AbortController().signal,
      ports: ports({
        runWorker: async (item: CampaignItem) => {
          calls.push(item.key);
          throw new Error(
            '{"name":"APIError","data":{"statusCode":402,"responseBody":"{\\"error\\":{\\"code\\":\\"free_quota_exhausted\\",\\"metadata\\":{\\"reason\\":\\"err_free_used\\"}}}"}}',
          );
        },
      }),
    });
    expect(calls).toEqual(["orcarouter/orcarouter/free#1"]);
    expect(
      reports
        .map((report) => [report.key, report.status, report.error] as const)
        .sort((left, right) => left[0].localeCompare(right[0])),
    ).toEqual([
      ["orcarouter/orcarouter/free#1", "skipped-usage", "free"],
      ["orcarouter/orcarouter/free#2", "skipped-usage", "free"],
    ]);
  });

  it("emits each report as the worker finishes", async () => {
    const seen: string[] = [];
    await runCampaign({
      slots: [
        { model: "grok/grok-4.6", replicas: 1 },
        { model: "glm/glm-5.3-flash", replicas: 1 },
      ],
      fallback: null,
      maxParallel: 2,
      staggerMs: 0,
      usageWaitMs: 0,
      usagePollMs: 1000,
      goal: "scan",
      workerPrompt: (item) => item.key,
      signal: new AbortController().signal,
      ports: ports({
        blockedProviders: async () => new Set(["glm"]),
      }),
      onReport: (report) => {
        seen.push(`${report.key}:${report.status}`);
      },
    });
    expect(seen.sort()).toEqual(
      ["glm/glm-5.3-flash#1:skipped-usage", "grok/grok-4.6#1:completed"].sort(),
    );
  });

  it("round-robins by provider before starting", () => {
    expect(
      roundRobinByProvider(
        expandSlots(
          [
            { model: "grok/grok-4.6", replicas: 2 },
            { model: "glm/glm-5.3-flash", replicas: 1 },
            { model: "kimi/kimi-for-coding", replicas: 1 },
          ],
          null,
        ),
      ).map((item) => item.key),
    ).toEqual([
      "grok/grok-4.6#1",
      "glm/glm-5.3-flash#1",
      "kimi/kimi-for-coding#1",
      "grok/grok-4.6#2",
    ]);
  });

  it("staggers starts and skips usage before the stagger gate", async () => {
    const started: number[] = [];
    const startedKeys: string[] = [];
    const sleeps: number[] = [];
    const c = clock(1_000);
    const innerSleep = c.sleep;
    c.sleep = async (ms, signal) => {
      sleeps.push(ms);
      await innerSleep(ms, signal);
    };
    await runCampaign({
      slots: [
        { model: "glm/glm-5.3-flash", replicas: 1 },
        { model: "grok/grok-4.6", replicas: 1 },
        { model: "kimi/kimi-for-coding", replicas: 1 },
      ],
      fallback: null,
      maxParallel: 2,
      staggerMs: 30_000,
      usageWaitMs: 0,
      usagePollMs: 1000,
      goal: "scan",
      workerPrompt: (item) => item.key,
      signal: new AbortController().signal,
      ports: ports({
        blockedProviders: async () => new Set(["glm"]),
        clock: c,
      }),
      onStart: (item) => {
        startedKeys.push(item.key);
        started.push(c.now());
      },
    });
    expect(startedKeys).toEqual(["grok/grok-4.6#1", "kimi/kimi-for-coding#1"]);
    expect(sleeps).toContain(30_000);
    expect(started[1]! - started[0]!).toBe(30_000);
  });
});

describe("startDelayMs", () => {
  it("is zero for the first start and for a disabled stagger", () => {
    expect(startDelayMs(-1, 10, 30_000)).toBe(0);
    expect(startDelayMs(0, 10, 0)).toBe(0);
    expect(startDelayMs(0, 10, 30_000)).toBe(29_990);
  });
});
