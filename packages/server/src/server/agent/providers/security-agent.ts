import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentCreateSessionOptions,
  AgentFeature,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentResumeSessionOptions,
  AgentRunOptions,
  AgentRunResult,
  AgentSelectOption,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  FetchCatalogOptions,
  ProviderCatalog,
  ProviderRefreshContext,
  SteerActiveTurnOptions,
  SteerResult,
} from "../agent-sdk-types.js";
import type { AgentMetadata } from "@getpaseo/protocol/agent-types";
import { mapJevPermissionMode } from "../../jev/permission-mode.js";
import type { EnabledModel } from "../../jev/model-router.js";
import { isSystemInjectedEnvelope } from "../agent-prompt.js";
import type { ChildAgentHandle, JevRouterPorts } from "./jev-agent.js";
import { JEV_PROVIDER_ID } from "./jev-agent.js";
import {
  defaultClock,
  expandSlots,
  modelRefKey,
  parseModelRef,
  roundRobinByProvider,
  runCampaign,
  type CampaignItem,
  type CampaignReport,
  type ModelRef,
} from "../../security/campaign.js";
import { classifyOrcaUsageSkip, UsageSkipError } from "../../security/usage-error.js";
import {
  boardBuilderPrompt,
  boardEntryLines,
  boardLooksWritten,
  boardPathFor,
  findingBoardStatus,
  formatBoardEntry,
  renderFindingBoard,
  type FindingBoardEntry,
} from "../../security/finding-board.js";
import { ledgerLines, ledgerPathFor, renderFindingLedger } from "../../security/finding-ledger.js";
import {
  FINDINGS_WATCH_MS,
  listFindingFiles,
  resolveFindingScopes,
  summarizeFindingFile,
  type FindingCard,
} from "../../security/findings.js";
import { campaignRunsLive } from "../../security/live-target.js";
import { listSearchSlices, partitionSearchPaths } from "../../security/search-split.js";
import {
  clampParallel,
  parsePace,
  parseParallel,
  parseSecurityParams,
  parseSlotsFeatureValue,
  resolveSessionSchedule,
  resolveSessionSlots,
  scheduleFromPace,
  scheduleFromParallel,
  SECURITY_PACE_FEATURE_ID,
  SECURITY_PARALLEL_FEATURE_ID,
  SECURITY_SLOTS_FEATURE_ID,
  workerLimit,
  type ResolvedSecurityParams,
  type ResolvedSecuritySchedule,
  type SecurityPace,
  type SecuritySlot,
} from "../../security/settings.js";
import {
  appendCampaignFindings,
  createCampaignSnapshot,
  patchCampaignWorker,
  tallyCampaign,
  type CampaignSnapshot,
  type CampaignWorkerSnapshot,
  type CampaignWorkerState,
} from "../../security/snapshot.js";

export const SECURITY_PROVIDER_ID = "security";

export const SECURITY_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V6l7-3z"/><path d="M9.5 12.5l1.8 1.8L15.5 10"/></svg>';

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

const SECURITY_MODES: AgentMode[] = [
  {
    id: "bypass",
    label: "Bypass",
    description: "Skip permission prompts on the manager and the worker fleet.",
  },
];

const MANAGER_SYSTEM_PROMPT = [
  "You are the Security campaign manager.",
  "Read the operator's campaign goal and the engagement before any worker starts.",
  "This turn is the worker brief.",
  "Put only the worker assignment between :::worker-brief and :::.",
  "Status updates, reconnaissance, and notes to the operator stay outside that block. Workers never see them.",
  "The worker fleet is owned by this provider and starts after this turn, using that assignment.",
  "Workers appear as native Paseo subagents of this session.",
  "Do not call create_agent for that fleet.",
  "Do not claim workers are idle or missing while this session is open; fleet status arrives as Security notices and as subagent activity.",
  "Later operator messages are forwarded to the live fleet.",
  "Plan, read evidence, and brief the operator.",
  "A fresh session builds the finding board once, in a subagent, from the current findings.",
  "Read that board file only. Do not open the finding files into this chat.",
  "Source-audit workers each receive a random disjoint slice of the target tree and a ledger of findings already filed.",
  "Do not paste that board, that ledger, or those slices into the operator status.",
  "Severity decisions and report submission stay with the human.",
].join(" ");

const WORKER_SYSTEM_PROMPT = [
  "You are a Security campaign worker.",
  "Follow AGENTS.md in this workspace.",
  "Do not spawn further agents. The fleet is provider-owned.",
  "Do not edit application source.",
  "Do not write findings for any other target.",
].join(" ");

export function isWrapperProvider(providerId: string): boolean {
  return providerId === JEV_PROVIDER_ID || providerId === SECURITY_PROVIDER_ID;
}

export class SecurityAgentClient {
  readonly provider: AgentProvider = SECURITY_PROVIDER_ID;
  readonly capabilities = CAPABILITIES;

  constructor(
    private readonly logger: Logger,
    private readonly ports: JevRouterPorts | undefined,
    providerParams?: unknown,
  ) {
    this.params = parseSecurityParams(providerParams);
  }

  private readonly params: ResolvedSecurityParams;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async fetchCatalog(
    options: FetchCatalogOptions,
    _context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    const cwd = options.scope === "workspace" ? options.cwd : undefined;
    const candidates = await this.readCandidates(cwd);
    const models: AgentModelDefinition[] = candidates.map((candidate, index) => ({
      provider: SECURITY_PROVIDER_ID,
      id: modelRefKey(candidate),
      label: `${candidate.providerLabel} · ${candidate.label}`,
      description: candidate.description,
      isDefault: index === 0,
    }));
    return {
      models,
      modes: SECURITY_MODES,
      defaultModeId: "bypass",
    };
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    return {
      diagnostic:
        "Security runs a bypass campaign manager plus a worker fleet over enabled Paseo models.",
    };
  }

