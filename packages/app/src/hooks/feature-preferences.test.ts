import { describe, expect, it } from "vitest";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";

import {
  applyFeatureValues,
  featureValueUpdates,
  resolveFeatureValues,
  stepperPersistencePatch,
  withParallelPreference,
} from "./feature-preferences";

describe("feature-preferences", () => {
  const features = [
    {
      type: "toggle" as const,
      id: "fast_mode",
      label: "Fast",
      value: false,
    },
    {
      type: "toggle" as const,
      id: "plan_mode",
      label: "Plan",
      value: false,
    },
  ];

  it("restores persisted values for available features", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          unknown_feature: true,
        },
        localFeatureValues: {},
      }),
    ).toEqual({
      fast_mode: true,
    });
  });

  it("prefers local values over persisted values", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          plan_mode: false,
        },
        localFeatureValues: {
          fast_mode: false,
        },
      }),
    ).toEqual({
      fast_mode: false,
      plan_mode: false,
    });
  });
});

const slots: AgentFeature = {
  type: "slots",
  id: "slots",
  label: "Subagent models",
  value: [{ model: "grok/grok-4.6", replicas: 2 }],
  options: [],
  minReplicas: 1,
  maxReplicas: 8,
};

const parallel: AgentFeature = {
  type: "stepper",
  id: "parallel",
  label: "Parallel",
  value: 1,
  min: 1,
  max: 2,
};

describe("applyFeatureValues", () => {
  it("raises the stepper max to the selected replicas and clamps a stored integer", () => {
    const features = applyFeatureValues([slots, parallel], {
      slots: [
        { model: "grok/grok-4.6", replicas: 1 },
        { model: "glm/glm-5.3-flash", replicas: 1 },
      ],
      parallel: 4,
    });
    expect(features.find((feature) => feature.id === "parallel")).toMatchObject({
      value: 2,
      max: 2,
    });
  });

  it("uses two as the max when no model is selected", () => {
    const features = applyFeatureValues([slots, parallel], { slots: [], parallel: 2 });
    expect(features.find((feature) => feature.id === "parallel")).toMatchObject({
      value: 2,
      max: 2,
    });
  });

  it("reads a saved pace when parallel is absent", () => {
    const features = applyFeatureValues([{ ...parallel, max: 8 }, slots], { pace: "aggressive" });
    expect(features.find((feature) => feature.id === "parallel")).toMatchObject({ value: 2 });
  });
});

describe("featureValueUpdates", () => {
  it("drops the stored parallel integer when the slot count falls below it", () => {
    const current: AgentFeature[] = [
      {
        ...slots,
        value: [
          { model: "grok/grok-4.6", replicas: 2 },
          { model: "glm/glm-5.3-flash", replicas: 2 },
        ],
      },
      { ...parallel, value: 4, max: 4 },
    ];
    expect(
      featureValueUpdates(current, "slots", [{ model: "grok/grok-4.6", replicas: 1 }]),
    ).toEqual({
      slots: [{ model: "grok/grok-4.6", replicas: 1 }],
      parallel: 1,
    });
  });
});

describe("stepper persistence", () => {
  it("persists a pace migration as the parallel integer", () => {
    const features = applyFeatureValues([slots, { ...parallel, max: 8 }], { pace: "steady" });
    expect(
      stepperPersistencePatch(features, withParallelPreference(features, {}, { pace: "steady" })),
    ).toEqual(null);
    expect(withParallelPreference(features, {}, { pace: "steady" })).toEqual({ parallel: 2 });
  });

  it("persists a clamp when the stored integer is above the displayed value", () => {
    const features = applyFeatureValues([slots, parallel], { parallel: 6 });
    expect(stepperPersistencePatch(features, { parallel: 6 })).toEqual({ parallel: 2 });
  });
});
