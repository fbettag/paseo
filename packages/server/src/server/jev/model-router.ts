import { JevClient, type JevAnswers, noulAnswer } from "./client.js";

export const ROUTE_DEMAND_DEADBAND = 0.25;
export const ROUTE_JUDGMENT_TIMEOUT_MS = 3_500;

const ROUTE_KINDS = ["quick", "coding", "cyber_light", "cyber_heavy", "reasoning"] as const;

export type RouteKind = (typeof ROUTE_KINDS)[number];
export type ModelTier = "flash" | "standard" | "strong";
export type ModelSpecialty = "general" | "cyber";

export interface EnabledModel {
  providerId: string;
  providerLabel: string;
  modelId: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface ClassifiedModel extends EnabledModel {
  tier: ModelTier;
  specialty: ModelSpecialty;
  isDefault: boolean;
}

export type JevReasoningEffort = "auto" | "low" | "medium" | "high";

export interface RouteJudgment {
  kind: RouteKind;
  complexity: number;
  capability: number;
  deepReasoning: number;
  stakes?: number;
  correction?: number;
}

export interface RoutePin {
  providerId: string;
  modelId: string;
  tier: ModelTier;
  specialty: ModelSpecialty;
  demand: number;
}

export interface RouteDecision {
  providerId: string;
  providerLabel: string;
  modelId: string;
  label: string;
  tier: ModelTier;
  specialty: ModelSpecialty;
  kind: RouteKind;
  demand: number;
  kept: boolean;
  fallback: boolean;
}

export interface RouteModelsOptions {
  pin?: RoutePin | null;
  pressure?: number;
  blockedProviderIds?: ReadonlySet<string>;
  reasoningEffort?: JevReasoningEffort;
}

const CYBER_TOKENS = ["daybreak", "cyber", "cybersecurity"];
const FLASH_TOKENS = ["flash", "haiku", "mini", "nano", "highspeed", "luna"];
const STRONG_TOKENS = ["max", "opus", "astra", "sol", "fable", "ultra"];

const HEAVY_CYBER =
  /\b(exploit|payload|reverse[- ]engineering|privilege escalation|0-?day|malware|cve-\d|red team|offensive security)\b/i;
const LIGHT_CYBER = /\b(security|vulnerabilit(?:y|ies)|xss|csrf|pentest|cyber|cve)\b/i;

export function classifyEnabledModel(model: EnabledModel): ClassifiedModel {
  const haystack = `${model.modelId} ${model.label} ${model.description ?? ""}`;
  const specialty = hasToken(haystack, CYBER_TOKENS) ? "cyber" : "general";
  let tier: ModelTier = "standard";
  if (hasToken(haystack, FLASH_TOKENS)) {
    tier = "flash";
  } else if (hasToken(haystack, STRONG_TOKENS) || specialty === "cyber") {
    tier = "strong";
  }
  return {
    ...model,
    tier,
    specialty,
    isDefault: model.isDefault === true,
  };
}

export function demandOf(judgment: RouteJudgment): number {
  const base = 0.55 * clamp01(judgment.complexity) + 0.45 * clamp01(judgment.capability);
  if (clamp01(judgment.deepReasoning) >= 0.7) {
    return clamp01(base + 0.15);
  }
  return clamp01(base);
}

const CONTINUATION_CUE =
  /^(?:please\s+)?(?:continue|weiter|mach weiter|und weiter|go on|keep going|proceed)\b[.!?]*$/i;
const CORRECTION_CUE =
  /komplexit|nicht verstanden|nochmal|noch mal|schau genauer|bevor du|überleg|ueberleg|look again|did not understand|didn't understand|wrong approach/i;
const STAKES_CUE =
  /docker|kubernetes|\bk8s\b|deploy|migrate|migration|postgres|datenbank|database|restart|collector|kollektor|monitor|dropdb|production|löschen|delete|stoppen|starten/i;

export function isContinuationCue(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 48) return false;
  return CONTINUATION_CUE.test(trimmed);
}

// The newest line alone is the wrong task when the user says "continue".
// Earlier user lines are the work that step still belongs to.
export function routeTaskText(latest: string, recent: readonly string[]): string {
  const prior = recent
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(-6);
  if (prior.length === 0) return latest;
  const body = isContinuationCue(latest)
    ? prior.join("\n\n")
    : `${prior.slice(-3).join("\n\n")}\n\n${latest}`;
  return body.slice(0, 4_000);
}

