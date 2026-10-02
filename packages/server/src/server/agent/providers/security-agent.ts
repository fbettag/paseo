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
import type { JevRouterPorts } from "./jev-agent.js";
import { JEV_PROVIDER_ID } from "./jev-agent.js";
import {
  defaultClock,
  expandSlots,
  modelRefKey,
  parseModelRef,
  runCampaign,
  shuffleInPlace,
  type CampaignItem,
  type CampaignReport,
  type ModelRef,
} from "../../security/campaign.js";
import { classifyOrcaUsageSkip, UsageSkipError } from "../../security/usage-error.js";
import { listFindingFiles } from "../../security/findings.js";
import {
  parseSecurityParams,
  parseSlotsFeatureValue,
  resolveSessionSlots,
  SECURITY_SLOTS_FEATURE_ID,
  type ResolvedSecurityParams,
  type SecuritySlot,
} from "../../security/settings.js";

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
  "The worker fleet is owned by this provider and starts on the operator's campaign goal.",
  "Do not call create_agent for that fleet.",
  "Do not claim workers are idle or missing while this session is open; fleet status arrives as Security notices.",
  "Plan, read evidence, and brief the operator.",
  "Severity decisions and report submission stay with the human.",
].join(" ");

const WORKER_SYSTEM_PROMPT = [
  "You are a Security campaign worker.",
  "Follow AGENTS.md in this workspace.",
  "Do not spawn further agents. The fleet is provider-owned.",
  "Write findings under engagements/<name>/out/<host>/findings/<class>/.",
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
    const slots = resolveSessionSlots(config.featureValues, this.params.slots);
    return [buildSlotsFeature(slots, slotOptions(candidates))];
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const candidates = await this.readCandidates(config.cwd);
    return new SecurityAgentSession(
      this.logger,
      this.ports,
      this.params,
      config,
      slotOptions(candidates),
      launchContext,
      options,
    );
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
    const resumedSlots = routed.slots ?? this.params.slots;
    const resumedFeatureValues = {
      ...overrides?.featureValues,
      [SECURITY_SLOTS_FEATURE_ID]: resumedSlots,
    };
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
  private campaignStarted = false;
  private campaignComplete = false;
  private unsubscribeInner: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private readonly workers = new Set<AgentSession>();
  private readonly abort = new AbortController();
  private slots: SecuritySlot[];

  constructor(
    private readonly logger: Logger,
    private readonly ports: JevRouterPorts | undefined,
    private readonly params: ResolvedSecurityParams,
    private readonly config: AgentSessionConfig,
    private readonly slotChoices: readonly AgentSelectOption[],
    private readonly launchContext?: AgentLaunchContext,
    private readonly createOptions?: AgentCreateSessionOptions,
  ) {
    this.slots = resolveSessionSlots(config.featureValues, params.slots);
  }

  get features(): AgentFeature[] {
    return [buildSlotsFeature(this.slots, this.slotChoices)];
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
    this.campaignStarted = campaignComplete;
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
      const tagged = retag(event);
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
      extra: this.manager
        ? {
            managerProvider: this.manager.providerId,
            managerModel: this.manager.modelId,
            managerLabel: this.manager.label,
            campaignComplete: this.campaignComplete,
          }
        : undefined,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return SECURITY_MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return "bypass";
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    if (featureId !== SECURITY_SLOTS_FEATURE_ID) {
      throw new Error(`Unknown Security feature '${featureId}'`);
    }
    this.slots = resolveSessionSlots({ [SECURITY_SLOTS_FEATURE_ID]: value }, []);
    this.config.featureValues = {
      ...this.config.featureValues,
      [SECURITY_SLOTS_FEATURE_ID]: this.slots,
    };
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

  async interrupt(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled([
      this.inner?.interrupt(),
      ...[...this.workers].map((worker) => worker.interrupt()),
    ]);
  }

  async close(): Promise<void> {
    this.abort.abort();
    this.unsubscribeInner?.();
    this.unsubscribeInner = null;
    await Promise.allSettled([
      this.inner?.close(),
      ...[...this.workers].map((worker) => worker.close()),
    ]);
    this.workers.clear();
  }

  private async runPrompt(
    prompt: AgentPromptInput,
    options: AgentRunOptions | undefined,
  ): Promise<AgentRunResult> {
    const inner = await this.ensureManager();
    this.maybeStartCampaign(prompt);
    return inner.run(prompt, options);
  }

  private async startPrompt(
    prompt: AgentPromptInput,
    options: AgentRunOptions | undefined,
  ): Promise<{ turnId: string }> {
    const inner = await this.ensureManager();
    this.maybeStartCampaign(prompt);
    return inner.startTurn(prompt, options);
  }

  private maybeStartCampaign(prompt: AgentPromptInput): void {
    const text = promptText(prompt);
    if (this.campaignStarted || this.campaignComplete) return;
    if (text.trim().startsWith("/")) return;
    if (text.trim().length === 0) return;
    this.campaignStarted = true;
    void this.runFleet(text)
      .then((reports) => this.enqueue(() => this.synthesize(reports)))
      .catch((error) => {
        this.logger.warn({ err: error }, "Security campaign failed");
        this.emitNoticeText(
          `Security · fleet failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
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

  private async runFleet(goal: string): Promise<CampaignReport[]> {
    const ports = this.requirePorts();
    const manager = this.manager;
    const items = expandSlots(this.slots, manager);
    this.emitNoticeText(
      `Security · fleet ${items.length} workers, max ${this.params.maxParallel} in parallel`,
    );
    if (items.length === 0) {
      this.campaignComplete = true;
      return [];
    }
    const reports = await runCampaign({
      slots: this.slots,
      fallback: manager,
      maxParallel: this.params.maxParallel,
      usageWaitMs: this.params.usageWaitMs,
      usagePollMs: this.params.usagePollMs,
      goal,
      workerPrompt,
      signal: this.abort.signal,
      ports: {
        blockedProviders: () => ports.blockedProviders(),
        runWorker: (item, prompt, signal) => this.runWorker(item, prompt, signal),
        shuffle: shuffleInPlace,
        clock: defaultClock(),
      },
    });
    for (const report of reports) {
      if (report.status === "skipped-usage") {
        this.emitNoticeText(
          workerNotice(report, "skipped-usage", report.findingsCount, report.error),
        );
      }
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
    const session = await ports.openSession(
      item.providerId,
      {
        ...this.config,
        provider: item.providerId,
        model: item.modelId,
        modeId: this.mappedMode(item.providerId),
        thinkingOptionId: undefined,
        featureValues: undefined,
        systemPrompt: joinPrompts(this.config.systemPrompt, WORKER_SYSTEM_PROMPT),
        title: `Security worker ${item.key}`,
        internal: true,
      },
      this.launchContext,
    );
    this.workers.add(session);
    try {
      const before = new Set(await listFindingFiles(this.config.cwd));
      const result = await session.run(prompt);
      const after = await listFindingFiles(this.config.cwd);
      const findingsCount = after.filter((path) => !before.has(path)).length;
      this.emitNoticeText(workerNotice(item, "completed", findingsCount));
      return { text: result.finalText, findingsCount };
    } catch (error) {
      const skip = classifyOrcaUsageSkip(error);
      if (skip) throw new UsageSkipError(skip);
      const message = error instanceof Error ? error.message : String(error);
      this.emitNoticeText(workerNotice(item, "failed", 0, message));
      throw error;
    } finally {
      this.workers.delete(session);
      try {
        await session.close();
      } catch (error) {
        this.logger.warn({ err: error, worker: item.key }, "Security worker close failed");
      }
    }
  }

  private async synthesize(reports: CampaignReport[]): Promise<void> {
    this.campaignComplete = true;
    if (this.abort.signal.aborted) return;
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
      const tagged = retag(event);
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

function workerPrompt(item: CampaignItem, goal: string): string {
  return [
    WORKER_SYSTEM_PROMPT,
    `Worker: ${modelRefKey(item)} replica ${item.replica}.`,
    "Campaign goal:",
    goal,
  ].join("\n");
}

function workerNotice(
  item: Pick<CampaignItem, "providerId" | "modelId" | "replica">,
  status: string,
  findingsCount: number,
  error?: string,
): string {
  const target = `${item.providerId}/${item.modelId} #${item.replica}`;
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

function retag(event: AgentStreamEvent): AgentStreamEvent | null {
  if (event.type === "mode_changed") return null;
  if (event.type === "model_changed") {
    return {
      ...event,
      provider: SECURITY_PROVIDER_ID,
      runtimeInfo: {
        ...event.runtimeInfo,
        provider: SECURITY_PROVIDER_ID,
      },
    };
  }
  return { ...event, provider: SECURITY_PROVIDER_ID };
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
  };
}

function readCwd(metadata: AgentMetadata | undefined): string {
  const cwd = metadata?.cwd;
  if (typeof cwd === "string" && cwd.length > 0) return cwd;
  return process.cwd();
}
