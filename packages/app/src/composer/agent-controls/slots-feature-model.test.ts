import { describe, expect, it } from "vitest";
import {
  filterSlotOptions,
  replicaCount,
  setSlotReplicas,
  toggleSlot,
  workerCount,
} from "./slots-feature-model";

const grok = { model: "grok/grok-4.6", replicas: 2 };
const glm = { model: "glm/glm-5.3-flash", replicas: 4 };

describe("slots feature model", () => {
  it("counts replicas and workers", () => {
    expect(replicaCount([grok, glm], "glm/glm-5.3-flash")).toBe(4);
    expect(replicaCount([grok], "glm/glm-5.3-flash")).toBe(0);
    expect(workerCount([grok, glm])).toBe(6);
    expect(workerCount([])).toBe(0);
  });

  it("checks a model at min replicas and unchecks by toggling", () => {
    expect(
      toggleSlot({
        slots: [],
        model: "grok/grok-4.6",
        minReplicas: 1,
        maxReplicas: 8,
      }),
    ).toEqual([{ model: "grok/grok-4.6", replicas: 1 }]);
    expect(
      toggleSlot({
        slots: [grok],
        model: "grok/grok-4.6",
        minReplicas: 1,
        maxReplicas: 8,
      }),
    ).toEqual([]);
  });

  it("clamps replica counts and drops a slot below the minimum", () => {
    expect(
      setSlotReplicas({
        slots: [grok],
        model: "grok/grok-4.6",
        replicas: 9,
        minReplicas: 1,
        maxReplicas: 8,
      }),
    ).toEqual([{ model: "grok/grok-4.6", replicas: 8 }]);
    expect(
      setSlotReplicas({
        slots: [grok, glm],
        model: "grok/grok-4.6",
        replicas: 0,
        minReplicas: 1,
        maxReplicas: 8,
      }),
    ).toEqual([glm]);
  });

  it("filters options by label, id, or description", () => {
    const options = [
      { id: "grok/grok-4.6", label: "Grok · Grok 4.6" },
      { id: "glm/glm-5.3-flash", label: "GLM · GLM Flash", description: "cheap flash" },
    ];
    expect(filterSlotOptions(options, "  FLASH ")).toEqual([options[1]]);
    expect(filterSlotOptions(options, "grok/grok")).toEqual([options[0]]);
    expect(filterSlotOptions(options, "")).toEqual(options);
  });
});