  async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
    const candidates = await this.readCandidates(config.cwd);
    const slots = launchSlots(
      config.featureValues,
      this.params.slots,
      optionIdSet(slotOptions(candidates)),
    );
    const schedule = resolveSessionSchedule(config.featureValues, this.params, slots);
    return [
      buildSlotsFeature(slots, slotOptions(candidates)),
      buildParallelFeature(schedule.maxParallel, workerLimit(slots)),
    ];
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const candidates = await this.readCandidates(config.cwd);
    const session = new SecurityAgentSession(
      this.logger,
      this.ports,
      this.params,
      config,
      slotOptions(candidates),
      launchContext,
      options,
    );
    session.armFreshBoard();
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    const ports = this.requirePorts();
    const routed = readManagerHandle(handle.metadata);
    if (!routed) {
      throw new Error("Security session is missing its manager provider");
    }
    const cwd = overrides?.cwd ?? readCwd(routed.handle.metadata);
    const providerModes = await readProviderModes(this.logger, ports, cwd);
    const inner = await ports.resumeSession(
      routed.providerId,
      providerHandleForResume(routed.handle),
      innerResumeOverrides(cwd, providerModes[routed.providerId] ?? []),
      launchContext,
      options,
    );
    const candidates = await this.readCandidates(cwd);
    const resumedFeatureValues: Record<string, unknown> = {
      ...overrides?.featureValues,
    };
    if (routed.slots !== null) {
      resumedFeatureValues[SECURITY_SLOTS_FEATURE_ID] = routed.slots;
    }
    if (routed.parallel !== null) {
      resumedFeatureValues[SECURITY_PARALLEL_FEATURE_ID] = routed.parallel;
    } else {
      resumedFeatureValues[SECURITY_PACE_FEATURE_ID] = routed.pace ?? this.params.pace;
    }
    const session = new SecurityAgentSession(
      this.logger,
      ports,
      this.params,
      {
        ...overrides,
        provider: SECURITY_PROVIDER_ID,
        cwd,
        model: modelRefKey(routed.manager),
        featureValues: resumedFeatureValues,
      },
      slotOptions(candidates),
      launchContext,
    );
    session.useProviderModes(providerModes);
    session.adopt(inner, routed.manager, routed.campaignComplete);
    return session;
  }

  private async readCandidates(cwd?: string): Promise<EnabledModel[]> {
    if (!this.ports) return [];
    const candidates = await this.ports.listCandidates(cwd);
    return candidates.filter((candidate) => !isWrapperProvider(candidate.providerId));
  }

  private requirePorts(): JevRouterPorts {
    if (!this.ports) {
      throw new Error("Security routing is not connected to the daemon");
    }
    return this.ports;
  }
}

class SecurityAgentSession implements AgentSession {
  readonly provider: AgentProvider = SECURITY_PROVIDER_ID;
  readonly capabilities = CAPABILITIES;
  private inner: AgentSession | null = null;
  private manager: (ModelRef & { label: string; providerLabel: string }) | null = null;
  private providerModes: Readonly<Record<string, { id: string }[]>> = {};
  private fleetRunning = false;
  private campaignComplete = false;
  private unsubscribeInner: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private readonly liveWorkers = new Map<string, ChildAgentHandle>();
  private fleetAbort = new AbortController();
  private lastLiveWorkerKey: string | null = null;
  private campaign: CampaignSnapshot | null = null;
  private slots: SecuritySlot[];
  private schedule: ResolvedSecuritySchedule;
  private pendingFleetGoal: string | null = null;
  private readonly briefChunks = new Map<string, string>();
  private briefOrder: string[] = [];
  private operatorGoal = "";
  private workerGoal = "";
  private findingScopes: string[] = [];
  private readonly findingSeen = new Set<string>();
  private readonly findingCounts = new Map<string, number>();
  private findingRefresh: Promise<void> = Promise.resolve();
  private liveCampaign = false;
  private searchSlices = new Map<string, string[]>();
  private ledgerFile: string | null = null;
  private boardArmed = false;
  private boardBuilt = false;
  private boardFile: string | null = null;
  private boardLines: string[] = [];
  private boardAbort = new AbortController();

  constructor(
    private readonly logger: Logger,
    private readonly ports: JevRouterPorts | undefined,
    private readonly params: ResolvedSecurityParams,
    private readonly config: AgentSessionConfig,
    private readonly slotChoices: readonly AgentSelectOption[],
    private readonly launchContext?: AgentLaunchContext,
    private readonly createOptions?: AgentCreateSessionOptions,
  ) {
    this.slots = launchSlots(config.featureValues, params.slots, optionIdSet(slotChoices));
    this.schedule = resolveSessionSchedule(config.featureValues, params, this.slots);
  }

  get features(): AgentFeature[] {
    return [
      buildSlotsFeature(this.slots, this.slotChoices),
      buildParallelFeature(this.schedule.maxParallel, workerLimit(this.slots)),
    ];
  }

  get id(): string | null {
    return this.inner?.id ?? null;
  }

  adopt(
    inner: AgentSession,
    manager: ModelRef & { label: string; providerLabel: string },
    campaignComplete: boolean,
  ): void {
    this.bind(inner, manager);
    this.campaignComplete = campaignComplete;
    this.fleetRunning = false;
    if (!campaignComplete) {
      this.emitNoticeText("Security · resumed the manager. In-progress workers do not restart.");
    }
  }

