import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentCreateSessionOptions,
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
import {
  classifyEnabledModel,
  type ClassifiedModel,
  heuristicRouteJudgment,
  heuristicShouldContinue,
  pinFromDecision,
  readJevReasoningEffort,
  routeModels,
  routeTaskText,
  type JevReasoningEffort,
  type EnabledModel,
  type ModelSpecialty,
  type ModelTier,
  type RouteDecision,
  type RouteJudgment,
  type RouteKind,
} from "../../jev/model-router.js";
import {
  isJevPermissionMode,
  JEV_PERMISSION_MODES,
  mapJevPermissionMode,
  type JevPermissionMode,
} from "../../jev/permission-mode.js";

export const JEV_PROVIDER_ID = "jev";

export const JEV_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.6 4.8L18.5 9.5 13.6 11 12 16l-1.6-5L5.5 9.5 10.4 7.8 12 3z"/><path d="M18 14.5l.6 1.7 1.7.6-1.7.6L18 19l-.6-1.6-1.7-.6 1.7-.6.6-1.7z"/></svg>';

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

const JEV_MODEL: AgentModelDefinition = {
  provider: JEV_PROVIDER_ID,
  id: "auto",
  label: "Jev",
  description: "Routes to an enabled model",
  isDefault: true,
  defaultThinkingOptionId: "auto",
  thinkingOptions: [
    {
      id: "auto",
      label: "Auto",
      description: "Jev picks the tier for each step.",
      isDefault: true,
    },
    {
      id: "low",
      label: "Low",
      description: "Prefer a flash model.",
    },
    {
      id: "medium",
      label: "Medium",
      description: "Stay on a standard model or stronger.",
    },
    {
      id: "high",
      label: "High",
      description: "Use a strong model for this session.",
    },
  ],
};

const JEV_MODES: AgentMode[] = JEV_PERMISSION_MODES.map((mode) => ({
  id: mode.id,
  label: mode.label,
  description: mode.description,
}));