export function readJevReasoningEffort(value: string | null | undefined): JevReasoningEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "auto") return value;
  return "auto";
}

export function heuristicRouteJudgment(prompt: string): RouteJudgment {
  const text = prompt.trim();
  const stakes = STAKES_CUE.test(text) ? 0.7 : 0;
  const correction = CORRECTION_CUE.test(text) ? 0.8 : 0;
  if (HEAVY_CYBER.test(text)) {
    return {
      kind: "cyber_heavy",
      complexity: 0.85,
      capability: 0.9,
      deepReasoning: 0.8,
      stakes,
      correction,
    };
  }
  if (LIGHT_CYBER.test(text)) {
    return {
      kind: "cyber_light",
      complexity: 0.45,
      capability: 0.5,
      deepReasoning: 0.3,
      stakes,
      correction,
    };
  }
  if (text.length < 80 && stakes < 0.5 && correction < 0.5) {
    return {
      kind: "quick",
      complexity: 0.15,
      capability: 0.15,
      deepReasoning: 0.1,
      stakes,
      correction,
    };
  }
  return {
    kind: "coding",
    complexity: 0.55,
    capability: 0.55,
    deepReasoning: 0.4,
    stakes,
    correction,
  };
}

export function prepareRouteJudgment(judgment: RouteJudgment): RouteJudgment {
  const stakes = clamp01(judgment.stakes ?? 0);
  const correction = clamp01(judgment.correction ?? 0);
  let kind = judgment.kind;
  let complexity = clamp01(judgment.complexity);
  let capability = clamp01(judgment.capability);
  let deepReasoning = clamp01(judgment.deepReasoning);
  if (stakes >= 0.5 && kind === "quick") kind = "coding";
  if (stakes >= 0.5) {
    complexity = Math.max(complexity, 0.55);
    capability = Math.max(capability, 0.55);
  }
  if (stakes >= 0.5 && correction >= 0.5 && kind !== "cyber_heavy" && kind !== "cyber_light") {
    kind = "reasoning";
    complexity = Math.max(complexity, 0.7);
    capability = Math.max(capability, 0.75);
    deepReasoning = Math.max(deepReasoning, 0.7);
  }
  return { kind, complexity, capability, deepReasoning, stakes, correction };
}

export function routeModels(
  models: readonly ClassifiedModel[],
  judgment: RouteJudgment,
  options?: RouteModelsOptions,
): RouteDecision | null {
  const available = modelsAcceptingWork(models, options?.blockedProviderIds);
  if (available.length === 0) return null;
  const prepared = prepareRouteJudgment(judgment);
  const demand = demandOf(prepared);
  const tier = applyReasoningEffort(
    targetTier(prepared.kind, demand, options?.pressure ?? 0),
    prepared.kind,
    options?.reasoningEffort ?? "auto",
  );
  const allowStepDown =
    prepared.kind === "quick" && (prepared.stakes ?? 0) < 0.4 && (prepared.correction ?? 0) < 0.4;
  const pool = eligibleModels(available, prepared.kind);
  const picked = pickOne(modelsAtTier(pool, tier));
  const pin = options?.pin;
  if (!pin) return toDecision(picked, prepared, demand, false, false);
  return routePinnedModel(available, pool, picked, prepared, demand, tier, allowStepDown, pin);
}

function routePinnedModel(
  available: readonly ClassifiedModel[],
  pool: readonly ClassifiedModel[],
  picked: ClassifiedModel,
  judgment: RouteJudgment,
  demand: number,
  tier: ModelTier,
  allowStepDown: boolean,
  pin: RoutePin,
): RouteDecision {
  const pinned = available.find(
    (model) => model.providerId === pin.providerId && model.modelId === pin.modelId,
  );
  if (!pinned) {
    return toDecision(picked, judgment, demand, false, picked.providerId !== pin.providerId);
  }

  const stepped = stepTier(tier, pinned.tier, allowStepDown);
  const onProvider = pool.filter((model) => model.providerId === pinned.providerId);
  const atTier = modelsAtExactTier(onProvider, stepped);
  if (atTier.length > 0) {
    return keepOrSwitch(pinned, pickOne(atTier), judgment, demand, pin.demand, stepped);
  }
  return upgradeFromPin(onProvider, picked, pinned, judgment, demand, stepped);
}