  useProviderModes(modes: Readonly<Record<string, { id: string }[]>>): void {
    this.providerModes = modes;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return this.enqueue(() => this.runPrompt(prompt, options));
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    return this.enqueue(() => this.startPrompt(prompt, options));
  }

  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    this.noteCampaignPrompt(prompt);
    const inner = this.inner;
    if (!inner?.steerActiveTurn) return { status: "unavailable" };
    return inner.steerActiveTurn(prompt, options);
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    const inner = this.inner;
    if (!inner) return;
    for await (const event of inner.streamHistory()) {
      const tagged = this.retag(event);
      if (tagged) yield tagged;
    }
  }

  async getRuntimeInfo() {
    const inner = this.inner ? await this.inner.getRuntimeInfo() : null;
    return {
      provider: SECURITY_PROVIDER_ID,
      sessionId: inner?.sessionId ?? null,
      model: this.manager ? modelRefKey(this.manager) : (this.config.model ?? null),
      modeId: "bypass",
      extra: this.mergeExtra(inner?.extra),
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return SECURITY_MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return "bypass";
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    if (featureId === SECURITY_PARALLEL_FEATURE_ID) {
      const next = clampParallel(value, workerLimit(this.slots));
      this.schedule = scheduleFromParallel(next);
      this.config.featureValues = {
        ...this.config.featureValues,
        [SECURITY_PARALLEL_FEATURE_ID]: next,
      };
      return;
    }
    if (featureId === SECURITY_PACE_FEATURE_ID) {
      const pace = parsePace(value);
      if (!pace) {
        throw new Error(`Unknown Security pace '${String(value)}'`);
      }
      this.schedule = clampScheduleToSlots(scheduleFromPace(pace), this.slots);
      this.config.featureValues = {
        ...this.config.featureValues,
        [SECURITY_PACE_FEATURE_ID]: pace,
      };
      return;
    }
    if (featureId !== SECURITY_SLOTS_FEATURE_ID) {
      throw new Error(`Unknown Security feature '${featureId}'`);
    }
    const allowed = optionIdSet(this.slotChoices);
    this.slots = parseSlotsFeatureValue(value).filter((slot) => allowed.has(slot.model));
    const featureValues: Record<string, unknown> = {
      ...this.config.featureValues,
      [SECURITY_SLOTS_FEATURE_ID]: this.slots,
    };
    const limit = workerLimit(this.slots);
    if (this.schedule.maxParallel > limit) {
      this.schedule = scheduleFromParallel(limit);
      featureValues[SECURITY_PARALLEL_FEATURE_ID] = limit;
    }
    this.config.featureValues = featureValues;
  }

  async setMode(modeId: string): Promise<void> {
    if (modeId !== "bypass") {
      throw new Error(`Unknown Security mode '${modeId}'`);
    }
    const inner = this.inner;
    const providerId = this.manager?.providerId;
    if (!inner?.setMode || !providerId) return;
    const mapped = this.mappedMode(providerId);
    if (mapped) await inner.setMode(mapped);
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return this.inner?.getPendingPermissions() ?? [];
  }

  respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): ReturnType<AgentSession["respondToPermission"]> {
    const inner = this.inner;
    if (!inner) {
      throw new Error("Security session has not started");
    }
    return inner.respondToPermission(requestId, response);
  }

  describePersistence(): AgentPersistenceHandle | null {
    const inner = this.inner?.describePersistence();
    const manager = this.manager;
    if (!inner || !manager) return null;
    return {
      provider: SECURITY_PROVIDER_ID,
      sessionId: inner.sessionId,
      nativeHandle: inner.nativeHandle,
      metadata: {
        managerProvider: manager.providerId,
        managerModel: manager.modelId,
        managerLabel: manager.label,
        providerLabel: manager.providerLabel,
        campaignComplete: this.campaignComplete,
        slots: this.slots,
        parallel: this.schedule.maxParallel,
        pace: this.schedule.pace,
        inner,
      },
    };
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    const inner = this.inner;
    if (!inner?.listCommands) return [];
    return inner.listCommands();
  }

  tryHandleOutOfBand(
    prompt: AgentPromptInput,
  ): ReturnType<NonNullable<AgentSession["tryHandleOutOfBand"]>> | null {
    return this.inner?.tryHandleOutOfBand?.(prompt) ?? null;
  }

  armFreshBoard(): void {
    this.boardArmed = true;
  }

  async interrupt(): Promise<void> {
    this.boardAbort.abort();
    this.fleetAbort.abort();
    await Promise.allSettled([
      this.inner?.interrupt(),
      ...[...this.liveWorkers.values()].map((worker) => worker.interrupt()),
    ]);
  }

  async close(): Promise<void> {
    this.boardAbort.abort();
    this.fleetAbort.abort();
    this.unsubscribeInner?.();
    this.unsubscribeInner = null;
    await Promise.allSettled([
      this.inner?.close(),
      ...[...this.liveWorkers.values()].map((worker) => worker.interrupt()),
    ]);
    this.liveWorkers.clear();
  }

  private async runPrompt(
    prompt: AgentPromptInput,
    options: AgentRunOptions | undefined,
  ): Promise<AgentRunResult> {
    const inner = await this.ensureManager();
    this.noteCampaignPrompt(prompt);
    const noted = await this.ensureBoard(prompt);
    try {
      const result = await inner.run(noted, options);
      if (result.canceled) {
        this.pendingFleetGoal = null;
        this.resetBrief();
        return result;
      }
      this.releaseAfterRun(result.finalText);
      return result;
    } catch (error) {
      if (this.pendingFleetGoal !== null) this.releaseFleet(false);
      throw error;
    }
  }

  private async startPrompt(
    prompt: AgentPromptInput,
    options: AgentRunOptions | undefined,
  ): Promise<{ turnId: string }> {
    const inner = await this.ensureManager();
    this.noteCampaignPrompt(prompt);
    const noted = await this.ensureBoard(prompt);
    return inner.startTurn(noted, options);
  }

  private noteCampaignPrompt(prompt: AgentPromptInput): void {
    const text = promptText(prompt);
    if (!isCampaignGoal(text)) return;
    if (this.fleetRunning && this.liveWorkers.size > 0) {
      void this.forwardToFleet(text);
      return;
    }
    if (this.fleetRunning) return;
    if (this.pendingFleetGoal !== null) {
      this.pendingFleetGoal = `${this.pendingFleetGoal}\n${text}`;
      return;
    }
    this.pendingFleetGoal = text;
    this.resetBrief();
  }

  private releaseAfterRun(finalText: string): void {
    if (this.pendingFleetGoal === null) return;
    if (!this.currentBrief() && finalText.trim().length > 0) {
      this.noteAssistantText(undefined, finalText);
    }
    this.releaseFleet(true);
  }

  private observeManagerEvent(event: AgentStreamEvent): void {
    if (this.pendingFleetGoal === null) return;
    if (event.type === "timeline" && event.item.type === "assistant_message") {
      this.noteAssistantText(event.item.messageId, event.item.text);
      return;
    }
    if (event.type === "turn_completed") {
      this.releaseFleet(true);
      return;
    }
    if (event.type === "turn_failed") {
      this.releaseFleet(false);
      return;
    }
    if (event.type === "turn_canceled") {
      this.pendingFleetGoal = null;
      this.resetBrief();
    }
  }

  private releaseFleet(includeBrief: boolean): void {
    const goal = this.pendingFleetGoal;
    if (!goal || this.fleetRunning) return;
    const brief = includeBrief ? this.currentBrief() : null;
    this.pendingFleetGoal = null;
    this.resetBrief();
    this.startCampaign(goal, brief);
  }

  private noteAssistantText(messageId: string | undefined, text: string): void {
    const id = messageId ?? "";
    if (!this.briefChunks.has(id)) this.briefOrder.push(id);
    this.briefChunks.set(id, `${this.briefChunks.get(id) ?? ""}${text}`);
  }

  private currentBrief(): string | null {
    const parts: string[] = [];
    for (const id of this.briefOrder) {
      const chunk = this.briefChunks.get(id) ?? "";
      if (chunk.length > 0) parts.push(chunk);
    }
    const text = parts.join("\n").trim();
    return text.length > 0 ? text : null;
  }

  private resetBrief(): void {
    this.briefChunks.clear();
    this.briefOrder = [];
  }

  private startCampaign(goal: string, brief: string | null): void {
    this.fleetAbort = new AbortController();
    const signal = this.fleetAbort.signal;
    this.fleetRunning = true;
    this.campaignComplete = false;
    const assignment = extractWorkerBrief(brief);
    this.operatorGoal = goal;
    this.liveCampaign = campaignRunsLive(goal);
    this.workerGoal = assignment ? `${goal}\n\nWorker assignment:\n${assignment}` : goal;
    void this.runFleet(signal)
      .then((reports) => this.enqueue(() => this.synthesize(reports)))
      .catch((error) => {
        this.logger.warn({ err: error }, "Security campaign failed");
        this.emitNoticeText(
          `Security · fleet failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.fleetRunning = false;
      });
  }

  private async forwardToFleet(text: string): Promise<void> {
    const worker =
      (this.lastLiveWorkerKey ? this.liveWorkers.get(this.lastLiveWorkerKey) : undefined) ??
      [...this.liveWorkers.values()].at(-1);
    if (!worker) return;
    this.emitNoticeText("Security · forwarding follow-up to the latest live worker");
    try {
      await worker.prompt(text);
    } catch (error) {
      this.logger.warn({ err: error }, "Security follow-up was not delivered");
      this.emitNoticeText(
        `Security · follow-up was not delivered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async ensureManager(): Promise<AgentSession> {
    if (this.inner) return this.inner;
    const ports = this.requirePorts();
    this.providerModes = (await ports.listProviderModes?.(this.config.cwd)) ?? this.providerModes;
    const candidates = (await ports.listCandidates(this.config.cwd)).filter(
      (candidate) => !isWrapperProvider(candidate.providerId),
    );
    const manager = resolveManager(this.config.model, candidates);
    const inner = await ports.openSession(
      manager.providerId,
      {
        ...this.config,
        provider: manager.providerId,
        model: manager.modelId,
        modeId: this.mappedMode(manager.providerId),
        thinkingOptionId: undefined,
        featureValues: undefined,
        systemPrompt: joinPrompts(this.config.systemPrompt, MANAGER_SYSTEM_PROMPT),
      },
      this.launchContext,
      this.createOptions,
    );
    this.bind(inner, manager);
    this.emitNoticeText(`Security · manager ${manager.providerLabel} · ${manager.label}`);
    return inner;
  }

  private async runFleet(fleetSignal: AbortSignal): Promise<CampaignReport[]> {
    const ports = this.requirePorts();
    const manager = this.manager;
    const schedule = this.schedule;
    const items = expandSlots(this.slots, manager);
    this.findingScopes = await this.resolveFindingScopes(
      [this.config.title, this.operatorGoal].filter((part) => part && part.length > 0).join("\n"),
    );
    this.findingSeen.clear();
    this.findingCounts.clear();
    this.searchSlices = new Map();
    const agentId = this.launchContext?.agentId;
    this.ledgerFile = agentId ? ledgerPathFor(this.config.cwd, agentId) : null;
    const maxParallel = this.liveCampaign ? 1 : schedule.maxParallel;
    const staggerMs = this.liveCampaign ? 0 : schedule.staggerMs;
    this.campaign = createCampaignSnapshot(items, schedule.pace, this.findingScopes);
    await this.assignSearchSlices(items);
    await this.rememberPriorFindings();
    this.emitCampaign();
    this.emitNoticeText(
      this.liveCampaign
        ? `Security · fleet ${items.length} workers, one at a time`
        : `Security · fleet ${items.length} workers, parallel ${maxParallel}`,
    );
    if (items.length === 0) {
      this.campaignComplete = true;
      this.campaign = tallyCampaign({ ...this.campaign, complete: true });
      this.emitCampaign();
      return [];
    }
    const reports = await runCampaign({
      slots: this.slots,
      fallback: manager,
      maxParallel,
      staggerMs,
      usageWaitMs: this.params.usageWaitMs,
      usagePollMs: this.params.usagePollMs,
      goal: this.workerGoal,
      workerPrompt: (item) => this.promptForWorker(item),
      signal: fleetSignal,
      ports: {
        blockedProviders: () => ports.blockedProviders(),
        runWorker: (item, prompt, signal) => this.runWorker(item, prompt, signal),
        orderItems: roundRobinByProvider,
        clock: defaultClock(),
      },
      onStart: (item) => {
        this.patchWorker(item.key, { state: "running" });
      },
      onReport: async (report) => {
        this.patchWorker(report.key, {
          state: reportStatusState(report.status),
          findingsCount: report.findingsCount,
          error: report.error,
        });
        if (report.status === "skipped-usage") {
          this.emitNoticeText(
            workerNotice(report, "skipped-usage", report.findingsCount, report.error),
          );
        }
        if (!this.liveCampaign || report.status !== "completed") return;
        const next = await this.nextWorkerAssignment(report);
        if (next) this.workerGoal = `${this.operatorGoal}\n\nWorker assignment:\n${next}`;
      },
    });
    if (this.campaign) {
      this.campaign = tallyCampaign({ ...this.campaign, complete: true });
      this.emitCampaign();
    }
    return reports;
  }

  private async runWorker(
    item: CampaignItem,
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ text: string; findingsCount: number }> {
    const ports = this.requirePorts();
    if (signal.aborted) throw new Error("aborted");
    const parentAgentId = this.launchContext?.agentId;
    if (!ports.createChildAgent) {
      throw new Error("Security child agent spawn is not connected to the daemon");
    }
    if (!parentAgentId) {
      throw new Error("Security campaign workers need a parent Paseo agent");
    }
    this.emitNoticeText(workerNotice(item, "started", 0));
    const worker = await ports.createChildAgent({
      callerAgentId: parentAgentId,
      provider: modelRefKey(item),
      title: `Security · ${item.providerId}/${item.modelId} #${item.replica}`,
      initialPrompt: prompt,
      cwd: this.config.cwd,
      mode: this.mappedMode(item.providerId),
      systemPrompt: joinPrompts(this.config.systemPrompt, WORKER_SYSTEM_PROMPT),
    });
    this.liveWorkers.set(item.key, worker);
    this.lastLiveWorkerKey = item.key;
    this.patchWorker(item.key, { agentId: worker.agentId });
    const watch = this.watchFindings(item, signal);
    try {
      const result = await worker.waitForFinish(signal);
      await this.refreshFindings(item);
      const findingsCount = this.findingCounts.get(item.key) ?? 0;
      this.emitNoticeText(workerNotice(item, "completed", findingsCount));
      return { text: result.text, findingsCount };
    } catch (error) {
      const skip = classifyOrcaUsageSkip(error);
      if (skip) throw new UsageSkipError(skip);
      const message = error instanceof Error ? error.message : String(error);
      this.emitNoticeText(workerNotice(item, "failed", 0, message));
      throw error;
    } finally {
      watch.stop();
      this.liveWorkers.delete(item.key);
      if (this.lastLiveWorkerKey === item.key) {
        this.lastLiveWorkerKey = [...this.liveWorkers.keys()].at(-1) ?? null;
      }
    }
  }

  private async synthesize(reports: CampaignReport[]): Promise<void> {
    this.campaignComplete = true;
    if (this.fleetAbort.signal.aborted) return;
    const inner = this.inner;
    if (!inner || reports.length === 0) return;
    await inner.run(synthesisPrompt(reports));
  }

  private mappedMode(providerId: string): string | undefined {
    return mapJevPermissionMode("bypass", this.providerModes[providerId] ?? []);
  }

  private bind(
    inner: AgentSession,
    manager: ModelRef & { label: string; providerLabel: string },
  ): void {
    this.unsubscribeInner?.();
    this.inner = inner;
    this.manager = manager;
    this.unsubscribeInner = inner.subscribe((event) => {
      this.observeManagerEvent(event);
      const tagged = this.retag(event);
      if (tagged) this.emit(tagged);
    });
    const handle = this.describePersistence();
    if (handle?.sessionId) {
      this.emit({
        type: "thread_started",
        sessionId: handle.sessionId,
        provider: SECURITY_PROVIDER_ID,
      });
    }
  }

  private emitNoticeText(message: string): void {
    this.emit({
      type: "timeline",
      provider: SECURITY_PROVIDER_ID,
      item: { type: "notification", level: "info", message },
    });
  }

  private patchWorker(key: string, patch: Partial<CampaignWorkerSnapshot>): void {
    if (!this.campaign) return;
    this.campaign = patchCampaignWorker(this.campaign, key, patch);
    this.emitCampaign();
  }

  private emitCampaign(): void {
    if (!this.campaign) return;
    this.emit({
      type: "model_changed",
      provider: SECURITY_PROVIDER_ID,
      runtimeInfo: {
        provider: SECURITY_PROVIDER_ID,
        sessionId: this.inner?.id ?? null,
        model: this.manager ? modelRefKey(this.manager) : (this.config.model ?? null),
        modeId: "bypass",
        extra: this.runtimeExtra(),
      },
    });
  }

  private watchFindings(item: CampaignItem, signal: AbortSignal): { stop(): void } {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onParentAbort, { once: true });
    const tick = async () => {
      while (!controller.signal.aborted) {
        await this.refreshFindings(item);
        try {
          await defaultClock().sleep(FINDINGS_WATCH_MS, controller.signal);
        } catch {
          break;
        }
      }
      signal.removeEventListener("abort", onParentAbort);
    };
    void tick();
    return {
      stop() {
        controller.abort();
      },
    };
  }

  private async refreshFindings(item?: CampaignItem): Promise<void> {
    const run = this.findingRefresh.then(() => this.refreshFindingsLocked(item));
    this.findingRefresh = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private async refreshFindingsLocked(item?: CampaignItem): Promise<void> {
    const files = await listFindingFiles(this.config.cwd, { scopes: this.findingScopes });
    const fresh = files.filter((path) => !this.findingSeen.has(path));
    for (const path of fresh) this.findingSeen.add(path);
    if (fresh.length === 0 || !this.campaign) return;
    const added: FindingCard[] = [];
    for (const path of fresh) {
      const card = await summarizeFindingFile(path, this.config.cwd);
      if (item) {
        card.providerId = item.providerId;
        card.modelId = item.modelId;
      }
      added.push(card);
    }
    const before = this.campaign.findings.length;
    this.campaign = appendCampaignFindings(this.campaign, added);
    const uniqueAdded = Math.max(0, this.campaign.findings.length - before);
    if (item && uniqueAdded > 0) {
      this.findingCounts.set(item.key, (this.findingCounts.get(item.key) ?? 0) + uniqueAdded);
    }
    await this.writeLedger();
    this.emitCampaign();
  }

  private async rememberPriorFindings(): Promise<void> {
    const files = await listFindingFiles(this.config.cwd, { scopes: this.findingScopes });
    const prior: FindingCard[] = [];
    for (const path of files) {
      this.findingSeen.add(path);
      const card = await summarizeFindingFile(path, this.config.cwd);
      card.prior = true;
      prior.push(card);
    }
    if (prior.length > 0 && this.campaign) {
      this.campaign = appendCampaignFindings(this.campaign, prior);
    }
    await this.writeLedger();
  }

  private async assignSearchSlices(items: readonly CampaignItem[]): Promise<void> {
    this.searchSlices = new Map();
    if (this.liveCampaign || items.length < 2) return;
    const slices = await listSearchSlices(this.config.cwd, this.findingScopes, items.length);
    const buckets = partitionSearchPaths(slices, items.length);
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const bucket = buckets[index];
      if (item && bucket && bucket.length > 0) this.searchSlices.set(item.key, bucket);
    }
    if (this.searchSlices.size === 0) return;
    let assigned = 0;
    for (const bucket of this.searchSlices.values()) assigned += bucket.length;
    this.emitNoticeText(
      `Security · search split ${assigned} paths across ${this.searchSlices.size} workers`,
    );
  }

  private promptForWorker(item: CampaignItem): string {
    return workerPrompt(item, this.workerGoal, this.findingScopes, {
      slice: this.searchSlices.get(item.key) ?? [],
      filed: ledgerLines(this.campaign?.findings ?? []),
      ledgerPath: this.ledgerFile,
      boardPath: this.boardFile,
      boardLines: this.boardLines,
    });
  }

  private async ensureBoard(prompt: AgentPromptInput): Promise<AgentPromptInput> {
    if (!this.boardArmed || this.boardBuilt) return prompt;
    const text = promptText(prompt);
    if (!isCampaignGoal(text)) return prompt;
    this.boardBuilt = true;
    const agentId = this.launchContext?.agentId;
    if (!agentId) return prompt;
    this.boardFile = boardPathFor(this.config.cwd, agentId);
    const scopes = await this.resolveFindingScopes(
      [this.config.title, text].filter((part) => part && part.length > 0).join("\n"),
    );
    const files = await listFindingFiles(this.config.cwd, { scopes });
    if (files.length > 0) await this.runBoardBuilder(scopes, files);
    await this.keepBoardOrFallback(files);
    this.emitNoticeText(`Security · finding board lists ${files.length} current findings`);
    return withBoardNote(prompt, this.boardFile);
  }

  private async runBoardBuilder(
    scopes: readonly string[],
    files: readonly string[],
  ): Promise<void> {
    const ports = this.ports;
    const manager = this.manager;
    const boardFile = this.boardFile;
    const parentAgentId = this.launchContext?.agentId;
    if (!ports?.createChildAgent || !manager || !boardFile || !parentAgentId) return;
    this.emitNoticeText("Security · building the finding board once");
    try {
      const worker = await ports.createChildAgent({
        callerAgentId: parentAgentId,
        provider: modelRefKey(manager),
        title: "security board",
        cwd: this.config.cwd,
        mode: this.mappedMode(manager.providerId),
        systemPrompt: BOARD_SYSTEM_PROMPT,
        initialPrompt: boardBuilderPrompt({
          boardPath: boardFile,
          scopes,
          files: files.map((file) => relative(this.config.cwd, file)),
        }),
      });
      await worker.waitForFinish(this.boardAbort.signal);
    } catch (error) {
      this.logger.warn({ err: error }, "Security board subagent did not finish");
    }
  }

  private async keepBoardOrFallback(files: readonly string[]): Promise<void> {
    const existing = await readOptional(this.boardFile);
    if (existing && boardLooksWritten(existing)) {
      this.boardLines = boardEntryLines(existing);
      return;
    }
    const entries: FindingBoardEntry[] = [];
    for (const file of files) {
      entries.push(await boardEntryFromFile(file, this.config.cwd));
    }
    await this.writeBoard(renderFindingBoard(entries));
    this.boardLines = entries.slice(0, 40).map((entry) => formatBoardEntry(entry));
  }

  private async writeBoard(content: string): Promise<void> {
    const path = this.boardFile;
    if (!path) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    } catch (error) {
      this.logger.warn({ err: error }, "Security could not write the finding board");
    }
  }

  private async writeLedger(): Promise<void> {
    const path = this.ledgerFile;
    if (!path) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, renderFindingLedger(this.campaign?.findings ?? []), "utf8");
    } catch (error) {
      this.logger.warn({ err: error }, "Security could not write the finding ledger");
    }
  }

  private async resolveFindingScopes(text: string): Promise<string[]> {
    let topLevel: string[] = [];
    let engagements: string[] = [];
    try {
      const entries = await readdir(this.config.cwd, { withFileTypes: true });
      topLevel = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      const engagementDir = entries.find(
        (entry) => entry.isDirectory() && entry.name === "engagements",
      );
      if (engagementDir) {
        const children = await readdir(`${this.config.cwd}/engagements`, { withFileTypes: true });
        engagements = children.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      }
    } catch {
      return [];
    }
    return resolveFindingScopes({ topLevel, engagements, text });
  }

  private async nextWorkerAssignment(report: CampaignReport): Promise<string | null> {
    const inner = this.inner;
    if (!inner) return null;
    try {
      const result = await inner.run(
        [
          `Previous worker ${report.providerId}/${report.modelId} #${report.replica} finished.`,
          "Result:",
          (report.text ?? "").slice(0, 4000),
          "Write only the next worker assignment between :::worker-brief and :::. Do not add status for the operator.",
        ].join("\n"),
      );
      return extractWorkerBrief(result.finalText);
    } catch (error) {
      this.logger.warn({ err: error }, "Security could not prepare the next worker assignment");
      return null;
    }
  }

  private mergeExtra(inner?: AgentMetadata): AgentMetadata {
    return {
      ...inner,
      ...this.runtimeExtra(),
    };
  }

  private runtimeExtra(): AgentMetadata {
    const extra: AgentMetadata = {};
    if (this.manager) {
      extra.managerProvider = this.manager.providerId;
      extra.managerModel = this.manager.modelId;
      extra.managerLabel = this.manager.label;
      extra.campaignComplete = this.campaignComplete;
    }
    if (this.campaign) extra.campaign = this.campaign;
    return extra;
  }

  private retag(event: AgentStreamEvent): AgentStreamEvent | null {
    if (event.type === "mode_changed") return null;
    if (event.type === "model_changed") {
      return {
        ...event,
        provider: SECURITY_PROVIDER_ID,
        runtimeInfo: {
          ...event.runtimeInfo,
          provider: SECURITY_PROVIDER_ID,
          extra: this.mergeExtra(event.runtimeInfo.extra),
        },
      };
    }
    return { ...event, provider: SECURITY_PROVIDER_ID };
  }

  private emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private requirePorts(): JevRouterPorts {
    if (!this.ports) {
      throw new Error("Security routing is not connected to the daemon");
    }
    return this.ports;
  }
}

