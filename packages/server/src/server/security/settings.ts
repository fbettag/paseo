import { z } from "zod";

export const SECURITY_PACES = ["quiet", "steady", "aggressive"] as const;
export type SecurityPace = (typeof SECURITY_PACES)[number];

export const DEFAULT_PACE: SecurityPace = "quiet";
export const DEFAULT_MAX_PARALLEL = 1;
export const DEFAULT_STAGGER_MS = 30_000;
export const DEFAULT_USAGE_WAIT_MS = 900_000;
export const DEFAULT_USAGE_POLL_MS = 30_000;

export const PACE_SCHEDULE: Record<SecurityPace, { maxParallel: number; staggerMs: number }> = {
  quiet: { maxParallel: 1, staggerMs: DEFAULT_STAGGER_MS },
  steady: { maxParallel: 2, staggerMs: DEFAULT_STAGGER_MS },
  aggressive: { maxParallel: 4, staggerMs: 0 },
};

export const SecuritySlotSchema = z.object({
  model: z.string().min(1),
  replicas: z.number().int().min(1).max(8),
});

export const SecurityPaceSchema = z.enum(SECURITY_PACES);

export const SecurityProviderParamsSchema = z.object({
  slots: z.array(SecuritySlotSchema).optional(),
  pace: SecurityPaceSchema.optional(),
  maxParallel: z.number().int().min(1).max(8).optional(),
  staggerMs: z.number().int().min(0).optional(),
  usageWaitMs: z.number().int().min(0).optional(),
  usagePollMs: z.number().int().min(1000).optional(),
});

export type SecuritySlot = z.infer<typeof SecuritySlotSchema>;
export type SecurityProviderParams = z.infer<typeof SecurityProviderParamsSchema>;

export interface ResolvedSecurityParams {
  slots: SecuritySlot[];
  pace: SecurityPace;
  maxParallel: number;
  staggerMs: number;
  usageWaitMs: number;
  usagePollMs: number;
}

export interface ResolvedSecuritySchedule {
  pace: SecurityPace;
  maxParallel: number;
  staggerMs: number;
}

export const SECURITY_SLOTS_FEATURE_ID = "slots";
export const SECURITY_PACE_FEATURE_ID = "pace";
export const SECURITY_PARALLEL_FEATURE_ID = "parallel";
/** An empty slot list still runs two copies of the manager model. */
export const EMPTY_SLOT_WORKER_LIMIT = 2;

export function parsePace(value: unknown): SecurityPace | null {
  const parsed = SecurityPaceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseSecurityParams(value: unknown): ResolvedSecurityParams {
  const parsed = SecurityProviderParamsSchema.safeParse(value ?? {});
  if (!parsed.success) {
    return {
      slots: [],
      ...scheduleFromPace(DEFAULT_PACE),
      usageWaitMs: DEFAULT_USAGE_WAIT_MS,
      usagePollMs: DEFAULT_USAGE_POLL_MS,
    };
  }
  const schedule = scheduleFromParams(parsed.data);
  return {
    slots: parsed.data.slots ?? [],
    ...schedule,
    usageWaitMs: parsed.data.usageWaitMs ?? DEFAULT_USAGE_WAIT_MS,
    usagePollMs: parsed.data.usagePollMs ?? DEFAULT_USAGE_POLL_MS,
  };
}

export function workerLimit(slots: readonly SecuritySlot[]): number {
  let count = 0;
  for (const slot of slots) {
    count += slot.replicas;
  }
  if (count === 0) return EMPTY_SLOT_WORKER_LIMIT;
  return count;
}

export function parseParallel(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  if (truncated < 1) return null;
  return truncated;
}

export function clampParallel(value: unknown, limit: number): number {
  const parsed = parseParallel(value) ?? 1;
  return Math.min(Math.max(1, limit), Math.max(1, parsed));
}

export function scheduleFromParallel(parallel: number): ResolvedSecuritySchedule {
  const maxParallel = Math.max(1, parallel);
  return {
    pace: inferPace(maxParallel),
    maxParallel,
    staggerMs: maxParallel === 1 ? DEFAULT_STAGGER_MS : 0,
  };
}

export function resolveSessionSchedule(
  featureValues: Record<string, unknown> | undefined,
  fallback: ResolvedSecuritySchedule,
  slots: readonly SecuritySlot[] = [],
): ResolvedSecuritySchedule {
  const limit = workerLimit(slots);
  if (
    featureValues &&
    Object.prototype.hasOwnProperty.call(featureValues, SECURITY_PARALLEL_FEATURE_ID)
  ) {
    return scheduleFromParallel(clampParallel(featureValues[SECURITY_PARALLEL_FEATURE_ID], limit));
  }
  const pace = parsePace(featureValues?.[SECURITY_PACE_FEATURE_ID]);
  const base = pace ? scheduleFromPace(pace) : fallback;
  return clampSchedule(base, limit);
}

function clampSchedule(
  schedule: ResolvedSecuritySchedule,
  limit: number,
): ResolvedSecuritySchedule {
  const maxParallel = Math.min(schedule.maxParallel, limit);
  if (maxParallel === schedule.maxParallel) return schedule;
  if (maxParallel <= 1) {
    return scheduleFromParallel(1);
  }
  return {
    pace: inferPace(maxParallel),
    maxParallel,
    staggerMs: schedule.staggerMs,
  };
}

export function parseSlotsFeatureValue(value: unknown): SecuritySlot[] {
  const parsed = z.array(SecuritySlotSchema).safeParse(value);
  if (!parsed.success) return [];
  return parsed.data;
}

export function resolveSessionSlots(
  featureValues: Record<string, unknown> | undefined,
  fallback: readonly SecuritySlot[],
): SecuritySlot[] {
  if (
    !featureValues ||
    !Object.prototype.hasOwnProperty.call(featureValues, SECURITY_SLOTS_FEATURE_ID)
  ) {
    return [...fallback];
  }
  return parseSlotsFeatureValue(featureValues[SECURITY_SLOTS_FEATURE_ID]);
}

export function scheduleFromPace(pace: SecurityPace): ResolvedSecuritySchedule {
  const mapped = PACE_SCHEDULE[pace];
  return { pace, maxParallel: mapped.maxParallel, staggerMs: mapped.staggerMs };
}

function scheduleFromParams(data: SecurityProviderParams): ResolvedSecuritySchedule {
  const pace = parsePace(data.pace);
  if (pace) return scheduleFromPace(pace);
  if (typeof data.maxParallel === "number") {
    const inferred = inferPace(data.maxParallel);
    return {
      pace: inferred,
      maxParallel: data.maxParallel,
      staggerMs: data.staggerMs ?? PACE_SCHEDULE[inferred].staggerMs,
    };
  }
  const fallback = scheduleFromPace(DEFAULT_PACE);
  return {
    ...fallback,
    staggerMs: data.staggerMs ?? fallback.staggerMs,
  };
}

function inferPace(maxParallel: number): SecurityPace {
  if (maxParallel >= 4) return "aggressive";
  if (maxParallel >= 2) return "steady";
  return "quiet";
}