function keepOrSwitch(
  pinned: ClassifiedModel,
  next: ClassifiedModel,
  judgment: RouteJudgment,
  demand: number,
  pinDemand: number,
  stepped: ModelTier,
): RouteDecision {
  if (next.modelId === pinned.modelId) {
    return toDecision(pinned, judgment, demand, true, false);
  }
  if (pinned.tier === stepped && Math.abs(demand - pinDemand) < ROUTE_DEMAND_DEADBAND) {
    return toDecision(pinned, judgment, demand, true, false);
  }
  return toDecision(next, judgment, demand, false, false);
}

function upgradeFromPin(
  onProvider: readonly ClassifiedModel[],
  picked: ClassifiedModel,
  pinned: ClassifiedModel,
  judgment: RouteJudgment,
  demand: number,
  stepped: ModelTier,
): RouteDecision {
  if (tierRank(stepped) > tierRank(pinned.tier)) {
    const bestHere = strongest(onProvider);
    if (bestHere && tierRank(bestHere.tier) > tierRank(pinned.tier)) {
      return toDecision(bestHere, judgment, demand, false, false);
    }
    if (tierRank(picked.tier) > tierRank(pinned.tier)) {
      return toDecision(picked, judgment, demand, false, false);
    }
  }
  return toDecision(pinned, judgment, demand, true, false);
}

function modelsAcceptingWork(
  models: readonly ClassifiedModel[],
  blocked: ReadonlySet<string> | undefined,
): ClassifiedModel[] {
  if (!blocked || blocked.size === 0) return [...models];
  return models.filter((model) => !blocked.has(model.providerId));
}

export async function judgeRoutePrompt(
  client: JevClient,
  prompt: string,
): Promise<RouteJudgment | null> {
  const answers = await withTimeout(
    client.ask({
      state: { task: prompt.slice(0, 4_000) },
      questions: {
        task_kind: {
          type: "choice",
          instructions:
            "Which kind of work does the next step need? Earlier lines are the recent task. If the newest line only says to continue, judge that task.",
          criteria: {
            quick:
              "A local text edit or a factual question. Not an existing system, a previous session, or a running service.",
            coding: "Ordinary implementation, refactoring, or debugging.",
            cyber_light:
              "Security explanation, review, or a small fix that does not need a cybersecurity specialist.",
            cyber_heavy:
              "Vulnerability research, exploit analysis, or offensive security that needs a cybersecurity specialist.",
            reasoning: "Architecture, an ambiguous bug, or deep multi-step reasoning.",
          },
        },
        complexity: {
          type: "noul",
          instructions: "How complex is this task, from 0 for trivial to 1 for very hard?",
        },
        capability: {
          type: "noul",
          instructions:
            "How capable a model does this task deserve, from 0 for the cheapest to 1 for the strongest?",
        },
        deep_reasoning: {
          type: "noul",
          instructions:
            "Do the intermediate steps matter, from 0 for recall to 1 for deep reasoning?",
        },
        stakes: {
          type: "noul",
          instructions:
            "How costly is a wrong next step, from 0 for a local read to 1 for starting, stopping, migrating, or discarding a running system?",
        },
        correction: {
          type: "noul",
          instructions:
            "Is the newest line a correction of the previous approach, from 0 for a new request to 1 for rejecting what just happened?",
        },
      },
    }),
    ROUTE_JUDGMENT_TIMEOUT_MS,
  );
  return judgmentFromAnswers(answers);
}

export function pinFromDecision(decision: RouteDecision): RoutePin {
  return {
    providerId: decision.providerId,
    modelId: decision.modelId,
    tier: decision.tier,
    specialty: decision.specialty,
    demand: decision.demand,
  };
}

function judgmentFromAnswers(answers: JevAnswers): RouteJudgment | null {
  const answer = answers.task_kind;
  const choice = answer && "choice" in answer ? answer.choice : undefined;
  if (!isRouteKind(choice)) return null;
  return {
    kind: choice,
    complexity: readUnit(answers, "complexity"),
    capability: readUnit(answers, "capability"),
    deepReasoning: readUnit(answers, "deep_reasoning"),
    stakes: readOptionalUnit(answers, "stakes"),
    correction: readOptionalUnit(answers, "correction"),
  };
}

function readUnit(answers: JevAnswers, name: string): number {
  try {
    return clamp01(noulAnswer(answers, name));
  } catch {
    return 0.5;
  }
}

function readOptionalUnit(answers: JevAnswers, name: string): number {
  try {
    return clamp01(noulAnswer(answers, name));
  } catch {
    return 0;
  }
}

