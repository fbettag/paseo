import { describe, expect, it } from "vitest";

import { handleCodexJevPostToolHook, toolResponseText } from "./codex-post-tool-hook.js";
import { JevClient } from "./client.js";

const env = {
  PASEO_AGENT_ID: "agent-1",
  PASEO_JEV_TOOL_ADMISSION: "1",
};

function event(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "rg foo" },
    tool_response: "x".repeat(400),
    ...overrides,
  });
}

function clientWithNoul(noul: number) {
  return new JevClient({
    apiKey: "test-key",
    fetch: (async () =>
      new Response(JSON.stringify({ answers: { keepResult: { noul } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
}

describe("handleCodexJevPostToolHook", () => {
  it("extracts shell output text", () => {
    expect(toolResponseText({ output: "hello" })).toBe("hello");
    expect(toolResponseText("raw")).toBe("raw");
  });

  it("no-ops without Paseo agent env", async () => {
    await expect(
      handleCodexJevPostToolHook({
        event: "PostToolUse",
        stdin: event(),
        env: {},
        client: clientWithNoul(0),
      }),
    ).resolves.toBeNull();
  });

  it("no-ops for other events", async () => {
    await expect(
      handleCodexJevPostToolHook({
        event: "PreToolUse",
        stdin: event(),
        env,
        client: clientWithNoul(0),
      }),
    ).resolves.toBeNull();
  });

  it("keeps long results that Jev wants", async () => {
    await expect(
      handleCodexJevPostToolHook({
        event: "PostToolUse",
        stdin: event(),
        env,
        client: clientWithNoul(0.9),
      }),
    ).resolves.toBeNull();
  });

  it("replaces long results that Jev drops", async () => {
    const stdout = await handleCodexJevPostToolHook({
      event: "PostToolUse",
      stdin: event(),
      env,
      client: clientWithNoul(0.1),
    });
    expect(stdout).toBeTruthy();
    const parsed = JSON.parse(stdout ?? "{}") as {
      decision: string;
      reason: string;
      hookSpecificOutput: { hookEventName: string };
    };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("omitted by Jev");
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  });
});
