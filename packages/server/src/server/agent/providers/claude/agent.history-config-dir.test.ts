import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Claude history after a daemon restart", () => {
  test("reads the transcript from the provider CLAUDE_CONFIG_DIR", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "paseo-claude-history-"));
    cleanup.push(configDir);
    const cwd = "/tmp/behoerdenbriefe";
    const sessionId = "75118f93-5f03-402a-bd1c-824e857b1512";
    const projectDir = claudeProjectDirSync(cwd, { configDir });
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: "kuck dir mal handoff.md an" },
        cwd,
        sessionId,
      })}\n`,
      "utf8",
    );

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: configDir } },
      resolveBinary: () => Promise.resolve("/bin/claude"),
    });
    const session = await client.resumeSession(
      {
        provider: "claude",
        sessionId,
        metadata: { provider: "claude", cwd, model: "claude-haiku-4-5" },
      },
      { provider: "claude", cwd, model: "claude-haiku-4-5" },
    );

    const events = [];
    for await (const event of session.streamHistory()) events.push(event);
    expect(events).toEqual([
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({
          type: "user_message",
          text: "kuck dir mal handoff.md an",
        }),
      }),
    ]);
  });
});
