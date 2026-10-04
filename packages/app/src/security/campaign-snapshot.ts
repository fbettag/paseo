export const CAMPAIGN_WORKER_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "skipped-usage",
] as const;

export type CampaignWorkerState = (typeof CAMPAIGN_WORKER_STATES)[number];
export type CampaignPace = "quiet" | "steady" | "aggressive";

export interface CampaignFindingAlso {
  relativePath: string;
  providerId?: string;
  modelId?: string;
}

export interface CampaignFinding {
  path: string;
  relativePath: string;
  engagement?: string;
  host?: string;
  class?: string;
  title: string;
  summary: string;
  severity?: string;
  providerId?: string;
  modelId?: string;
  chain?: string;
  prior?: boolean;
  alsoFoundBy?: CampaignFindingAlso[];
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
  scopes: string[];
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
    scopes: Array.isArray(record.scopes)
      ? record.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
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
    ...(typeof record.providerId === "string" ? { providerId: record.providerId } : {}),
    ...(typeof record.modelId === "string" ? { modelId: record.modelId } : {}),
    ...(typeof record.chain === "string" ? { chain: record.chain } : {}),
    ...(record.prior === true ? { prior: true } : {}),
    ...parseAlsoFound(record.alsoFoundBy),
  };
}

function parseAlsoFound(
  value: unknown,
): { alsoFoundBy: CampaignFindingAlso[] } | Record<string, never> {
  if (!Array.isArray(value)) return {};
  const alsoFoundBy: CampaignFindingAlso[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.relativePath !== "string") continue;
    alsoFoundBy.push({
      relativePath: record.relativePath,
      ...(typeof record.providerId === "string" ? { providerId: record.providerId } : {}),
      ...(typeof record.modelId === "string" ? { modelId: record.modelId } : {}),
    });
  }
  return alsoFoundBy.length > 0 ? { alsoFoundBy } : {};
}

export function campaignKeepsParentActive(value: unknown): boolean {
  const snapshot = parseCampaignSnapshot(value);
  if (!snapshot || snapshot.complete) return false;
  return snapshot.queued + snapshot.running > 0;
}

export function selectCampaignFindings(
  snapshot: CampaignSnapshot,
  options: { title?: string | null; query?: string; includePrior?: boolean },
): CampaignFinding[] {
  const unique = collapseFindings(snapshot.findings);
  const scoped =
    snapshot.scopes.length > 0
      ? unique.filter((finding) => pathMatchesScope(finding.relativePath, snapshot.scopes))
      : findingsForTitle(unique, options.title);
  const query = options.query?.trim().toLowerCase() ?? "";
  return scoped
    .filter((finding) => options.includePrior === true || finding.prior !== true)
    .filter((finding) => findingMatchesQuery(finding, query))
    .toReversed();
}

const MIN_TITLE_KEY = 12;

function collapseFindings(findings: readonly CampaignFinding[]): CampaignFinding[] {
  const collapsed: CampaignFinding[] = [];
  for (const finding of findings) {
    const index = collapsed.findIndex((existing) => sameDisplayedFinding(existing, finding));
    if (index < 0) {
      collapsed.push(finding);
      continue;
    }
    const previous = collapsed[index];
    if (!previous) continue;
    collapsed[index] = mergeDisplayedFinding(previous, finding);
  }
  return collapsed;
}

function sameDisplayedFinding(left: CampaignFinding, right: CampaignFinding): boolean {
  if (left.relativePath === right.relativePath) return true;
  const leftKey = titleKey(left.title);
  const rightKey = titleKey(right.title);
  return leftKey !== null && leftKey === rightKey;
}

function mergeDisplayedFinding(
  previous: CampaignFinding,
  incoming: CampaignFinding,
): CampaignFinding {
  if (previous.relativePath === incoming.relativePath) {
    return {
      ...incoming,
      ...(previous.alsoFoundBy && !incoming.alsoFoundBy
        ? { alsoFoundBy: previous.alsoFoundBy }
        : {}),
    };
  }
  const incomingRicher = incoming.summary.length > previous.summary.length;
  const primary = incomingRicher ? incoming : previous;
  const secondary = incomingRicher ? previous : incoming;
  return {
    ...primary,
    alsoFoundBy: mergeDisplayedAlso(primary, secondary),
  };
}

function mergeDisplayedAlso(
  primary: CampaignFinding,
  secondary: CampaignFinding,
): CampaignFindingAlso[] {
  const items: CampaignFindingAlso[] = [
    ...(primary.alsoFoundBy ?? []),
    ...(secondary.alsoFoundBy ?? []),
    {
      relativePath: secondary.relativePath,
      ...(secondary.providerId ? { providerId: secondary.providerId } : {}),
      ...(secondary.modelId ? { modelId: secondary.modelId } : {}),
    },
  ];
  const seen = new Set<string>();
  const unique: CampaignFindingAlso[] = [];
  for (const item of items) {
    if (item.relativePath === primary.relativePath || seen.has(item.relativePath)) continue;
    seen.add(item.relativePath);
    unique.push(item);
  }
  return unique;
}

function titleKey(title: string): string | null {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (normalized.length < MIN_TITLE_KEY) return null;
  return normalized;
}

function pathMatchesScope(relativePath: string, scopes: readonly string[]): boolean {
  return scopes.some(
    (scope) => relativePath === scope.replace(/\/$/, "") || relativePath.startsWith(scope),
  );
}

function findingsForTitle(
  findings: readonly CampaignFinding[],
  title: string | null | undefined,
): CampaignFinding[] {
  const tokens = new Set(
    (title ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4),
  );
  if (tokens.size === 0) return [...findings];
  const matched = findings.filter((finding) => tokens.has(targetName(finding.relativePath)));
  return matched.length > 0 ? matched : [...findings];
}

function targetName(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  const name = parts[0] === "engagements" ? parts[1] : parts[0];
  return name?.toLowerCase() ?? "";
}

function findingMatchesQuery(finding: CampaignFinding, query: string): boolean {
  if (query.length === 0) return true;
  const model = [finding.providerId, finding.modelId].filter(Boolean).join("/");
  return [finding.title, finding.summary, finding.chain, model, finding.relativePath]
    .join("\n")
    .toLowerCase()
    .includes(query);
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
