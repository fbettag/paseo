import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { resolveClaudeHistoryConfigDir } from "./project-dir.js";

describe("resolveClaudeHistoryConfigDir", () => {
  test("uses the provider directory ahead of the daemon process", () => {
    expect(
      resolveClaudeHistoryConfigDir({
        providerEnv: { CLAUDE_CONFIG_DIR: "/Users/fbettag/.claude-paseo" },
        processEnv: { CLAUDE_CONFIG_DIR: "/Users/fbettag/.claude" },
      }),
    ).toBe("/Users/fbettag/.claude-paseo");
  });

  test("lets a launch override win over the provider directory", () => {
    expect(
      resolveClaudeHistoryConfigDir({
        launchEnv: { CLAUDE_CONFIG_DIR: "/tmp/launch-claude" },
        providerEnv: { CLAUDE_CONFIG_DIR: "/Users/fbettag/.claude-paseo" },
      }),
    ).toBe("/tmp/launch-claude");
  });

  test("falls back to the home Claude directory", () => {
    expect(resolveClaudeHistoryConfigDir({ processEnv: {} })).toBe(join(homedir(), ".claude"));
  });
});
