import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_PARALLEL,
  parseSecurityParams,
  parseSlotsFeatureValue,
  resolveSessionSlots,
  SECURITY_SLOTS_FEATURE_ID,
} from "./settings.js";

describe("parseSecurityParams", () => {
  it("fills defaults when params are missing", () => {
    expect(parseSecurityParams(undefined)).toMatchObject({
      slots: [],
      maxParallel: DEFAULT_MAX_PARALLEL,
      usageWaitMs: 900_000,
      usagePollMs: 30_000,
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
