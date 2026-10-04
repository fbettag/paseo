import { describe, expect, it } from "vitest";

import type {
  AgentCapabilityFlags,
  AgentMode,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
} from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { ChildAgentHandle, CreateChildAgentInput, JevRouterPorts } from "./jev-agent.js";
import { SecurityAgentClient } from "./security-agent.js";
import type { EnabledModel } from "../../jev/model-router.js";
import { parseModelRef } from "../../security/campaign.js";

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

class FakeSession implements AgentSession {
  readonly capabilities = CAPABILITIES;
  readonly id = "native-1";
  readonly prompts: string[] = [];
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();

  constructor(
    readonly provider: string,
    readonly model: string | undefined,
    readonly internal: boolean,
    private readonly runError?: Error,
    private readonly holdTurn = false,
  ) {}

  async run(prompt: AgentPromptInput): Promise<AgentRunResult> {
    this.prompts.push(typeof prompt === "string" ? prompt : "");
    if (this.runError) throw this.runError;
    if (!this.holdTurn) this.completeTurn();
    return { sessionId: this.id, finalText: "done", timeline: [] };
  }

  async startTurn(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    this.prompts.push(typeof prompt === "string" ? prompt : "");
    if (!this.holdTurn) this.completeTurn();
    return { turnId: `turn-${this.prompts.length}` };
  }

  completeTurn(brief?: string): void {
    if (brief) {
      this.emit({
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: brief },
      });
    }
    this.emit({ type: "turn_completed", provider: this.provider });
  }

  failTurn(): void {
    this.emit({ type: "turn_failed", provider: this.provider, error: "manager failed" });
  }

  cancelTurn(): void {
    this.emit({ type: "turn_canceled", provider: this.provider, reason: "interrupted" });
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: this.model ?? "inner" };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return "bypassPermissions";
  }

  async setMode(): Promise<void> {}

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

const MODELS: EnabledModel[] = [
  {
    providerId: "grok",
    providerLabel: "Grok",
    modelId: "grok-4.6",
    label: "Grok 4.6",
  },
  {
    providerId: "glm",
    providerLabel: "GLM",
    modelId: "glm-5.3-flash",
    label: "GLM Flash",
  },
];

function ports(
  blocked: ReadonlySet<string> = new Set(),
  runErrors: Readonly<Record<string, Error>> = {},
  options: { holdWorkers?: boolean; promptThrows?: boolean; holdManagerTurn?: boolean } = {},
): {
  ports: JevRouterPorts;
  opened: Array<{ providerId: string; model?: string; internal?: boolean }>;
  children: Array<{
    provider: string;
    title: string;
    initialPrompt: string;
    prompts: string[];
    finish: () => void;
  }>;
  sessions: FakeSession[];
  resumed: Array<{ providerId: string; handle: AgentPersistenceHandle }>;
} {
  const opened: Array<{ providerId: string; model?: string; internal?: boolean }> = [];
  const resumed: Array<{ providerId: string; handle: AgentPersistenceHandle }> = [];
  const sessions: FakeSession[] = [];
  const children: Array<{
    provider: string;
    title: string;
    initialPrompt: string;
    prompts: string[];
    finish: () => void;
  }> = [];
  return {
    opened,
    resumed,
    sessions,
    children,
    ports: {
      listCandidates: () => Promise.resolve(MODELS),
      judge: async () => null,
      openSession: (providerId, config) => {
        opened.push({
          providerId,
          model: config.model,
          internal: config.internal === true,
        });
        const session = new FakeSession(
          providerId,
          config.model,
          config.internal === true,
          runErrors[providerId],
          options.holdManagerTurn === true,
        );
        sessions.push(session);
        return Promise.resolve(session);
      },
      resumeSession: (providerId, handle) => {
        resumed.push({ providerId, handle });
        return Promise.resolve(new FakeSession(providerId, undefined, false));
      },
      blockedProviders: () => Promise.resolve(blocked),
      listProviderModes: () =>
        Promise.resolve({
          grok: [{ id: "full-access" }],
          glm: [{ id: "bypassPermissions" }],
        }),
      createChildAgent: (input) =>
        createFakeChild(input, children, runErrors, options.holdWorkers, options.promptThrows),
    },
  };
}

