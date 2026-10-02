import type { SecuritySlot } from "./settings.js";
import { classifyOrcaUsageSkip, UsageSkipError } from "./usage-error.js";

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface CampaignItem extends ModelRef {
  key: string;
  replica: number;
}

export type CampaignStatus = "completed" | "failed" | "skipped-usage";

export interface CampaignReport extends CampaignItem {
  status: CampaignStatus;
  findingsCount: number;
  text?: string;
  error?: string;
}

export interface CampaignClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface CampaignPorts {
  blockedProviders(): Promise<ReadonlySet<string>>;
  runWorker(
    item: CampaignItem,
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ text: string; findingsCount: number }>;
  shuffle<T>(items: T[]): T[];
  clock: CampaignClock;
}

export interface RunCampaignInput {
  slots: readonly SecuritySlot[];
  fallback: ModelRef | null;
  maxParallel: number;
  usageWaitMs: number;
  usagePollMs: number;
  goal: string;
  workerPrompt: (item: CampaignItem, goal: string) => string;
  signal: AbortSignal;
  ports: CampaignPorts;
  onReport?: (report: CampaignReport) => void;
}

export function parseModelRef(ref: string): ModelRef | null {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const providerId = trimmed.slice(0, slash);
  return {
    providerId,
    modelId: stripRepeatedProviderPrefix(providerId, trimmed.slice(slash + 1)),
  };
}

export function modelRefKey(ref: ModelRef): string {
  return `${ref.providerId}/${ref.modelId}`;
}

export function stripRepeatedProviderPrefix(providerId: string, modelId: string): string {
  const prefix = `${providerId}/`;
  let current = modelId;
  while (current.startsWith(prefix)) {
    const next = current.slice(prefix.length);
    if (!next.includes("/")) break;
    current = next;
  }
  return current;
}

export function parseCatalogModel(
  providerId: string,
  modelId: string,
): { providerId: string; modelId: string } {
  const prefixed = modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`;
  return parseModelRef(prefixed) ?? { providerId, modelId };
}

export function expandSlots(
  slots: readonly SecuritySlot[],
  fallback: ModelRef | null,
): CampaignItem[] {
  let source: readonly SecuritySlot[] = slots;
  if (source.length === 0 && fallback) {
    source = [{ model: modelRefKey(fallback), replicas: 2 }];
  }
  const items: CampaignItem[] = [];
  for (const slot of source) {
    const parsed = parseModelRef(slot.model);
    if (!parsed) continue;
    for (let replica = 1; replica <= slot.replicas; replica += 1) {
      items.push({
        key: `${modelRefKey(parsed)}#${replica}`,
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        replica,
      });
    }
  }
  return items;
}

export function shuffleInPlace<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const current = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = current;
  }
  return copy;
}

export function defaultClock(): CampaignClock {
  return {
    now: () => Date.now(),
    sleep,
  };
}

export async function runCampaign(input: RunCampaignInput): Promise<CampaignReport[]> {
  const items = input.ports.shuffle(expandSlots(input.slots, input.fallback));
  const reports: CampaignReport[] = [];
  const queue = [...items];
  const skippedModels = new Map<string, "free" | "credits">();
  const parallel = Math.max(1, Math.min(input.maxParallel, queue.length || 1));
  const workers = Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (!input.signal.aborted) {
      const item = queue.shift();
      if (!item) return;
      const report = await runOne(item, input, skippedModels);
      reports.push(report);
      input.onReport?.(report);
    }
  });
  await Promise.all(workers);
  return reports;
}

async function runOne(
  item: CampaignItem,
  input: RunCampaignInput,
  skippedModels: Map<string, "free" | "credits">,
): Promise<CampaignReport> {
  const modelKey = modelRefKey(item);
  const alreadySkipped = skippedModels.get(modelKey);
  if (alreadySkipped) {
    return { ...item, status: "skipped-usage", findingsCount: 0, error: alreadySkipped };
  }
  const usable = await waitForUsage(item.providerId, input);
  if (!usable) {
    return { ...item, status: "skipped-usage", findingsCount: 0 };
  }
  try {
    const result = await input.ports.runWorker(
      item,
      input.workerPrompt(item, input.goal),
      input.signal,
    );
    return {
      ...item,
      status: "completed",
      findingsCount: result.findingsCount,
      text: result.text,
    };
  } catch (error) {
    if (input.signal.aborted) {
      return { ...item, status: "failed", findingsCount: 0, error: "aborted" };
    }
    const skip = error instanceof UsageSkipError ? error.kind : classifyOrcaUsageSkip(error);
    if (skip) {
      skippedModels.set(modelKey, skip);
      return { ...item, status: "skipped-usage", findingsCount: 0, error: skip };
    }
    return {
      ...item,
      status: "failed",
      findingsCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitForUsage(providerId: string, input: RunCampaignInput): Promise<boolean> {
  const deadline = input.ports.clock.now() + input.usageWaitMs;
  while (!input.signal.aborted) {
    const blocked = await input.ports.blockedProviders();
    if (!blocked.has(providerId)) return true;
    const remaining = deadline - input.ports.clock.now();
    if (remaining <= 0) return false;
    await input.ports.clock.sleep(Math.min(input.usagePollMs, remaining), input.signal);
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