function optionIdSet(options: readonly AgentSelectOption[]): ReadonlySet<string> {
  return new Set(options.map((option) => option.id));
}

function launchSlots(
  featureValues: Record<string, unknown> | undefined,
  fallback: readonly SecuritySlot[],
  optionIds: ReadonlySet<string>,
): SecuritySlot[] {
  const slots = resolveSessionSlots(featureValues, fallback);
  if (
    !featureValues ||
    !Object.prototype.hasOwnProperty.call(featureValues, SECURITY_SLOTS_FEATURE_ID)
  ) {
    return slots;
  }
  return slots.filter((slot) => optionIds.has(slot.model));
}

function slotOptions(candidates: readonly EnabledModel[]): AgentSelectOption[] {
  return candidates.map((candidate) => {
    const option: AgentSelectOption = {
      id: modelRefKey(candidate),
      label: `${candidate.providerLabel} · ${candidate.label}`,
    };
    if (candidate.description) {
      option.description = candidate.description;
    }
    return option;
  });
}

function buildSlotsFeature(
  value: readonly SecuritySlot[],
  options: readonly AgentSelectOption[],
): AgentFeature {
  return {
    type: "slots",
    id: SECURITY_SLOTS_FEATURE_ID,
    label: "Subagent models",
    description: "Worker fleet for this campaign. Empty uses two copies of the manager model.",
    tooltip: "Choose subagent models and replica counts",
    icon: "bot",
    desktopTrigger: "label",
    value: [...value],
    options: [...options],
    minReplicas: 1,
    maxReplicas: 8,
  };
}

