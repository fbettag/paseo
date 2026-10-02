import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_PARALLEL,
  DEFAULT_PACE,
  parseSecurityParams,
  parseSlotsFeatureValue,
  resolveSessionSchedule,
  resolveSessionSlots,
  SECURITY_PACE_FEATURE_ID,
  SECURITY_SLOTS_FEATURE_ID,
} from "./settings.js";

describe("parseSecurityParams", () => {
  it("fills defaults when params are missing", () => {
    expect(parseSecurityParams(undefined)).toMatchObject({
      slots: [],
      pace: DEFAULT_PACE,
      maxParallel: DEFAULT_MAX_PARALLEL,
      staggerMs: 30_000,
      usageWaitMs: 900_000,
      usagePollMs: 30_000,
    });
  });

  it("lets pace win over a leftover maxParallel", () => {
    expect(parseSecurityParams({ pace: "quiet", maxParallel: 4 })).toMatchObject({
      pace: "quiet",
      maxParallel: 1,
      staggerMs: 30_000,
    });
    expect(parseSecurityParams({ pace: "aggressive" })).toMatchObject({
      pace: "aggressive",
      maxParallel: 4,
      staggerMs: 0,
    });
  });

  it("infers pace from maxParallel when pace is absent", () => {
    expect(parseSecurityParams({ maxParallel: 3 })).toMatchObject({
      pace: "steady",
      maxParallel: 3,
      staggerMs: 30_000,
    });
  });

  it("keeps replica slots and clamps nothing already in range", () => {
    const parsed = parseSecurityParams({
      slots: [
        { model: "grok/grok-4.6", replicas: 2 },
        { model: "glm/glm-5.3-flash", replicas: 4 },
      ],
      maxParallel: 3,
      usageWaitMs: 0,
    });
    expect(parsed.slots).toEqual([
      { model: "grok/grok-4.6", replicas: 2 },
      { model: "glm/glm-5.3-flash", replicas: 4 },
    ]);
    expect(parsed.maxParallel).toBe(3);
    expect(parsed.usageWaitMs).toBe(0);
  });

  it("falls back when the object is not a params record", () => {
    expect(parseSecurityParams("nope").slots).toEqual([]);
    expect(parseSecurityParams({ replicas: 99 }).slots).toEqual([]);
  });
});

describe("resolveSessionSlots", () => {
  it("uses provider params when the session has no slots feature", () => {
    expect(resolveSessionSlots(undefined, [{ model: "grok/grok-4.6", replicas: 2 }])).toEqual([
      { model: "grok/grok-4.6", replicas: 2 },
    ]);
  });

  it("prefers an explicit empty feature value over provider params", () => {
    expect(
      resolveSessionSlots({ [SECURITY_SLOTS_FEATURE_ID]: [] }, [
        { model: "grok/grok-4.6", replicas: 2 },
      ]),
    ).toEqual([]);
  });

  it("parses slot arrays and rejects junk", () => {
    expect(parseSlotsFeatureValue([{ model: "glm/glm-5.3-flash", replicas: 4 }])).toEqual([
      { model: "glm/glm-5.3-flash", replicas: 4 },
    ]);
    expect(parseSlotsFeatureValue("nope")).toEqual([]);
  });
});

describe("resolveSessionSchedule", () => {
  it("uses the session pace feature over provider params", () => {
    expect(
      resolveSessionSchedule(
        { [SECURITY_PACE_FEATURE_ID]: "steady" },
        {
          pace: "quiet",
          maxParallel: 1,
          staggerMs: 30_000,
        },
      ),
    ).toEqual({ pace: "steady", maxParallel: 2, staggerMs: 30_000 });
  });
});
