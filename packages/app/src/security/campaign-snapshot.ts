export const CAMPAIGN_WORKER_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "skipped-usage",
] as const;

export type CampaignWorkerState = (typeof CAMPAIGN_WORKER_STATES)[number];
export type CampaignPace = "quiet" | "steady" | "aggressive";

export interface CampaignFinding {
  path: string;
  relativePath: string;
  engagement?: string;
  host?: string;
  class?: string;
  title: string;
  summary: string;
  severity?: string;
}

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
  pace: CampaignPace;
}

const WORKER_STATE_SET = new Set<string>(CAMPAIGN_WORKER_STATES);

export function parseCampaignSnapshot(value: unknown): CampaignSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.workers) || typeof record.total !== "number") return null;
  const pace = parsePace(record.pace);
  const workers = record.workers.flatMap((entry) => {
    const worker = parseWorker(entry);
    return worker ? [worker] : [];
  });
  const findings = Array.isArray(record.findings)
    ? record.findings.flatMap((entry) => {
        const finding = parseFinding(entry);
        return finding ? [finding] : [];
      })
    : [];
  return {
    total: asCount(record.total, workers.length),
    queued: asCount(record.queued, countState(workers, "queued")),
    running: asCount(record.running, countState(workers, "running")),
    done: asCount(record.done, countState(workers, "completed")),
    skipped: asCount(record.skipped, countState(workers, "skipped-usage")),
    failed: asCount(record.failed, countState(workers, "failed")),
    findingsCount: asCount(record.findingsCount, findings.length),
    workers,
    findings,
    complete: record.complete === true,
    pace,
  };
}

function parsePace(value: unknown): CampaignPace {
  if (value === "steady" || value === "aggressive" || value === "quiet") return value;
  return "quiet";
}

function parseWorker(value: unknown): CampaignWorkerSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string" || typeof record.providerId !== "string") return null;
  if (typeof record.modelId !== "string" || typeof record.replica !== "number") return null;
  if (typeof record.state !== "string" || !WORKER_STATE_SET.has(record.state)) return null;
  return {
    key: record.key,
    providerId: record.providerId,
    modelId: record.modelId,
    replica: record.replica,
    state: record.state as CampaignWorkerState,
    findingsCount: asCount(record.findingsCount, 0),
    ...(typeof record.agentId === "string" ? { agentId: record.agentId } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

function parseFinding(value: unknown): CampaignFinding | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || typeof record.relativePath !== "string") return null;
  if (typeof record.title !== "string") return null;
  return {
    path: record.path,
    relativePath: record.relativePath,
    title: record.title,
    summary: typeof record.summary === "string" ? record.summary : "",
    ...(typeof record.engagement === "string" ? { engagement: record.engagement } : {}),
    ...(typeof record.host === "string" ? { host: record.host } : {}),
    ...(typeof record.class === "string" ? { class: record.class } : {}),
    ...(typeof record.severity === "string" ? { severity: record.severity } : {}),
  };
}

function asCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function countState(
  workers: readonly CampaignWorkerSnapshot[],
  state: CampaignWorkerState,
): number {
  return workers.filter((worker) => worker.state === state).length;
}
