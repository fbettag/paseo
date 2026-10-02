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

  constructor(
    readonly provider: string,
    readonly model: string | undefined,
    readonly internal: boolean,
    private readonly runError?: Error,
  ) {}

  async run(prompt: AgentPromptInput): Promise<AgentRunResult> {
    this.prompts.push(typeof prompt === "string" ? prompt : "");
    if (this.runError) throw this.runError;
    return { sessionId: this.id, finalText: "done", timeline: [] };
  }

  async startTurn(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    this.prompts.push(typeof prompt === "string" ? prompt : "");
    return { turnId: `turn-${this.prompts.length}` };
  }

  subscribe(): () => void {
    return () => undefined;
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
  options: { holdWorkers?: boolean } = {},
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
      createChildAgent: (input) => createFakeChild(input, children, runErrors, options.holdWorkers),
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
    },
    interrupt: async () => undefined,
  });
}

const PARENT_LAUNCH = { agentId: "security-parent" };

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
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, { usageWaitMs: 0 });
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
      usageWaitMs: 0,
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
      usageWaitMs: 0,
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
      usageWaitMs: 0,
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
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, {
      usageWaitMs: 0,
    });
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

  it("forwards a later user turn to live workers", async () => {
    const harness = ports(new Set(), {}, { holdWorkers: true });
    const client = new SecurityAgentClient(createTestLogger(), harness.ports, { usageWaitMs: 0 });
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
    expect(notices.some((line) => line.includes("forwarding follow-up"))).toBe(true);
    for (const child of harness.children) child.finish();
    await waitFor(() => noticesInclude(notices, "completed"));
  });
});
