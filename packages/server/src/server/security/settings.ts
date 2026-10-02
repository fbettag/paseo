import { z } from "zod";

export const DEFAULT_MAX_PARALLEL = 4;
export const DEFAULT_USAGE_WAIT_MS = 900_000;
export const DEFAULT_USAGE_POLL_MS = 30_000;

export const SecuritySlotSchema = z.object({
  model: z.string().min(1),
  replicas: z.number().int().min(1).max(8),
});

export const SecurityProviderParamsSchema = z.object({
  slots: z.array(SecuritySlotSchema).optional(),
  maxParallel: z.number().int().min(1).max(8).optional(),
  usageWaitMs: z.number().int().min(0).optional(),
  usagePollMs: z.number().int().min(1000).optional(),
});

export type SecuritySlot = z.infer<typeof SecuritySlotSchema>;
export type SecurityProviderParams = z.infer<typeof SecurityProviderParamsSchema>;

export interface ResolvedSecurityParams {
  slots: SecuritySlot[];
  maxParallel: number;
  usageWaitMs: number;
  usagePollMs: number;
}

export function parseSecurityParams(value: unknown): ResolvedSecurityParams {
  const parsed = SecurityProviderParamsSchema.safeParse(value ?? {});
  if (!parsed.success) {
    return {
      slots: [],
      maxParallel: DEFAULT_MAX_PARALLEL,
      usageWaitMs: DEFAULT_USAGE_WAIT_MS,
      usagePollMs: DEFAULT_USAGE_POLL_MS,
    };
  }
  return {
    slots: parsed.data.slots ?? [],
    maxParallel: parsed.data.maxParallel ?? DEFAULT_MAX_PARALLEL,
    usageWaitMs: parsed.data.usageWaitMs ?? DEFAULT_USAGE_WAIT_MS,
    usagePollMs: parsed.data.usagePollMs ?? DEFAULT_USAGE_POLL_MS,
  };
}