function createFakeChild(
  input: CreateChildAgentInput,
  children: Array<{
    provider: string;
    title: string;
    initialPrompt: string;
    prompts: string[];
    finish: () => void;
  }>,
  runErrors: Readonly<Record<string, Error>>,
  holdWorkers?: boolean,
  promptThrows?: boolean,
): Promise<ChildAgentHandle> {
  const parsed = parseModelRef(input.provider);
  const providerId = parsed?.providerId ?? input.provider;
  let resolveFinish: (value: { text: string }) => void = () => undefined;
  const finished = new Promise<{ text: string }>((resolve) => {
    resolveFinish = resolve;
  });
  const record = {
    provider: input.provider,
    title: input.title,
    initialPrompt: input.initialPrompt,
    prompts: [] as string[],
    finish: () => resolveFinish({ text: "done" }),
  };
  children.push(record);
  if (!holdWorkers) {
    queueMicrotask(() => {
      record.finish();
    });
  }
  return Promise.resolve({
    agentId: `child-${children.length}`,
    waitForFinish: async () => {
      const error = runErrors[providerId];
      if (error) throw error;
      return finished;
    },
    prompt: async (text) => {
      record.prompts.push(text);
      if (promptThrows) throw new Error("already has an active run");
    },
    interrupt: async () => undefined,
  });
}

const PARENT_LAUNCH = { agentId: "security-parent" };
const FLEET = { usageWaitMs: 0, staggerMs: 0 } as const;
const LIVE_FLEET = { usageWaitMs: 0, staggerMs: 0, pace: "aggressive" as const };

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for Security campaign");
}

function noticesInclude(notices: readonly string[], needle: string): boolean {
  return notices.some((line) => line.includes(needle));
}

function childReceivedFollowUp(
  children: ReadonlyArray<{ prompts: readonly string[] }>,
  text: string,
): boolean {
  return children.some((child) => child.prompts.includes(text));
}

