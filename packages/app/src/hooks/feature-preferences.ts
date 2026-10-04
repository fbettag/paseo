import type { AgentFeature, AgentFeatureSlotValue } from "@getpaseo/protocol/agent-types";

/** Empty Security slots still run two copies of the manager model. */
const EMPTY_SLOT_WORKER_LIMIT = 2;

export function pruneFeatureValues(
  featureValues: Record<string, unknown>,
  features: AgentFeature[],
): Record<string, unknown> {
  const allowedFeatureIds = new Set(features.map((feature) => feature.id));
  let changed = false;
  const next: Record<string, unknown> = {};

  for (const [featureId, value] of Object.entries(featureValues)) {
    if (!allowedFeatureIds.has(featureId)) {
      changed = true;
      continue;
    }
    next[featureId] = value;
  }

  return changed ? next : featureValues;
}

export function slotWorkerLimit(slots: readonly { replicas?: unknown }[]): number {
  let count = 0;
  for (const slot of slots) {
    if (typeof slot.replicas === "number" && slot.replicas > 0) {
      count += slot.replicas;
    }
  }
  return count === 0 ? EMPTY_SLOT_WORKER_LIMIT : count;
}

export function applyFeatureValues(
  features: AgentFeature[],
  featureValues: Record<string, unknown>,
): AgentFeature[] {
  const overlaid =
    Object.keys(featureValues).length === 0
      ? features
      : features.map((feature) => overlayFeature(feature, featureValues));
  return clampSteppersToSlots(overlaid);
}

function overlayFeature(
  feature: AgentFeature,
  featureValues: Record<string, unknown>,
): AgentFeature {
  if (Object.prototype.hasOwnProperty.call(featureValues, feature.id)) {
    return {
      ...feature,
      value: featureValues[feature.id],
    } as AgentFeature;
  }
  // Composer prefs saved the old Pace select. The Parallel stepper replaces it.
  if (feature.type !== "stepper" || feature.id !== "parallel") return feature;
  const fromPace = parallelFromPace(featureValues.pace);
  if (fromPace === null) return feature;
  return { ...feature, value: fromPace };
}

function parallelFromPace(value: unknown): number | null {
  if (value === "quiet") return 1;
  if (value === "steady") return 2;
  if (value === "aggressive") return 4;
  return null;
}

function clampSteppersToSlots(features: AgentFeature[]): AgentFeature[] {
  const slotsFeature = features.find((feature) => feature.type === "slots");
  if (!slotsFeature || slotsFeature.type !== "slots") return features;
  const limit = slotWorkerLimit(slotsFeature.value);
  let changed = false;
  const next = features.map((feature) => {
    if (feature.type !== "stepper") return feature;
    const max = Math.max(feature.min, limit);
    const value = Math.min(max, Math.max(feature.min, feature.value));
    if (feature.max === max && feature.value === value) return feature;
    changed = true;
    return { ...feature, max, value };
  });
  return changed ? next : features;
}

export function withParallelPreference(
  features: readonly AgentFeature[],
  featureValues: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(featureValues, "parallel")) return featureValues;
  const hasParallel = features.some(
    (feature) => feature.type === "stepper" && feature.id === "parallel",
  );
  if (!hasParallel) return featureValues;
  const parallel = parallelFromPace(stored.pace);
  if (parallel === null) return featureValues;
  return { ...featureValues, parallel };
}

export function featureValueUpdates(
  features: readonly AgentFeature[],
  featureId: string,
  value: unknown,
): Record<string, unknown> {
  const updates: Record<string, unknown> = { [featureId]: value };
  const slotsFeature = features.find(
    (feature) => feature.id === featureId && feature.type === "slots",
  );
  if (!slotsFeature || !Array.isArray(value)) return updates;
  const limit = slotWorkerLimit(value as AgentFeatureSlotValue[]);
  for (const feature of features) {
    if (feature.type !== "stepper") continue;
    if (feature.value > limit) updates[feature.id] = limit;
  }
  return updates;
}

export function stepperPersistencePatch(
  features: readonly AgentFeature[],
  featureValues: Record<string, unknown>,
): Record<string, unknown> | null {
  let patch: Record<string, unknown> | null = null;
  for (const feature of features) {
    if (feature.type !== "stepper") continue;
    const stored = featureValues[feature.id];
    if (typeof stored === "number" && stored > feature.value) {
      patch ??= {};
      patch[feature.id] = feature.value;
      continue;
    }
    if (
      stored === undefined &&
      feature.id === "parallel" &&
      parallelFromPace(featureValues.pace) !== null
    ) {
      patch ??= {};
      patch[feature.id] = feature.value;
    }
  }
  return patch;
}

export function resolveFeatureValues(args: {
  features: AgentFeature[];
  persistedFeatureValues: Record<string, unknown>;
  localFeatureValues: Record<string, unknown>;
}): Record<string, unknown> {
  const next: Record<string, unknown> = {};

  for (const feature of args.features) {
    if (Object.prototype.hasOwnProperty.call(args.localFeatureValues, feature.id)) {
      next[feature.id] = args.localFeatureValues[feature.id];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(args.persistedFeatureValues, feature.id)) {
      next[feature.id] = args.persistedFeatureValues[feature.id];
    }
  }

  return next;
}
