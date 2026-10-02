import type { CampaignItem } from "./campaign.js";
import type { FindingCard } from "./findings.js";
import type { SecurityPace } from "./settings.js";

export const CAMPAIGN_WORKER_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "skipped-usage",
] as const;

export type CampaignWorkerState = (typeof CAMPAIGN_WORKER_STATES)[number];
export type CampaignFinding = FindingCard;

export const MAX_CAMPAIGN_FINDINGS = 50;

export interface CampaignWorkerSnapshot {
  key: string;
  providerId: string;
  modelId: string;
  replica: number;
  state: CampaignWorkerState;
  findingsCount: number;
  agentId?: string;
  error?: string;
}

export interface CampaignSnapshot {
  total: number;
  queued: number;
  running: number;
  done: number;
  skipped: number;
  failed: number;
  findingsCount: number;
  workers: CampaignWorkerSnapshot[];
  findings: CampaignFinding[];
  complete: boolean;
  pace: SecurityPace;
}

export function queuedWorkers(items: readonly CampaignItem[]): CampaignWorkerSnapshot[] {
  return items.map((item) => ({
    key: item.key,
    providerId: item.providerId,
    modelId: item.modelId,
    replica: item.replica,
    state: "queued" as const,
    findingsCount: 0,
  }));
}

export function createCampaignSnapshot(
  items: readonly CampaignItem[],
  pace: SecurityPace,
): CampaignSnapshot {
  return tallyCampaign({
    workers: queuedWorkers(items),
    findings: [],
    complete: false,
    pace,
  });
}

export function tallyCampaign(input: {
  workers: CampaignWorkerSnapshot[];
  findings: CampaignFinding[];
  complete: boolean;
  pace: SecurityPace;
}): CampaignSnapshot {
  let queued = 0;
  let running = 0;
  let done = 0;
  let skipped = 0;
  let failed = 0;
  for (const worker of input.workers) {
    if (worker.state === "queued") queued += 1;
    else if (worker.state === "running") running += 1;
    else if (worker.state === "completed") done += 1;
    else if (worker.state === "skipped-usage") skipped += 1;
    else failed += 1;
  }
  return {
    total: input.workers.length,
    queued,
    running,
    done,
    skipped,
    failed,
    findingsCount: input.findings.length,
    workers: input.workers,
    findings: input.findings,
    complete: input.complete,
    pace: input.pace,
  };
}

export function patchCampaignWorker(
  snapshot: CampaignSnapshot,
  key: string,
  patch: Partial<CampaignWorkerSnapshot>,
): CampaignSnapshot {
  const workers = snapshot.workers.map((worker) =>
    worker.key === key ? { ...worker, ...patch } : worker,
  );
  return tallyCampaign({ ...snapshot, workers });
}

export function appendCampaignFindings(
  snapshot: CampaignSnapshot,
  findings: readonly CampaignFinding[],
): CampaignSnapshot {
  if (findings.length === 0) return snapshot;
  return tallyCampaign({
    ...snapshot,
    findings: [...snapshot.findings, ...findings].slice(-MAX_CAMPAIGN_FINDINGS),
  });
}