describe("SecurityAgentClient", () => {
  it("lists inner models as the manager catalog", async () => {
    const harness = ports();
    const client = new SecurityAgentClient(createTestLogger(), harness.ports);
    const catalog = await client.fetchCatalog({ scope: "global", force: false });
    expect(catalog.defaultModeId).toBe("bypass");
    expect(catalog.models.map((model) => model.id)).toEqual(["grok/grok-4.6", "glm/glm-5.3-flash"]);
    expect(catalog.models[0]?.isDefault).toBe(true);
  });

  it("opens the manager and two replicas of that model when slots are empty", async () => {
    const harness = ports();
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, FLEET);
    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
      },
      PARENT_LAUNCH,
    );
    const notices: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "notification") {
        notices.push(event.item.message);
      }
    });
    await session.startTurn("scan the engagement");
    await waitFor(() => noticesInclude(notices, "completed"));
    expect(harness.opened[0]).toEqual({
      providerId: "grok",
      model: "grok-4.6",
      internal: false,
    });
    expect(harness.children.map((child) => child.provider)).toEqual([
      "grok/grok-4.6",
      "grok/grok-4.6",
    ]);
    expect(harness.children.every((child) => child.title.includes("Security ·"))).toBe(true);
    expect(notices.some((line) => line.includes("fleet 2 workers"))).toBe(true);
    expect(notices.some((line) => line.includes("started"))).toBe(true);
  });

  it("skips Orca free workers with a short notice instead of the 402 JSON", async () => {
    const harness = ports(new Set(), {
      orcarouter: new Error(
        '{"name":"APIError","data":{"statusCode":402,"responseBody":"{\\"error\\":{\\"code\\":\\"free_quota_exhausted\\",\\"metadata\\":{\\"reason\\":\\"err_free_used\\"}}}"}}',
      ),
    });
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, {
      ...FLEET,
      slots: [{ model: "orcarouter/orcarouter/orcarouter/free", replicas: 2 }],
    });
    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
      },
      PARENT_LAUNCH,
    );
    const notices: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "notification") {
        notices.push(event.item.message);
      }
    });
    await session.startTurn("scan the engagement");
    await waitFor(() => noticesInclude(notices, "out of free usage"));
    expect(notices.some((line) => line.includes("APIError"))).toBe(false);
    expect(notices.filter((line) => line.includes("out of free usage"))).toHaveLength(2);
  });

  it("skips a blocked worker after the wait budget", async () => {
    const harness = ports(new Set(["glm"]));
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, {
      ...FLEET,
      slots: [
        { model: "grok/grok-4.6", replicas: 1 },
        { model: "glm/glm-5.3-flash", replicas: 1 },
      ],
    });
    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
      },
      PARENT_LAUNCH,
    );
    const notices: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "notification") {
        notices.push(event.item.message);
      }
    });
    await session.startTurn("scan the engagement");
    await waitFor(() => noticesInclude(notices, "out of usage"));
    expect(harness.children.map((child) => child.provider)).toEqual(["grok/grok-4.6"]);
    expect(notices.some((line) => line.includes("glm/glm-5.3-flash #1 skipped"))).toBe(true);
  });

  it("lists slots as a composer feature and honors session featureValues", async () => {
    const harness = ports();
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, {
      ...FLEET,
      slots: [{ model: "glm/glm-5.3-flash", replicas: 4 }],
    });
    const listed = await client.listFeatures({
      provider: "security",
      cwd: "/tmp/repo",
    });
    expect(listed).toEqual([
      expect.objectContaining({
        type: "slots",
        id: "slots",
        value: [{ model: "glm/glm-5.3-flash", replicas: 4 }],
        options: [
          { id: "grok/grok-4.6", label: "Grok · Grok 4.6" },
          { id: "glm/glm-5.3-flash", label: "GLM · GLM Flash" },
        ],
      }),
      expect.objectContaining({
        type: "stepper",
        id: "parallel",
        value: 1,
        min: 1,
        max: 4,
      }),
    ]);

    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
        featureValues: { slots: [{ model: "grok/grok-4.6", replicas: 1 }] },
      },
      PARENT_LAUNCH,
    );
    const notices: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "notification") {
        notices.push(event.item.message);
      }
    });
    await session.startTurn("scan the engagement");
    await waitFor(() => noticesInclude(notices, "completed"));
    expect(harness.children.map((child) => child.provider)).toEqual(["grok/grok-4.6"]);
  });

  it("applies setFeature slots before the fleet starts", async () => {
    const harness = ports();
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, FLEET);
    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
      },
      PARENT_LAUNCH,
    );
    if (!session.setFeature) {
      throw new Error("Security session is missing setFeature");
    }
    await session.setFeature("slots", [{ model: "glm/glm-5.3-flash", replicas: 2 }]);
    const notices: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "notification") {
        notices.push(event.item.message);
      }
    });
    await session.startTurn("scan the engagement");
    await waitFor(() => noticesInclude(notices, "completed"));
    expect(harness.children.map((child) => child.provider)).toEqual([
      "glm/glm-5.3-flash",
      "glm/glm-5.3-flash",
    ]);
    const slotsFeature = session.features?.[0];
    expect(slotsFeature?.type).toBe("slots");
    if (slotsFeature?.type !== "slots") {
      throw new Error("Expected slots feature");
    }
    expect(slotsFeature.value).toEqual([{ model: "glm/glm-5.3-flash", replicas: 2 }]);
  });

  it("clamps the parallel stepper when a slot is removed", async () => {
    const harness = ports();
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, FLEET);
    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
      },
      PARENT_LAUNCH,
    );
    if (!session.setFeature) {
      throw new Error("Security session is missing setFeature");
    }
    await session.setFeature("slots", [
      { model: "glm/glm-5.3-flash", replicas: 2 },
      { model: "grok/grok-4.6", replicas: 2 },
    ]);
    await session.setFeature("parallel", 4);
    await session.setFeature("slots", [{ model: "grok/grok-4.6", replicas: 1 }]);
    const parallel = session.features?.find((feature) => feature.id === "parallel");
    expect(parallel).toMatchObject({ type: "stepper", value: 1, min: 1, max: 1 });
  });

  it("resumes the manager and does not restart workers", async () => {
    const harness = ports();
    const client = new SecurityAgentClient(createTestLogger(), harness.ports);
    await client.resumeSession(
      {
        provider: "security",
        sessionId: "grok-session",
        metadata: {
          managerProvider: "grok",
          managerModel: "grok-4.6",
          managerLabel: "Grok 4.6",
          providerLabel: "Grok",
          campaignComplete: false,
          inner: {
            provider: "grok",
            sessionId: "grok-session",
            metadata: { cwd: "/tmp/repo", model: "grok-4.6" },
          },
        },
      },
      { provider: "security", cwd: "/tmp/repo", model: "grok/grok-4.6" },
    );
    expect(harness.resumed).toEqual([
      {
        providerId: "grok",
        handle: {
          provider: "grok",
          sessionId: "grok-session",
          metadata: { cwd: "/tmp/repo", model: "grok-4.6" },
        },
      },
    ]);
    expect(harness.opened).toEqual([]);
  });

  it("forwards a later user turn to the latest live worker", async () => {
    const harness = ports(new Set(), {}, { holdWorkers: true });
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, LIVE_FLEET);
    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
      },
      PARENT_LAUNCH,
    );
    const notices: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "notification") {
        notices.push(event.item.message);
      }
    });
    await session.startTurn("scan the engagement");
    await waitFor(() => harness.children.length === 2);
    await session.startTurn("continue with a 2nd account");
    await waitFor(() => childReceivedFollowUp(harness.children, "continue with a 2nd account"));
    expect(notices.some((line) => line.includes("latest live worker"))).toBe(true);
    expect(harness.children[0]?.prompts).not.toContain("continue with a 2nd account");
    expect(harness.children[1]?.prompts).toContain("continue with a 2nd account");
    for (const child of harness.children) child.finish();
    await waitFor(() => noticesInclude(notices, "completed"));
  });

  it("does not treat a worker finish notice as a campaign follow-up", async () => {
    const harness = ports(new Set(), {}, { holdWorkers: true });
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, LIVE_FLEET);
    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
      },
      PARENT_LAUNCH,
    );
    await session.startTurn("scan the engagement");
    await waitFor(() => harness.children.length === 2);
    const notice =
      "<paseo-system>\nAgent child-1 (Security · grok/grok-4.6 #1) errored.\n</paseo-system>";
    if (!session.steerActiveTurn) throw new Error("security session does not steer");
    await session.steerActiveTurn(notice, { expectedTurnId: "turn-1" });
    for (const child of harness.children) {
      expect(child.prompts).not.toContain(notice);
    }
    for (const child of harness.children) child.finish();
  });

  it("reports a busy worker instead of rejecting the follow-up", async () => {
    const harness = ports(new Set(), {}, { holdWorkers: true, promptThrows: true });
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, LIVE_FLEET);
    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
      },
      PARENT_LAUNCH,
    );
    const notices: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "notification") {
        notices.push(event.item.message);
      }
    });
    await session.startTurn("scan the engagement");
    await waitFor(() => harness.children.length === 2);
    await expect(session.startTurn("continue with a 2nd account")).resolves.toEqual({
      turnId: "turn-2",
    });
    await waitFor(() => noticesInclude(notices, "follow-up was not delivered"));
    for (const child of harness.children) child.finish();
  });

  it("drops a stored slot whose id is not a current option", async () => {
    const harness = ports();
    const stale = "orcarouter/orcarouter/orcarouter/free";
    const featureValues = {
      slots: [
        { model: stale, replicas: 2 },
        { model: "grok/grok-4.6", replicas: 1 },
      ],
    };
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, {
      ...FLEET,
      slots: [{ model: stale, replicas: 2 }],
    });
    const listed = await client.listFeatures({
      provider: "security",
      cwd: "/tmp/repo",
      featureValues,
    });
    const listedSlots = listed.find((feature) => feature.id === "slots");
    expect(listedSlots?.type).toBe("slots");
    if (listedSlots?.type !== "slots") throw new Error("Expected slots feature");
    expect(listedSlots.value).toEqual([{ model: "grok/grok-4.6", replicas: 1 }]);

    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
        featureValues,
      },
      PARENT_LAUNCH,
    );
    await session.startTurn("scan the engagement");
    await waitFor(() => harness.children.length === 1);
    expect(harness.children.map((child) => child.provider)).toEqual(["grok/grok-4.6"]);
    if (!session.setFeature) throw new Error("Security session is missing setFeature");
    await session.setFeature("slots", [
      { model: stale, replicas: 2 },
      { model: "glm/glm-5.3-flash", replicas: 1 },
    ]);
    const slotsFeature = session.features?.[0];
    if (slotsFeature?.type !== "slots") throw new Error("Expected slots feature");
    expect(slotsFeature.value).toEqual([{ model: "glm/glm-5.3-flash", replicas: 1 }]);
  });

  it("waits for the manager brief before starting workers", async () => {
    const harness = ports(new Set(), {}, { holdManagerTurn: true });
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, FLEET);
    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
      },
      PARENT_LAUNCH,
    );
    await session.startTurn("scan the engagement");
    await session.startTurn("also check auth");
    expect(harness.children).toHaveLength(0);
    harness.sessions[0]?.completeTurn("read the vercel headers first");
    await waitFor(() => harness.children.length === 2);
    const prompt = harness.children[0]?.initialPrompt ?? "";
    expect(prompt).toContain("scan the engagement");
    expect(prompt).toContain("also check auth");
    expect(prompt).toContain("Manager brief:\nread the vercel headers first");
  });

  it("starts the next fleet after the operator stops the manager", async () => {
    const harness = ports(new Set(), {}, { holdManagerTurn: true });
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, FLEET);
    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
      },
      PARENT_LAUNCH,
    );
    await session.startTurn("scan vercel");
    await session.interrupt();
    harness.sessions[0]?.cancelTurn();
    expect(harness.children).toHaveLength(0);
    await session.startTurn("actually its firecracker");
    harness.sessions[0]?.completeTurn("audit the jailer");
    await waitFor(() => harness.children.length === 2);
    const prompt = harness.children[0]?.initialPrompt ?? "";
    expect(prompt).toContain("actually its firecracker");
    expect(prompt).toContain("Manager brief:\naudit the jailer");
    expect(prompt).not.toContain("scan vercel");
  });

  it("starts workers from the raw goal when the manager turn fails", async () => {
    const harness = ports(new Set(), {}, { holdManagerTurn: true });
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, FLEET);
    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
      },
      PARENT_LAUNCH,
    );
    await session.startTurn("scan the engagement");
    expect(harness.children).toHaveLength(0);
    harness.sessions[0]?.failTurn();
    await waitFor(() => harness.children.length === 2);
    const prompt = harness.children[0]?.initialPrompt ?? "";
    expect(prompt).toContain("scan the engagement");
    expect(prompt).not.toContain("Manager brief:");
  });

  it("starts one quiet worker at a time", async () => {
    const harness = ports(new Set(), {}, { holdWorkers: true });
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, FLEET);
    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
      },
      PARENT_LAUNCH,
    );
    await session.startTurn("scan the engagement");
    await waitFor(() => harness.children.length === 1);
    expect(harness.children).toHaveLength(1);
    harness.children[0]?.finish();
    await waitFor(() => harness.children.length === 2);
  });

  it("publishes a campaign snapshot on the manager runtime extra", async () => {
    const harness = ports();
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, FLEET);
    const session = await client.createSession(
      {
        provider: "security",
        cwd: "/tmp/repo",
        model: "grok/grok-4.6",
      },
      PARENT_LAUNCH,
    );
    const snapshots: unknown[] = [];
    session.subscribe((event) => {
      if (event.type === "model_changed") {
        snapshots.push(event.runtimeInfo.extra?.campaign);
      }
    });
    await session.startTurn("scan the engagement");
    await waitFor(() => snapshots.some(campaignComplete));
    const last = snapshots.at(-1);
    expect(campaignComplete(last)).toBe(true);
    expect(last).toMatchObject({ total: 2, pace: "quiet", complete: true });
  });
});

function campaignComplete(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { complete?: boolean }).complete);
}
