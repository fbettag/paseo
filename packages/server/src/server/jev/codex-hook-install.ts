import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writePrivateFileAtomicSync } from "../private-files.js";
import { CODEX_JEV_HOOK_EVENT } from "./codex-post-tool-hook.js";

export const CODEX_JEV_HOOK_MARKER = "hooks jev";

export interface CodexJevHookInstallOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface CodexJevHookInstallResult {
  configPath: string;
  changed: boolean;
}

interface CodexHooksFile {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveCodexHooksPath(options: CodexJevHookInstallOptions): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const configDir = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  return path.join(configDir, "hooks.json");
}

function parseHooksFile(raw: string): CodexHooksFile {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringifyHooksFile(config: CodexHooksFile): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function matcherGroups(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function commandHooks(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function commandContainsMarker(value: unknown): boolean {
  return typeof value === "string" && value.includes(CODEX_JEV_HOOK_MARKER);
}

function groupHasJevHook(group: Record<string, unknown>): boolean {
  return commandHooks(group.hooks).some(
    (hook) =>
      commandContainsMarker(hook.command) ||
      commandContainsMarker(hook.commandWindows) ||
      commandContainsMarker(hook.command_windows),
  );
}

function removeJevHooks(value: unknown): Record<string, unknown>[] {
  const kept: Record<string, unknown>[] = [];
  for (const group of matcherGroups(value)) {
    const hooks = commandHooks(group.hooks).filter(
      (hook) =>
        !commandContainsMarker(hook.command) &&
        !commandContainsMarker(hook.commandWindows) &&
        !commandContainsMarker(hook.command_windows),
    );
    if (hooks.length > 0) {
      kept.push({ ...group, hooks });
    }
  }
  return kept;
}

function jevPostToolGroup(): Record<string, unknown> {
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `if [ -n "$PASEO_AGENT_ID" ] && [ "$PASEO_JEV_TOOL_ADMISSION" = "1" ]; then "\${PASEO_HOOK_CLI:-paseo}" ${CODEX_JEV_HOOK_MARKER} ${CODEX_JEV_HOOK_EVENT}; fi`,
        commandWindows: `if defined PASEO_AGENT_ID if "%PASEO_JEV_TOOL_ADMISSION%"=="1" (if defined PASEO_HOOK_CLI ("%PASEO_HOOK_CLI%" ${CODEX_JEV_HOOK_MARKER} ${CODEX_JEV_HOOK_EVENT}) else (paseo ${CODEX_JEV_HOOK_MARKER} ${CODEX_JEV_HOOK_EVENT}))`,
        timeout: 20,
        statusMessage: "Jev tool admission",
      },
    ],
  };
}

export function installCodexJevPostToolHook(
  options: CodexJevHookInstallOptions = {},
): CodexJevHookInstallResult {
  const configPath = resolveCodexHooksPath(options);
  const currentRaw = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const current = currentRaw === null ? {} : parseHooksFile(currentRaw);
  const hooks = isRecord(current.hooks) ? { ...current.hooks } : {};
  const existing = matcherGroups(hooks[CODEX_JEV_HOOK_EVENT]);
  if (existing.some(groupHasJevHook)) {
    return { configPath, changed: false };
  }
  hooks[CODEX_JEV_HOOK_EVENT] = [
    ...removeJevHooks(hooks[CODEX_JEV_HOOK_EVENT]),
    jevPostToolGroup(),
  ];
  const next = stringifyHooksFile({ ...current, hooks });
  writePrivateFileAtomicSync(configPath, next);
  return { configPath, changed: true };
}

export function uninstallCodexJevPostToolHook(
  options: CodexJevHookInstallOptions = {},
): CodexJevHookInstallResult {
  const configPath = resolveCodexHooksPath(options);
  if (!existsSync(configPath)) {
    return { configPath, changed: false };
  }
  const currentRaw = readFileSync(configPath, "utf8");
  const current = parseHooksFile(currentRaw);
  const hooks = isRecord(current.hooks) ? { ...current.hooks } : {};
  const nextGroups = removeJevHooks(hooks[CODEX_JEV_HOOK_EVENT]);
  if (nextGroups.length > 0) {
    hooks[CODEX_JEV_HOOK_EVENT] = nextGroups;
  } else {
    delete hooks[CODEX_JEV_HOOK_EVENT];
  }
  const next = stringifyHooksFile({ ...current, hooks });
  if (next === (currentRaw.endsWith("\n") ? currentRaw : `${currentRaw}\n`)) {
    return { configPath, changed: false };
  }
  writePrivateFileAtomicSync(configPath, next);
  return { configPath, changed: true };
}
