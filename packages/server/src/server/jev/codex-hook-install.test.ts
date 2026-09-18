import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CODEX_JEV_HOOK_MARKER,
  installCodexJevPostToolHook,
  uninstallCodexJevPostToolHook,
} from "./codex-hook-install.js";

describe("installCodexJevPostToolHook", () => {
  it("writes a gated PostToolUse command and stays idempotent", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "jev-codex-hooks-"));
    const first = installCodexJevPostToolHook({ homeDir });
    const second = installCodexJevPostToolHook({ homeDir });
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    const raw = readFileSync(first.configPath, "utf8");
    expect(raw).toContain(CODEX_JEV_HOOK_MARKER);
    expect(raw).toContain("PASEO_AGENT_ID");
    expect(raw).toContain("PASEO_JEV_TOOL_ADMISSION");
  });

  it("preserves unrelated hooks", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "jev-codex-hooks-"));
    const configPath = path.join(homeDir, ".codex", "hooks.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo stop" }] }],
          },
        },
        null,
        2,
      )}\n`,
    );
    // writeFileSync does not create dirs; install does via writePrivateFileAtomicSync
    const installed = installCodexJevPostToolHook({ homeDir });
    const parsed = JSON.parse(readFileSync(installed.configPath, "utf8")) as {
      hooks: { Stop: unknown[]; PostToolUse: unknown[] };
    };
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.PostToolUse.length).toBeGreaterThan(0);
    const removed = uninstallCodexJevPostToolHook({ homeDir });
    expect(removed.changed).toBe(true);
    const after = JSON.parse(readFileSync(removed.configPath, "utf8")) as {
      hooks: { Stop?: unknown[]; PostToolUse?: unknown[] };
    };
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.PostToolUse).toBeUndefined();
  });
});