function isRouteKind(value: unknown): value is RouteKind {
  return typeof value === "string" && ROUTE_KINDS.some((kind) => kind === value);
}

function eligibleModels(models: readonly ClassifiedModel[], kind: RouteKind): ClassifiedModel[] {
  const cyber = models.filter((model) => model.specialty === "cyber");
  const general = models.filter((model) => model.specialty === "general");
  if (kind === "cyber_heavy" && cyber.length > 0) return cyber;
  if (general.length > 0) return general;
  return [...models];
}

function targetTier(kind: RouteKind, demand: number, pressure: number): ModelTier {
  let tier: ModelTier = "standard";
  if (kind === "quick") {
    tier = "flash";
  } else if (kind === "cyber_light") {
    tier = demand < 0.4 ? "flash" : "standard";
  } else if (kind === "cyber_heavy") {
    tier = "strong";
  } else if (kind === "reasoning") {
    tier = demand >= 0.55 ? "strong" : "standard";
  } else if (demand < 0.35) {
    tier = "flash";
  } else if (demand >= 0.72) {
    tier = "strong";
  }
  if (pressure < 0.7 || kind === "cyber_heavy") return tier;
  if (tier === "strong") return "standard";
  if (tier === "standard") return "flash";
  return tier;
}

function fallbackTiers(tier: ModelTier): ModelTier[] {
  if (tier === "flash") return ["standard", "strong"];
  if (tier === "strong") return ["standard", "flash"];
  return ["strong", "flash"];
}

function applyReasoningEffort(
  tier: ModelTier,
  kind: RouteKind,
  effort: JevReasoningEffort,
): ModelTier {
  if (kind === "cyber_heavy" || effort === "auto") return tier;
  if (effort === "low") return "flash";
  if (effort === "medium") return tier === "flash" ? "standard" : tier;
  return "strong";
}

function stepTier(target: ModelTier, pinned: ModelTier, allowStepDown: boolean): ModelTier {
  if (tierRank(target) >= tierRank(pinned)) return target;
  if (!allowStepDown) return pinned;
  if (pinned === "strong" && target === "flash") return "standard";
  return target;
}

function tierRank(tier: ModelTier): number {
  if (tier === "flash") return 0;
  if (tier === "standard") return 1;
  return 2;
}

function modelsAtExactTier(models: readonly ClassifiedModel[], tier: ModelTier): ClassifiedModel[] {
  return models.filter((model) => model.tier === tier);
}

function strongest(models: readonly ClassifiedModel[]): ClassifiedModel | null {
  const strong = modelsAtExactTier(models, "strong");
  if (strong.length > 0) return pickOne(strong);
  const standard = modelsAtExactTier(models, "standard");
  if (standard.length > 0) return pickOne(standard);
  const flash = modelsAtExactTier(models, "flash");
  if (flash.length > 0) return pickOne(flash);
  return null;
}

function modelsAtTier(models: readonly ClassifiedModel[], tier: ModelTier): ClassifiedModel[] {
  if (models.length === 0) return [];
  const exact = models.filter((model) => model.tier === tier);
  if (exact.length > 0) return exact;
  for (const fallback of fallbackTiers(tier)) {
    const found = models.filter((model) => model.tier === fallback);
    if (found.length > 0) return found;
  }
  return [...models];
}

function pickOne(models: readonly ClassifiedModel[]): ClassifiedModel {
  const sorted = [...models].sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    if (left.providerId !== right.providerId) return left.providerId < right.providerId ? -1 : 1;
    if (left.modelId !== right.modelId) return left.modelId < right.modelId ? -1 : 1;
    return 0;
  });
  const picked = sorted[0];
  if (!picked) {
    throw new Error("Jev route had no model to pick");
  }
  return picked;
}

function toDecision(
  model: ClassifiedModel,
  judgment: RouteJudgment,
  demand: number,
  kept: boolean,
  fallback: boolean,
): RouteDecision {
  return {
    providerId: model.providerId,
    providerLabel: model.providerLabel,
    modelId: model.modelId,
    label: model.label,
    tier: model.tier,
    specialty: model.specialty,
    kind: judgment.kind,
    demand,
    kept,
    fallback,
  };
}

function hasToken(haystack: string, words: readonly string[]): boolean {
  const pattern = new RegExp(`(?:^|[^a-z0-9])(?:${words.join("|")})(?=$|[^a-z0-9])`, "i");
  return pattern.test(haystack);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Jev route judgment timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
