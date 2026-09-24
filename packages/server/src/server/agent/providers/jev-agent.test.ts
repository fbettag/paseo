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
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { JevAgentClient, type JevRouterPorts } from "./jev-agent.js";
import type { EnabledModel, RouteJudgment } from "../../jev/model-router.js";

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
  readonly switched: string[] = [];
  failStart?: string;

  constructor(readonly provider: string) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.failStart) {
      const message = this.failStart;
      this.failStart = undefined;
      throw new Error(message);
    }
    this.prompts.push(typeof prompt === "string" ? prompt : "");
    return { turnId: `turn-${this.prompts.length}` };
  }

  subscribe(): () => void {
    return () => undefined;
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: "inner" };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
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

  async setModel(modelId: string | null): Promise<void> {
    if (modelId) this.switched.push(modelId);
  }

  async listCommands() {
    return [{ name: "goal", description: "Set the goal", argumentHint: "<objective>" }];
  }

  tryHandleOutOfBand(prompt: AgentPromptInput) {
    return typeof prompt === "string" && prompt.startsWith("/goal")
      ? { run: async () => undefined }
      : null;
  }
}

const MODELS: EnabledModel[] = [
  {
    providerId: "codex",
    providerLabel: "Codex",
    modelId: "gpt-5.4",
    label: "GPT-5.4",
  },
  {
    providerId: "codex-work",
    providerLabel: "Codex Work",
    modelId: "gpt-daybreak-blue-latest",
    label: "Daybreak",
    description: "cybersecurity",
  },
  {
    providerId: "glm",
    providerLabel: "GLM",
    modelId: "glm-5.3",
    label: "GLM 5.3",
    isDefault: true,
  },
  {
    providerId: "glm",
    providerLabel: "GLM",
    modelId: "glm-5.3-flash",
    label: "GLM Flash",
  },
];

function ports(
  judge: (prompt: string) => Promise<RouteJudgment | null>,
  blocked: ReadonlySet<string> = new Set(),
): {
  ports: JevRouterPorts;
  opened: Array<{ providerId: string; model?: string }>;
  sessions: FakeSession[];
} {
  const opened: Array<{ providerId: string; model?: string }> = [];
  const resumed: Array<{
    providerId: string;
    config: Partial<AgentSessionConfig>;
    handle: AgentPersistenceHandle;
  }> = [];
  const sessions: FakeSession[] = [];
  return {
    opened,
    resumed,
    sessions,
    ports: {
      listCandidates: () => Promise.resolve(MODELS),
      judge,
      openSession: (providerId, config) => {
        opened.push({ providerId, model: config.model });
        const session = new FakeSession(providerId);
        sessions.push(session);
        return Promise.resolve(session);
      },
      resumeSession: (providerId, handle, config) => {
        resumed.push({ providerId, handle, config });
        return Promise.resolve(new FakeSession(providerId));
      },
      blockedProviders: () => Promise.resolve(blocked),
    },
  };
}