export interface JevRouterPorts {
  listCandidates(cwd?: string): Promise<EnabledModel[]>;
  openSession(
    providerId: string,
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession>;
  resumeSession(
    providerId: string,
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession>;
  judge(prompt: string): Promise<RouteJudgment | null>;
  judgeContinue?(question: string, goal: string): Promise<boolean | null>;
  blockedProviders(): Promise<ReadonlySet<string>>;
  listProviderModes?(cwd?: string): Promise<Readonly<Record<string, { id: string }[]>>>;
}

export class JevAgentClient {
  readonly provider: AgentProvider = JEV_PROVIDER_ID;
  readonly capabilities = CAPABILITIES;

  constructor(
    private readonly logger: Logger,
    private readonly ports: JevRouterPorts | undefined,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async fetchCatalog(
    _options: FetchCatalogOptions,
    _context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    return {
      models: [JEV_MODEL],
      modes: JEV_MODES,
      defaultModeId: "auto",
    };
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    return { diagnostic: "Jev routes each task to a model enabled in Paseo." };
  }

  createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    return Promise.resolve(
      new JevAgentSession(this.logger, this.ports, config, launchContext, options),
    );
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    const ports = this.requirePorts();
    const routed = readRoutedHandle(handle.metadata);
    if (!routed) {
      throw new Error("Jev session is missing its routed provider");
    }
    const cwd = overrides?.cwd ?? readCwd(routed.handle.metadata);
    const providerModes = await readProviderModes(this.logger, ports, cwd);
    const inner = await ports.resumeSession(
      routed.providerId,
      providerHandleForResume(routed),
      innerResumeOverrides(overrides, cwd, providerModes[routed.providerId] ?? []),
      launchContext,
      options,
    );
    const session = new JevAgentSession(
      this.logger,
      ports,
      {
        ...overrides,
        provider: JEV_PROVIDER_ID,
        cwd,
      },
      launchContext,
    );
    session.useProviderModes(providerModes);
    session.restoreRouteMemory(handle.metadata);
    session.adopt(inner, routed.decision);
    return session;
  }

  private requirePorts(): JevRouterPorts {
    if (!this.ports) {
      throw new Error("Jev routing is not connected to the daemon");
    }
    return this.ports;
  }
}

class JevAgentSession implements AgentSession {
  readonly provider: AgentProvider = JEV_PROVIDER_ID;
  readonly capabilities = CAPABILITIES;
  private inner: AgentSession | null = null;
  private decision: RouteDecision | null = null;
  private permissionMode: JevPermissionMode;
  private providerModes: Readonly<Record<string, { id: string }[]>> = {};
  private recentUserTexts: string[] = [];
  private reasoningEffort: JevReasoningEffort;
  private lastAssistantText = "";
  private autoFollowUps = 0;
  private failedModels = new Set<string>();
  private unsubscribeInner: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();

  constructor(
    private readonly logger: Logger,
    private readonly ports: JevRouterPorts | undefined,
    private readonly config: AgentSessionConfig,
    private readonly launchContext?: AgentLaunchContext,
    private readonly createOptions?: AgentCreateSessionOptions,
  ) {
    this.permissionMode = isJevPermissionMode(config.modeId) ? config.modeId : "auto";
    this.reasoningEffort = readJevReasoningEffort(config.thinkingOptionId);
  }

  get id(): string | null {
    return this.inner?.id ?? null;
  }

  adopt(inner: AgentSession, decision: RouteDecision): void {
    this.bind(inner, decision, false);
  }

  useProviderModes(modes: Readonly<Record<string, { id: string }[]>>): void {
    this.providerModes = modes;
  }

  restoreRouteMemory(metadata: AgentMetadata | undefined): void {
    const recent = metadata?.recentUserTexts;
    if (!Array.isArray(recent)) return;
    const texts = recent.filter((entry): entry is string => typeof entry === "string");
    this.recentUserTexts = texts.slice(-6);
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
      provider: JEV_PROVIDER_ID,
      sessionId: inner?.sessionId ?? null,
      model: "auto",
      modeId: this.permissionMode,
      thinkingOptionId: this.reasoningEffort,
      extra: this.decision
        ? {
            routedProvider: this.decision.providerId,
            routedModel: this.decision.modelId,
            routedLabel: this.decision.label,
            taskKind: this.decision.kind,
          }
        : undefined,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return JEV_MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.permissionMode;
  }

  async setMode(modeId: string): Promise<void> {
    if (!isJevPermissionMode(modeId)) {
      throw new Error(`Unknown Jev mode '${modeId}'`);
    }
    this.permissionMode = modeId;
    await this.ensureProviderModes();
    const inner = this.inner;
    const providerId = this.decision?.providerId;
    if (!inner?.setMode || !providerId) return;
    const mapped = mapJevPermissionMode(modeId, this.providerModes[providerId] ?? []);
    if (mapped) await inner.setMode(mapped);
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    this.reasoningEffort = readJevReasoningEffort(thinkingOptionId);
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
      throw new Error("Jev session has not started");
    }
    return inner.respondToPermission(requestId, response);
  }

  describePersistence(): AgentPersistenceHandle | null {
    const inner = this.inner?.describePersistence();
    const decision = this.decision;
    if (!inner || !decision) return null;
    return {
      provider: JEV_PROVIDER_ID,
      sessionId: inner.sessionId,
      nativeHandle: inner.nativeHandle,
      metadata: {
        routedProvider: decision.providerId,
        routedModel: decision.modelId,
        routedLabel: decision.label,
        providerLabel: decision.providerLabel,
        tier: decision.tier,
        specialty: decision.specialty,
        kind: decision.kind,
        demand: decision.demand,
        recentUserTexts: this.recentUserTexts,
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
    await this.inner?.interrupt();
  }

  async close(): Promise<void> {
    this.unsubscribeInner?.();
    this.unsubscribeInner = null;
    await this.inner?.close();
  }

  private async runPrompt(
    prompt: AgentPromptInput,
    options: AgentRunOptions | undefined,
  ): Promise<AgentRunResult> {
    return this.withLaunchFailover(prompt, (inner) => inner.run(prompt, options));
  }

  private async startPrompt(
    prompt: AgentPromptInput,
    options: AgentRunOptions | undefined,
  ): Promise<{ turnId: string }> {
    return this.withLaunchFailover(prompt, (inner) => inner.startTurn(prompt, options));
  }

  private async withLaunchFailover<T>(
    prompt: AgentPromptInput,
    run: (inner: AgentSession) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const inner = await this.ensureRouted(prompt);
      try {
        return await run(inner);
      } catch (error) {
        lastError = error;
        if (!isHarnessLaunchFailure(error) || !this.decision) throw error;
        await this.abandonFailedLaunch(error);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("No enabled model could start for Jev.");
  }

  private async ensureRouted(prompt: AgentPromptInput): Promise<AgentSession> {
    const text = promptText(prompt);
    if (this.inner && text.trim().startsWith("/")) return this.inner;
    const ports = this.ports;
    if (!ports) {
      throw new Error("Jev routing is not connected to the daemon");
    }
    if (text !== AUTO_CONTINUE_PROMPT) this.autoFollowUps = 0;
    const task = routeTaskText(text, this.recentUserTexts);
    const candidates = (await ports.listCandidates(this.config.cwd))
      .map(classifyEnabledModel)
      .filter((model) => !this.failedModels.has(modelKey(model.providerId, model.modelId)));
    this.providerModes = (await ports.listProviderModes?.(this.config.cwd)) ?? this.providerModes;
    const blocked = await this.readBlockedProviders(ports);
    if (this.inner && this.decision && this.modelStillHeld(candidates, blocked)) {
      this.rememberUserText(text);
      return this.inner;
    }
    let judgment: RouteJudgment | null = null;
    try {
      judgment = await ports.judge(task);
    } catch (error) {
      this.logger.warn({ err: error }, "Jev route judgment failed");
    }
    this.rememberUserText(text);
    const decision = routeModels(candidates, judgment ?? heuristicRouteJudgment(task), {
      pin: this.decision ? pinFromDecision(this.decision) : null,
      blockedProviderIds: blocked,
      reasoningEffort: this.reasoningEffort,
    });
    if (!decision) {
      if (candidates.length > 0 && blocked.size > 0) {
        throw new Error("Every enabled account is out of usage.");
      }
      throw new Error("No enabled model is available for Jev to route to.");
    }
    this.logger.info(
      {
        blocked: [...blocked].sort(),
        eligible: candidates
          .filter((model) => !blocked.has(model.providerId))
          .map((model) => `${model.providerId}/${model.modelId}`),
        chosen: `${decision.providerId}/${decision.modelId}`,
        kind: decision.kind,
        tier: decision.tier,
        kept: decision.kept,
        fallback: decision.fallback,
        demand: Number(decision.demand.toFixed(2)),
      },
      "Jev usage check",
    );
    return this.applyDecision(ports, decision);
  }

  private async applyDecision(
    ports: JevRouterPorts,
    decision: RouteDecision,
  ): Promise<AgentSession> {
    if (!this.inner || (this.decision && decision.providerId !== this.decision.providerId)) {
      return this.openProvider(ports, decision);
    }
    const switched = await this.switchModel(decision);
    if (!switched) return this.inner;
    this.decision = decision;
    return this.inner;
  }

  private async switchModel(decision: RouteDecision): Promise<boolean> {
    if (!this.inner || !this.decision) return true;
    if (this.decision.providerId !== decision.providerId) return true;
    if (this.decision.modelId === decision.modelId || !this.inner.setModel) return true;
    try {
      await this.inner.setModel(decision.modelId);
    } catch (error) {
      this.logger.warn({ err: error, model: decision.modelId }, "Jev model switch failed");
      return false;
    }
    this.emitNotice(decision);
    return true;
  }

  private mappedMode(providerId: string): string | undefined {
    return mapJevPermissionMode(this.permissionMode, this.providerModes[providerId] ?? []);
  }

  private modelStillHeld(
    candidates: readonly ClassifiedModel[],
    blocked: ReadonlySet<string>,
  ): boolean {
    const decision = this.decision;
    if (!decision) return false;
    if (blocked.has(decision.providerId)) return false;
    return candidates.some(
      (model) => model.providerId === decision.providerId && model.modelId === decision.modelId,
    );
  }

  private async maybeAutoContinue(): Promise<void> {
    if (this.autoFollowUps >= 4 || !this.inner) return;
    const question = this.lastAssistantText.trim();
    const goal = this.recentUserTexts.filter((entry) => entry !== AUTO_CONTINUE_PROMPT).join("\n");
    const shouldContinue = await this.decideAutoContinue(question, goal);
    if (!shouldContinue) return;
    this.autoFollowUps += 1;
    this.lastAssistantText = "";
    this.emitNoticeText("Jev macht weiter, das Ziel ist noch offen.");
    await this.startPrompt(AUTO_CONTINUE_PROMPT, undefined);
  }

  private async decideAutoContinue(question: string, goal: string): Promise<boolean> {
    if (BLOCKING_STEP.test(question)) return false;
    if (heuristicShouldContinue(question, goal)) return true;
    const judged = await this.askContinue(question, goal);
    return judged === true;
  }

  private async askContinue(question: string, goal: string): Promise<boolean | null> {
    const judge = this.ports?.judgeContinue;
    if (!judge) return null;
    try {
      return await judge(question, goal);
    } catch (error) {
      this.logger.warn({ err: error }, "Jev continuation judgment failed");
      return null;
    }
  }

  private emitNoticeText(message: string): void {
    this.emit({
      type: "timeline",
      provider: JEV_PROVIDER_ID,
      item: { type: "notification", level: "info", message },
    });
  }

  private rememberUserText(text: string): void {
    const trimmed = text.trim().slice(0, 500);
    if (!trimmed || trimmed.startsWith("/") || trimmed === AUTO_CONTINUE_PROMPT) return;
    if (this.recentUserTexts[this.recentUserTexts.length - 1] === trimmed) return;
    this.recentUserTexts.push(trimmed);
    if (this.recentUserTexts.length > 6) this.recentUserTexts.shift();
  }

  private async ensureProviderModes(): Promise<void> {
    if (Object.keys(this.providerModes).length > 0) return;
    const ports = this.ports;
    if (!ports) return;
    this.providerModes = await readProviderModes(this.logger, ports, this.config.cwd);
  }

  private async readBlockedProviders(ports: JevRouterPorts): Promise<ReadonlySet<string>> {
    try {
      return await ports.blockedProviders();
    } catch (error) {
      this.logger.warn({ err: error }, "Jev usage lookup failed");
      return new Set();
    }
  }

  private async abandonFailedLaunch(error: unknown): Promise<void> {
    const decision = this.decision;
    if (!decision) return;
    this.failedModels.add(modelKey(decision.providerId, decision.modelId));
    this.logger.warn(
      {
        err: error,
        provider: decision.providerId,
        model: decision.modelId,
      },
      "Jev harness did not start",
    );
    this.emitNoticeText(
      `Jev · ${decision.providerLabel} · ${decision.label} did not start, trying another account.`,
    );
    await this.dropInner();
  }

  private async dropInner(): Promise<void> {
    this.unsubscribeInner?.();
    this.unsubscribeInner = null;
    const previous = this.inner;
    this.inner = null;
    this.decision = null;
    if (!previous) return;
    try {
      await previous.close();
    } catch (error) {
      this.logger.warn({ err: error }, "Jev failed to close a dead provider session");
    }
  }

  private async openProvider(
    ports: JevRouterPorts,
    decision: RouteDecision,
  ): Promise<AgentSession> {
    const previous = this.inner;
    const inner = await ports.openSession(
      decision.providerId,
      delegatedConfig(this.config, decision, this.mappedMode(decision.providerId)),
      this.launchContext,
      this.createOptions,
    );
    this.bind(inner, decision, true);
    if (previous) {
      try {
        await previous.close();
      } catch (error) {
        this.logger.warn({ err: error }, "Jev failed to close the previous provider session");
      }
    }
    return inner;
  }

  private bind(inner: AgentSession, decision: RouteDecision, announce: boolean): void {
    this.unsubscribeInner?.();
    this.inner = inner;
    this.decision = decision;
    this.unsubscribeInner = inner.subscribe((event) => {
      const tagged = retag(event);
      if (!tagged) return;
      if (tagged.type === "timeline" && tagged.item.type === "assistant_message") {
        this.lastAssistantText = tagged.item.text;
      }
      this.emit(tagged);
      if (tagged.type === "turn_completed") {
        void this.enqueue(() => this.maybeAutoContinue());
      }
    });
    const handle = this.describePersistence();
    if (handle?.sessionId) {
      this.emit({
        type: "thread_started",
        sessionId: handle.sessionId,
        provider: JEV_PROVIDER_ID,
      });
    }
    if (announce) this.emitNotice(decision);
  }

  private emitNotice(decision: RouteDecision): void {
    this.emit({
      type: "timeline",
      provider: JEV_PROVIDER_ID,
      item: {
        type: "notification",
        level: "info",
        message: decision.fallback
          ? `Jev · ${decision.providerLabel} · ${decision.label} (previous account unavailable)`
          : `Jev · ${decision.providerLabel} · ${decision.label}`,
      },
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
}

function delegatedConfig(
  config: AgentSessionConfig,
  decision: RouteDecision,
  modeId: string | undefined,
): AgentSessionConfig {
  return {
    ...config,
    provider: decision.providerId,
    model: decision.modelId,
    modeId,
    thinkingOptionId: undefined,
    featureValues: undefined,
  };
}

function promptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

function isHarnessLaunchFailure(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /unrecognized_model|ProcessTransport is not ready|Unknown model/i.test(text);
}

const AUTO_CONTINUE_PROMPT =
  "Weiter. Das Ziel ist schon freigegeben. Klicke selbst, prüfe laufende Jobs und benutze Browser und Shell. Frag nicht nach dem nächsten Schritt. Stoppe nur bei Löschen, Backup, einem Geheimnis oder einem anderen Projekt.";
const BLOCKING_STEP =
  /prune|backup|andere projekte|löschen|loeschen|drop database|produktion deploy|production deploy/i;

function retag(event: AgentStreamEvent): AgentStreamEvent | null {
  if (event.type === "mode_changed") return null;
  if (event.type === "model_changed") {
    return {
      ...event,
      provider: JEV_PROVIDER_ID,
      runtimeInfo: { ...event.runtimeInfo, provider: JEV_PROVIDER_ID, model: "auto" },
    };
  }
  return { ...event, provider: JEV_PROVIDER_ID };
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
    logger.warn({ err: error }, "Jev could not read provider modes");
    return {};
  }
}

function innerResumeOverrides(
  overrides: Partial<AgentSessionConfig> | undefined,
  cwd: string,
  providerModes: readonly { id: string }[],
): Partial<AgentSessionConfig> {
  const requested = isJevPermissionMode(overrides?.modeId) ? overrides.modeId : undefined;
  const mapped = requested ? mapJevPermissionMode(requested, providerModes) : undefined;
  if (!mapped) return { cwd };
  return { cwd, modeId: mapped };
}

function providerHandleForResume(routed: {
  handle: AgentPersistenceHandle;
  decision: RouteDecision;
}): AgentPersistenceHandle {
  const unwrapped = unwrapSameSession(routed.handle);
  const metadata = metadataWithoutInner(unwrapped.metadata);
  const model = metadata.model;
  if (typeof model !== "string" || model.length === 0 || model === "auto") {
    metadata.model = routed.decision.modelId;
  }
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

function readRoutedHandle(metadata: AgentMetadata | undefined): {
  providerId: string;
  handle: AgentPersistenceHandle;
  decision: RouteDecision;
} | null {
  if (!metadata) return null;
  const providerId = metadata.routedProvider;
  const inner = metadata.inner;
  if (typeof providerId !== "string" || !inner || typeof inner !== "object") return null;
  const record = inner as Partial<AgentPersistenceHandle>;
  if (typeof record.provider !== "string" || typeof record.sessionId !== "string") return null;
  const modelId =
    typeof metadata.routedModel === "string" ? metadata.routedModel : record.sessionId;
  return {
    providerId,
    handle: {
      provider: record.provider,
      sessionId: record.sessionId,
      nativeHandle: typeof record.nativeHandle === "string" ? record.nativeHandle : undefined,
      metadata: record.metadata,
    },
    decision: {
      providerId,
      providerLabel:
        typeof metadata.providerLabel === "string" ? metadata.providerLabel : providerId,
      modelId,
      label: typeof metadata.routedLabel === "string" ? metadata.routedLabel : modelId,
      tier: readTier(metadata.tier),
      specialty: readSpecialty(metadata.specialty),
      kind: readKind(metadata.kind),
      demand: typeof metadata.demand === "number" ? metadata.demand : 0.5,
      kept: true,
      fallback: false,
    },
  };
}

function readCwd(metadata: AgentMetadata | undefined): string {
  const cwd = metadata?.cwd;
  if (typeof cwd === "string" && cwd.length > 0) return cwd;
  return process.cwd();
}

function readTier(value: unknown): ModelTier {
  if (value === "flash" || value === "strong" || value === "standard") return value;
  return "standard";
}

function readSpecialty(value: unknown): ModelSpecialty {
  if (value === "cyber" || value === "general") return value;
  return "general";
}

function readKind(value: unknown): RouteKind {
  if (
    value === "quick" ||
    value === "coding" ||
    value === "cyber_light" ||
    value === "cyber_heavy" ||
    value === "reasoning"
  ) {
    return value;
  }
  return "coding";
}
