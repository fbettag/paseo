import type { CampaignItem } from "./campaign.js";
import type { FindingAlsoFound, FindingCard } from "./findings.js";
import type { SecurityPace } from "./settings.js";

const MIN_TITLE_KEY = 12;

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
  scopes: string[];
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
  scopes: readonly string[] = [],
): CampaignSnapshot {
  return tallyCampaign({
    workers: queuedWorkers(items),
    findings: [],
    complete: false,
    pace,
    scopes,
  });
}

export function tallyCampaign(input: {
  workers: CampaignWorkerSnapshot[];
  findings: CampaignFinding[];
  complete: boolean;
  pace: SecurityPace;
  scopes?: readonly string[];
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
    scopes: [...(input.scopes ?? [])],
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
  return tallyCampaign({ ...snapshot, workers, scopes: snapshot.scopes });
}

export function appendCampaignFindings(
  snapshot: CampaignSnapshot,
  findings: readonly CampaignFinding[],
): CampaignSnapshot {
  if (findings.length === 0) return snapshot;
  const merged = [...snapshot.findings];
  for (const finding of findings) {
    const index = merged.findIndex((existing) => sameFinding(existing, finding));
    if (index < 0) {
      merged.push(finding);
      continue;
    }
    const previous = merged[index];
    if (!previous) continue;
    merged[index] = mergeFinding(previous, finding);
  }
  return tallyCampaign({
    ...snapshot,
    findings: merged.slice(-MAX_CAMPAIGN_FINDINGS),
    scopes: snapshot.scopes,
  });
}

function sameFinding(left: CampaignFinding, right: CampaignFinding): boolean {
  if (left.relativePath === right.relativePath) return true;
  if (left.alsoFoundBy?.some((item) => item.relativePath === right.relativePath)) return true;
  const leftKey = findingTitleKey(left.title);
  const rightKey = findingTitleKey(right.title);
  return leftKey !== null && leftKey === rightKey;
}

function mergeFinding(previous: CampaignFinding, incoming: CampaignFinding): CampaignFinding {
  const samePath = previous.relativePath === incoming.relativePath;
  if (samePath) {
    return {
      ...incoming,
      prior: previous.prior === true && incoming.prior === true,
      providerId: incoming.providerId ?? previous.providerId,
      modelId: incoming.modelId ?? previous.modelId,
      ...(previous.alsoFoundBy ? { alsoFoundBy: previous.alsoFoundBy } : {}),
    };
  }
  const incomingRicher = incoming.summary.length > previous.summary.length;
  const primary = incomingRicher ? incoming : previous;
  const secondary = incomingRicher ? previous : incoming;
  return {
    ...primary,
    prior: previous.prior === true && incoming.prior === true,
    alsoFoundBy: mergeAlsoFound(primary, secondary),
  };
}

function mergeAlsoFound(primary: CampaignFinding, secondary: CampaignFinding): FindingAlsoFound[] {
  const items: FindingAlsoFound[] = [
    ...(primary.alsoFoundBy ?? []),
    ...(secondary.alsoFoundBy ?? []),
    {
      relativePath: secondary.relativePath,
      ...(secondary.providerId ? { providerId: secondary.providerId } : {}),
      ...(secondary.modelId ? { modelId: secondary.modelId } : {}),
    },
  ];
  const seen = new Set<string>();
  const unique: FindingAlsoFound[] = [];
  for (const item of items) {
    if (item.relativePath === primary.relativePath || seen.has(item.relativePath)) continue;
    seen.add(item.relativePath);
    unique.push(item);
  }
  return unique;
}

function findingTitleKey(title: string): string | null {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (normalized.length < MIN_TITLE_KEY) return null;
  return normalized;
}