describe("JevAgentClient", () => {
  it("opens the daybreak provider for heavy cybersecurity and keeps that session", async () => {
    const harness = ports(async () => ({
      kind: "cyber_heavy",
      complexity: 0.9,
      capability: 0.9,
      deepReasoning: 0.8,
    }));
    const client = new JevAgentClient(createTestLogger(), harness.ports);
    const catalog = await client.fetchCatalog({ scope: "global", force: false });
    expect(catalog.models.map((model) => model.id)).toEqual(["auto"]);
    expect(catalog.models[0]?.label).toBe("Jev");
    expect(catalog.models[0]?.defaultThinkingOptionId).toBe("auto");
    expect(catalog.models[0]?.thinkingOptions?.map((option) => option.id)).toEqual([
      "auto",
      "low",
      "medium",
      "high",
    ]);

    const session = await client.createSession({
      provider: "jev",
      cwd: "/tmp/repo",
      model: "auto",
    });
    const notices: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "notification") {
        notices.push(event.item.message);
      }
    });
    await session.startTurn("trace this exploit chain");
    await session.startTurn("and check the next hop");

    expect(harness.opened).toEqual([
      { providerId: "codex-work", model: "gpt-daybreak-blue-latest" },
    ]);
    expect(harness.sessions[0]?.prompts).toEqual([
      "trace this exploit chain",
      "and check the next hop",
    ]);
    expect(notices).toEqual(["Jev · Codex Work · Daybreak"]);
    const info = await session.getRuntimeInfo();
    expect(info).toMatchObject({
      provider: "jev",
      model: "auto",
      extra: { routedProvider: "codex-work", routedModel: "gpt-daybreak-blue-latest" },
    });
  });

  it("uses a flash model when the judgment is quick", async () => {
    const harness = ports(async () => ({
      kind: "quick",
      complexity: 0.1,
      capability: 0.1,
      deepReasoning: 0,
    }));
    const client = new JevAgentClient(createTestLogger(), harness.ports);
    const session = await client.createSession({ provider: "jev", cwd: "/tmp/repo" });
    await session.startTurn("typo");
    expect(harness.opened).toEqual([{ providerId: "glm", model: "glm-5.3-flash" }]);
  });

  it("opens another provider when the current account is out of usage", async () => {
    let blocked = new Set<string>();
    const harness = ports(async () => ({
      kind: "cyber_heavy",
      complexity: 0.9,
      capability: 0.9,
      deepReasoning: 0.8,
    }));
    harness.ports.blockedProviders = () => Promise.resolve(blocked);
    const client = new JevAgentClient(createTestLogger(), harness.ports);
    const session = await client.createSession({ provider: "jev", cwd: "/tmp/repo" });
    const notices: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "notification") {
        notices.push(event.item.message);
      }
    });
    await session.startTurn("trace this exploit");
    blocked = new Set(["codex-work"]);
    await session.startTurn("continue the exploit trace");
    expect(harness.opened.map((opened) => opened.providerId)).toEqual(["codex-work", "glm"]);
    expect(notices[1]).toContain("previous account unavailable");
    expect(harness.sessions[0]?.prompts).toEqual(["trace this exploit"]);
    expect(harness.sessions[1]?.prompts).toEqual(["continue the exploit trace"]);
  });

  it("opens another account when the harness rejects the model", async () => {
    const harness = ports(async () => ({
      kind: "coding",
      complexity: 0.6,
      capability: 0.6,
      deepReasoning: 0.2,
    }));
    const original = harness.ports.openSession;
    harness.ports.openSession = async (providerId, config, launchContext, options) => {
      const session = await original(providerId, config, launchContext, options);
      if (providerId === "glm") {
        (session as FakeSession).failStart = "unrecognized_model glm-5.3";
      }
      return session;
    };
    const client = new JevAgentClient(createTestLogger(), harness.ports);
    const session = await client.createSession({ provider: "jev", cwd: "/tmp/repo" });
    const notices: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "notification") {
        notices.push(event.item.message);
      }
    });
    await session.startTurn("build the collector");
    expect(harness.opened[0]).toEqual({ providerId: "glm", model: "glm-5.3" });
    expect(harness.opened[1]?.providerId).not.toBe("glm");
    expect(notices.some((line) => line.includes("did not start"))).toBe(true);
  });

  it("keeps the opened model so the provider cache stays warm", async () => {
    let calls = 0;
    const harness = ports(async () => {
      calls += 1;
      return calls === 1
        ? { kind: "coding", complexity: 0.8, capability: 0.8, deepReasoning: 0.4 }
        : { kind: "quick", complexity: 0.1, capability: 0.1, deepReasoning: 0.1 };
    });
    const client = new JevAgentClient(createTestLogger(), harness.ports);
    const session = await client.createSession({ provider: "jev", cwd: "/tmp/repo" });
    await session.startTurn("build the collector and keep it running");
    const opened = harness.opened[0]?.model;
    await session.startTurn("continue");
    expect(harness.opened).toHaveLength(1);
    expect(harness.sessions[0]?.switched).toEqual([]);
    expect(harness.opened[0]?.model).toBe(opened);
    expect(calls).toBe(1);
  });

  it("lists and runs the inner harness commands", async () => {
    const harness = ports(async () => ({
      kind: "coding",
      complexity: 0.6,
      capability: 0.6,
      deepReasoning: 0.2,
    }));
    const client = new JevAgentClient(createTestLogger(), harness.ports);
    const session = await client.createSession({ provider: "jev", cwd: "/tmp/repo" });
    await session.startTurn("build the collector");
    await expect(session.listCommands?.()).resolves.toEqual([
      { name: "goal", description: "Set the goal", argumentHint: "<objective>" },
    ]);
    expect(session.tryHandleOutOfBand?.("/goal ship the collector")).toEqual({
      run: expect.any(Function),
    });
  });

  it("judges continue against the earlier task", async () => {
    const seen: string[] = [];
    const harness = ports(async (prompt) => {
      seen.push(prompt);
      return { kind: "quick", complexity: 0.1, capability: 0.1, deepReasoning: 0.1 };
    });
    const client = new JevAgentClient(createTestLogger(), harness.ports);
    const session = await client.createSession({ provider: "jev", cwd: "/tmp/repo" });
    await session.startTurn("redesign the authentication threat model across the services");
    await session.startTurn("continue");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("authentication");
  });

  it("resumes Claude with the routed model", async () => {
    const harness = ports(async () => null);
    harness.ports.listProviderModes = () =>
      Promise.resolve({
        claude: [{ id: "default" }, { id: "auto" }, { id: "bypassPermissions" }],
      });
    const client = new JevAgentClient(createTestLogger(), harness.ports);
    await client.resumeSession(
      {
        provider: "jev",
        sessionId: "claude-session",
        metadata: {
          routedProvider: "claude",
          routedModel: "claude-haiku-4-5",
          routedLabel: "Haiku 4.5",
          providerLabel: "Claude",
          inner: {
            provider: "claude",
            sessionId: "claude-session",
            metadata: {
              cwd: "/tmp/repo",
              model: "auto",
              modeId: "auto",
              inner: {
                provider: "claude",
                sessionId: "claude-session",
                metadata: { cwd: "/tmp/repo", model: "claude-haiku-4-5" },
              },
            },
          },
        },
      },
      { provider: "jev", cwd: "/tmp/repo", model: "auto", modeId: "bypass" },
    );

    expect(harness.resumed).toEqual([
      {
        providerId: "claude",
        config: { cwd: "/tmp/repo", modeId: "bypassPermissions" },
        handle: {
          provider: "claude",
          sessionId: "claude-session",
          metadata: { cwd: "/tmp/repo", model: "claude-haiku-4-5" },
        },
      },
    ]);
  });
});
