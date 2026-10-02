import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import { startAgentRun } from "../agent/agent-prompt.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import { cancelAgentRunCommand } from "../agent/lifecycle-command.js";
import type { ChildAgentHandle, CreateChildAgentInput } from "../agent/providers/jev-agent.js";

export interface CreateChildAgentBindings {
  createAgent: BoundCreateAgentCommand;
  agentManager: AgentManager;
  logger: Logger;
}

export function bindCreateChildAgent(
  bindings: CreateChildAgentBindings,
): (input: CreateChildAgentInput) => Promise<ChildAgentHandle> {
  return (input) => spawnChildAgent(bindings, input);
}

async function spawnChildAgent(
  bindings: CreateChildAgentBindings,
  input: CreateChildAgentInput,
): Promise<ChildAgentHandle> {
  const result = await bindings.createAgent({
    kind: "mcp",
    provider: input.provider,
    title: input.title,
    initialPrompt: input.initialPrompt,
    cwd: input.cwd,
    mode: input.mode,
    config: input.systemPrompt ? { systemPrompt: input.systemPrompt } : undefined,
    background: true,
    notifyOnFinish: true,
    unattended: true,
    promptFailure: "throw",
    callerAgentId: input.callerAgentId,
  });
  const agentId = result.snapshot.id;
  return {
    agentId,
    waitForFinish: (signal) => waitForChildFinish(bindings, agentId, signal),
    prompt: async (text) => {
      await startAgentRun(bindings.agentManager, agentId, text, bindings.logger, {
        activeTurnBehavior: "steer",
        replaceRunning: true,
      });
    },
    interrupt: async () => {
      await cancelAgentRunCommand(
        { agentManager: bindings.agentManager, logger: bindings.logger },
        agentId,
      );
    },
  };
}

async function waitForChildFinish(
  bindings: CreateChildAgentBindings,
  agentId: string,
  signal?: AbortSignal,
): Promise<{ text: string }> {
  const wait = await bindings.agentManager.waitForAgentEvent(agentId, { signal });
  const text = wait.lastMessage ?? "";
  if (wait.permission) {
    throw new Error("Security worker is waiting for permission");
  }
  if (wait.status === "error") {
    throw new Error(text || "Security worker failed");
  }
  if (wait.status === "closed") {
    throw new Error(text || "Security worker closed");
  }
  return { text };
}