function buildParallelFeature(value: number, limit: number): AgentFeature {
  const max = Math.max(1, limit);
  return {
    type: "stepper",
    id: SECURITY_PARALLEL_FEATURE_ID,
    label: "Parallel",
    description: "How many workers run at once. 1 waits 30s between starts.",
    tooltip: "Workers at once. 1 waits 30s between starts.",
    icon: "zap",
    desktopTrigger: "label",
    value: Math.min(max, Math.max(1, value)),
    min: 1,
    max,
  };
}

function clampScheduleToSlots(
  schedule: ResolvedSecuritySchedule,
  slots: readonly SecuritySlot[],
): ResolvedSecuritySchedule {
  const limit = workerLimit(slots);
  if (schedule.maxParallel <= limit) return schedule;
  return scheduleFromParallel(limit);
}

function reportStatusState(status: CampaignReport["status"]): CampaignWorkerState {
  return status;
}

function resolveManager(
  model: string | undefined,
  candidates: readonly EnabledModel[],
): ModelRef & { label: string; providerLabel: string } {
  const parsed = model ? parseModelRef(model) : null;
  if (parsed) {
    if (isWrapperProvider(parsed.providerId)) {
      throw new Error("Security cannot wrap Jev or Security");
    }
    const match = candidates.find(
      (candidate) =>
        candidate.providerId === parsed.providerId && candidate.modelId === parsed.modelId,
    );
    return {
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      label: match?.label ?? parsed.modelId,
      providerLabel: match?.providerLabel ?? parsed.providerId,
    };
  }
  const first = candidates[0];
  if (!first) {
    throw new Error("No enabled model is available for Security.");
  }
  return {
    providerId: first.providerId,
    modelId: first.modelId,
    label: first.label,
    providerLabel: first.providerLabel,
  };
}

