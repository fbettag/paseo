import { describe, expect, it } from "vitest";

import {
  classifyEnabledModel,
  routeModels,
  type ClassifiedModel,
  type EnabledModel,
  type RouteJudgment,
} from "./model-router.js";

function model(input: EnabledModel): ClassifiedModel {
  return classifyEnabledModel(input);
}

const CATALOG = [
  model({
    providerId: "codex",
    providerLabel: "Codex",
    modelId: "gpt-5.4",
    label: "GPT-5.4",
  }),
  model({
    providerId: "codex-work",
    providerLabel: "Codex Work",
    modelId: "gpt-daybreak-blue-latest",
    label: "Daybreak",
    description: "Cybersecurity specialist",
  }),
  model({
    providerId: "qwen",
    providerLabel: "Qwen",
    modelId: "qwen3.7-plus",
    label: "Qwen3.7 Plus",
    isDefault: true,
  }),
  model({
    providerId: "glm",
    providerLabel: "GLM",
    modelId: "glm-5.3",
    label: "GLM 5.3",
  }),
  model({
    providerId: "glm",
    providerLabel: "GLM",
    modelId: "glm-5.3-flash",
    label: "GLM 5.3 Flash",
  }),
  model({
    providerId: "qwen",
    providerLabel: "Qwen",
    modelId: "qwen3.6-flash",
    label: "Qwen Flash",
  }),
  model({
    providerId: "claude",
    providerLabel: "Claude",
    modelId: "claude-opus-5",
    label: "Opus",
  }),
];

const HEAVY: RouteJudgment = {
  kind: "cyber_heavy",
  complexity: 0.9,
  capability: 0.95,
  deepReasoning: 0.8,
};
const LIGHT: RouteJudgment = {
  kind: "cyber_light",
  complexity: 0.45,
  capability: 0.5,
  deepReasoning: 0.3,
};
const QUICK: RouteJudgment = {
  kind: "quick",
  complexity: 0.1,
  capability: 0.1,
  deepReasoning: 0.1,
};
const CODING: RouteJudgment = {
  kind: "coding",
  complexity: 0.55,
  capability: 0.55,
  deepReasoning: 0.4,
};

describe("classifyEnabledModel", () => {
  it("reads tier and specialty from the model id instead of a fixed catalog", () => {
    expect(
      model({
        providerId: "acme",
        providerLabel: "Acme",
        modelId: "acme-flash",
        label: "Acme Flash",
      }),
    ).toMatchObject({
      tier: "flash",
      specialty: "general",
    });
    expect(
      model({
        providerId: "acme",
        providerLabel: "Acme",
        modelId: "acme-ultra",
        label: "Acme Ultra",
      }),
    ).toMatchObject({
      tier: "strong",
      specialty: "general",
    });
    expect(
      model({
        providerId: "vendor",
        providerLabel: "Vendor",
        modelId: "vendor-x-daybreak",
        label: "Vendor Daybreak",
      }),
    ).toMatchObject({ tier: "strong", specialty: "cyber" });
  });
});

describe("routeModels", () => {
  it("reserves a daybreak model for heavy cybersecurity", () => {
    const decision = routeModels(CATALOG, HEAVY);
    expect(decision).toMatchObject({
      providerId: "codex-work",
      modelId: "gpt-daybreak-blue-latest",
      specialty: "cyber",
    });
  });

  it("sends light cybersecurity to an enabled standard model", () => {
    const decision = routeModels(CATALOG, LIGHT);
    expect(decision).toMatchObject({
      providerId: "qwen",
      modelId: "qwen3.7-plus",
      tier: "standard",
      specialty: "general",
    });
  });

  it("uses an enabled flash model for quick work", () => {
    const decision = routeModels(CATALOG, QUICK);
    expect(decision).toMatchObject({
      providerId: "glm",
      modelId: "glm-5.3-flash",
      tier: "flash",
    });
  });

  it("keeps ordinary coding off the cybersecurity specialist", () => {
    const decision = routeModels(CATALOG, CODING);
    expect(decision?.specialty).toBe("general");
    expect(decision?.modelId).toBe("qwen3.7-plus");
  });

  it("stays on the opened provider after the first route", () => {
    const first = routeModels(CATALOG, HEAVY);
    const second = routeModels(CATALOG, QUICK, {
      pin: first
        ? {
            providerId: first.providerId,
            modelId: first.modelId,
            tier: first.tier,
            specialty: first.specialty,
            demand: first.demand,
          }
        : null,
    });
    expect(second).toMatchObject({
      providerId: "codex-work",
      modelId: "gpt-daybreak-blue-latest",
      kept: true,
    });
  });

  it("can move from flash to a stronger model on the same provider", () => {
    const flash = CATALOG.find((entry) => entry.modelId === "qwen3.6-flash");
    expect(flash).toBeDefined();
    const decision = routeModels(
      CATALOG,
      {
        kind: "coding",
        complexity: 0.95,
        capability: 0.95,
        deepReasoning: 0.9,
      },
      {
        pin: {
          providerId: flash!.providerId,
          modelId: flash!.modelId,
          tier: flash!.tier,
          specialty: flash!.specialty,
          demand: 0.1,
        },
      },
    );
    expect(decision).toMatchObject({ providerId: "qwen", modelId: "qwen3.7-plus", kept: false });
  });

  it("steps down a tier when budget pressure is high", () => {
    const pressured = routeModels(
      CATALOG,
      { kind: "coding", complexity: 0.95, capability: 0.95, deepReasoning: 0.2 },
      { pressure: 0.8 },
    );
    const open = routeModels(CATALOG, {
      kind: "coding",
      complexity: 0.95,
      capability: 0.95,
      deepReasoning: 0.2,
    });
    expect(open?.modelId).toBe("claude-opus-5");
    expect(pressured?.tier).toBe("standard");
    expect(pressured?.modelId).not.toBe("gpt-daybreak-blue-latest");
  });

  it("returns null when nothing is enabled", () => {
    expect(routeModels([], QUICK)).toBeNull();
  });

  it("returns null when every enabled account is out of usage", () => {
    const decision = routeModels(CATALOG, QUICK, {
      blockedProviderIds: new Set(CATALOG.map((entry) => entry.providerId)),
    });
    expect(decision).toBeNull();
  });

  it("leaves an exhausted account and picks another enabled provider", () => {
    const first = routeModels(CATALOG, HEAVY);
    const decision = routeModels(CATALOG, HEAVY, {
      pin: first
        ? {
            providerId: first.providerId,
            modelId: first.modelId,
            tier: first.tier,
            specialty: first.specialty,
            demand: first.demand,
          }
        : null,
      blockedProviderIds: new Set(["codex-work"]),
    });
    expect(decision?.providerId).not.toBe("codex-work");
    expect(decision?.fallback).toBe(true);
    expect(decision?.specialty).toBe("general");
  });
});
