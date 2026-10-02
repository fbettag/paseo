import type { AgentFeatureSlotValue, AgentSelectOption } from "@getpaseo/protocol/agent-types";

export function replicaCount(slots: readonly AgentFeatureSlotValue[], model: string): number {
  return slots.find((slot) => slot.model === model)?.replicas ?? 0;
}

export function workerCount(slots: readonly AgentFeatureSlotValue[]): number {
  return slots.reduce((sum, slot) => sum + slot.replicas, 0);
}

export function toggleSlot(input: {
  slots: readonly AgentFeatureSlotValue[];
  model: string;
  minReplicas: number;
  maxReplicas: number;
}): AgentFeatureSlotValue[] {
  if (replicaCount(input.slots, input.model) > 0) {
    return input.slots.filter((slot) => slot.model !== input.model);
  }
  return setSlotReplicas({
    slots: input.slots,
    model: input.model,
    replicas: input.minReplicas,
    minReplicas: input.minReplicas,
    maxReplicas: input.maxReplicas,
  });
}

export function setSlotReplicas(input: {
  slots: readonly AgentFeatureSlotValue[];
  model: string;
  replicas: number;
  minReplicas: number;
  maxReplicas: number;
}): AgentFeatureSlotValue[] {
  if (input.replicas < input.minReplicas) {
    return input.slots.filter((slot) => slot.model !== input.model);
  }
  const replicas = Math.min(input.maxReplicas, input.replicas);
  const next: AgentFeatureSlotValue[] = [];
  let replaced = false;
  for (const slot of input.slots) {
    if (slot.model !== input.model) {
      next.push(slot);
      continue;
    }
    next.push({ model: input.model, replicas });
    replaced = true;
  }
  if (!replaced) {
    next.push({ model: input.model, replicas });
  }
  return next;
}

export function filterSlotOptions(
  options: readonly AgentSelectOption[],
  query: string,
): AgentSelectOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...options];
  }
  return options.filter((option) => {
    const description = option.description ?? "";
    const haystack = `${option.label} ${option.id} ${description}`.toLowerCase();
    return haystack.includes(needle);
  });
}