const BOARD_SYSTEM_PROMPT = [
  "You build the Security finding board once.",
  "Write the board file and stop.",
  "Do not modify application source and do not write a finding.",
].join(" ");

function workerPrompt(
  item: CampaignItem,
  goal: string,
  scopes: readonly string[],
  extras: {
    slice: readonly string[];
    filed: readonly string[];
    ledgerPath: string | null;
    boardPath: string | null;
    boardLines: readonly string[];
  },
): string {
  return [
    WORKER_SYSTEM_PROMPT,
    workerOutputPaths(scopes),
    searchSliceText(extras.slice),
    boardText(extras.boardLines, extras.boardPath),
    filedText(extras.filed, extras.ledgerPath),
    `Worker: ${modelRefKey(item)} replica ${item.replica}.`,
    "Campaign goal:",
    goal,
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

function boardText(lines: readonly string[], boardPath: string | null): string {
  if (!boardPath) return "";
  const header = [
    "Session board, built once from the current findings. Do not rebuild it.",
    `Board: ${boardPath}`,
  ];
  if (lines.length === 0) return header.join("\n");
  return [...header, ...lines.map((line) => `- ${line}`)].join("\n");
}

function searchSliceText(slice: readonly string[]): string {
  if (slice.length === 0) return "";
  return [
    "Search only these paths, including files under them. Other workers have the rest of the tree.",
    ...slice.map((path) => `- ${path}`),
  ].join("\n");
}

async function boardEntryFromFile(file: string, cwd: string): Promise<FindingBoardEntry> {
  const card = await summarizeFindingFile(file, cwd);
  const markdown = await readOptional(file);
  return {
    status: findingBoardStatus(markdown ?? ""),
    title: card.title,
    relativePath: card.relativePath,
  };
}

async function readOptional(path: string | null): Promise<string | null> {
  if (!path) return null;
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function withBoardNote(prompt: AgentPromptInput, boardPath: string | null): AgentPromptInput {
  if (!boardPath) return prompt;
  const note = `Finding board: ${boardPath}. Built once from the current findings. Do not open the finding files.`;
  if (typeof prompt === "string") return `${note}\n\n${prompt}`;
  return [{ type: "text", text: note }, ...prompt];
}

function filedText(filed: readonly string[], ledgerPath: string | null): string {
  const lines = [
    "Before you write a finding, read the shared ledger again. If the same issue is already listed, do not write another file.",
  ];
  if (ledgerPath) lines.push(`Ledger: ${ledgerPath}`);
  if (filed.length === 0) return lines.join("\n");
  return [...lines, "Already filed:", ...filed.map((line) => `- ${line}`)].join("\n");
}

function workerOutputPaths(scopes: readonly string[]): string {
  const targets = [
    ...new Set(scopes.map((scope) => scope.replace(/^engagements\//, "").replace(/\/$/, ""))),
  ];
  if (targets.length === 0) {
    return "Write findings only for the target named in the campaign goal. Do not write into another target's findings directory.";
  }
  const lines = targets.flatMap((target) => [
    `- ${target}/research/review/findings/<class>/<file>.md`,
    `- engagements/${target}/out/<host>/findings/<class>/<file>.md`,
  ]);
  return [
    "Write findings only under these paths:",
    ...lines,
    `Do not write outside ${targets.join(", ")}.`,
  ].join("\n");
}

export function extractWorkerBrief(text: string | null): string | null {
  if (!text) return null;
  const match = /:::worker-brief\s*([\s\S]*?)\s*:::/.exec(text);
  const body = match?.[1]?.trim() ?? "";
  return body.length > 0 ? body : null;
}

function workerNotice(
  item: Pick<CampaignItem, "providerId" | "modelId" | "replica">,
  status: string,
  findingsCount: number,
  error?: string,
): string {
  const target = `${item.providerId}/${item.modelId} #${item.replica}`;
  if (status === "started") return `Security · ${target} started`;
  if (status === "completed") return `Security · ${target} completed, ${findingsCount} findings`;
  if (status === "skipped-usage") {
    if (error === "free") return `Security · ${target} skipped, out of free usage`;
    if (error === "credits") return `Security · ${target} skipped, out of credits`;
    return `Security · ${target} skipped, out of usage`;
  }
  if (error) return `Security · ${target} failed: ${error}`;
  return `Security · ${target} failed`;
}

function synthesisPrompt(reports: CampaignReport[]): string {
  const lines = reports.map((report) => {
    const target = `${report.providerId}/${report.modelId} #${report.replica}`;
    if (report.status === "skipped-usage") {
      if (report.error === "free") return `- ${target}: skipped, out of free usage`;
      if (report.error === "credits") return `- ${target}: skipped, out of credits`;
      return `- ${target}: skipped, out of usage`;
    }
    const error = report.error ? `, error: ${report.error}` : "";
    return `- ${target}: ${report.status}, findings ${report.findingsCount}${error}`;
  });
  return [
    "Security campaign fleet finished. Synthesize the results for the operator.",
    "Do not invent findings. Only use worker reports and files under findings/.",
    "Keep severity and submission with the human.",
    "",
    ...lines,
  ].join("\n");
}

function joinPrompts(existing: string | undefined, extra: string): string {
  if (!existing || existing.trim().length === 0) return extra;
  return `${existing.trim()}\n\n${extra}`;
}

function promptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

function isCampaignGoal(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.startsWith("/")) return false;
  return !isSystemInjectedEnvelope(trimmed);
}

async function readProviderModes(
  logger: Logger,
  ports: JevRouterPorts,
  cwd: string,
): Promise<Readonly<Record<string, { id: string }[]>>> {
  if (!ports.listProviderModes) return {};
  try {
    return await ports.listProviderModes(cwd);
  } catch (error) {
    logger.warn({ err: error }, "Security could not read provider modes");
    return {};
  }
}

function innerResumeOverrides(
  cwd: string,
  providerModes: readonly { id: string }[],
): Partial<AgentSessionConfig> {
  const mapped = mapJevPermissionMode("bypass", providerModes);
  if (!mapped) return { cwd };
  return { cwd, modeId: mapped };
}

function providerHandleForResume(handle: AgentPersistenceHandle): AgentPersistenceHandle {
  const unwrapped = unwrapSameSession(handle);
  const metadata = metadataWithoutInner(unwrapped.metadata);
  return {
    provider: unwrapped.provider,
    sessionId: unwrapped.sessionId,
    nativeHandle: unwrapped.nativeHandle,
    metadata,
  };
}

function unwrapSameSession(handle: AgentPersistenceHandle): AgentPersistenceHandle {
  let current = handle;
  for (let depth = 0; depth < 8; depth += 1) {
    const nested = readNestedHandle(current);
    if (!nested) break;
    if (nested.provider !== current.provider || nested.sessionId !== current.sessionId) break;
    current = nested;
  }
  return current;
}

function readNestedHandle(handle: AgentPersistenceHandle): AgentPersistenceHandle | null {
  const nested = handle.metadata?.inner;
  if (!nested || typeof nested !== "object") return null;
  const record = nested as Partial<AgentPersistenceHandle>;
  if (typeof record.provider !== "string" || typeof record.sessionId !== "string") return null;
  return {
    provider: record.provider,
    sessionId: record.sessionId,
    nativeHandle: typeof record.nativeHandle === "string" ? record.nativeHandle : undefined,
    metadata: record.metadata,
  };
}

function metadataWithoutInner(metadata: AgentMetadata | undefined): AgentMetadata {
  if (!metadata) return {};
  const next: AgentMetadata = { ...metadata };
  delete next.inner;
  return next;
}

function readManagerHandle(metadata: AgentMetadata | undefined): {
  providerId: string;
  handle: AgentPersistenceHandle;
  manager: ModelRef & { label: string; providerLabel: string };
  campaignComplete: boolean;
  slots: SecuritySlot[] | null;
  pace: SecurityPace | null;
  parallel: number | null;
} | null {
  if (!metadata) return null;
  const providerId = metadata.managerProvider;
  const inner = metadata.inner;
  if (typeof providerId !== "string" || !inner || typeof inner !== "object") return null;
  const record = inner as Partial<AgentPersistenceHandle>;
  if (typeof record.provider !== "string" || typeof record.sessionId !== "string") return null;
  const modelId =
    typeof metadata.managerModel === "string" ? metadata.managerModel : record.sessionId;
  return {
    providerId,
    handle: {
      provider: record.provider,
      sessionId: record.sessionId,
      nativeHandle: typeof record.nativeHandle === "string" ? record.nativeHandle : undefined,
      metadata: record.metadata,
    },
    manager: {
      providerId,
      modelId,
      label: typeof metadata.managerLabel === "string" ? metadata.managerLabel : modelId,
      providerLabel:
        typeof metadata.providerLabel === "string" ? metadata.providerLabel : providerId,
    },
    campaignComplete: metadata.campaignComplete === true,
    slots: Array.isArray(metadata.slots) ? parseSlotsFeatureValue(metadata.slots) : null,
    pace: parsePace(metadata.pace),
    parallel: parseParallel(metadata.parallel),
  };
}

function readCwd(metadata: AgentMetadata | undefined): string {
  const cwd = metadata?.cwd;
  if (typeof cwd === "string" && cwd.length > 0) return cwd;
  return process.cwd();
}
