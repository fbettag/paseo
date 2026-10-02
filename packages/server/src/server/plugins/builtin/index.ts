import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const builtinPlugins = [
  "antigravity-provider",
  "claude-usage-source",
  "codex-usage-source",
  "copilot-usage-source",
  "cursor-usage-source",
  "grok-usage-source",
  "kimi-usage-source",
  "minimax-usage-source",
  "muse-provider",
  "opencode-go-usage-source",
  "orcarouter-usage-source",
  "zai-usage-source",
] as const;

export function asarUnpackedAlternate(candidate: string): string | null {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  const index = candidate.indexOf(asarSegment);
  if (index === -1) return null;
  return path.join(
    candidate.slice(0, index),
    "app.asar.unpacked",
    candidate.slice(index + asarSegment.length),
  );
}

export function resolveBuiltinPluginsRoot(moduleUrl: string | URL = import.meta.url): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const bases = [
    path.resolve(moduleDir, "..", "..", "..", "builtin-plugins"),
    path.resolve(moduleDir, "..", "..", "..", "..", "..", "..", "plugins"),
  ];
  const candidates: string[] = [];
  for (const base of bases) {
    const unpacked = asarUnpackedAlternate(base);
    if (unpacked) candidates.push(unpacked);
    candidates.push(base);
  }
  const resolved = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  if (!resolved) {
    throw new Error("Could not resolve built-in plugin root");
  }
  return resolved;
}

export interface BuiltinPlugin {
  id: string;
  directory: string;
}

export class BuiltinPluginLoader {
  readonly ids: ReadonlySet<string>;

  constructor(
    private readonly root = resolveBuiltinPluginsRoot(),
    private readonly list: readonly string[] = builtinPlugins,
  ) {
    this.ids = new Set(list);
  }

  async load(start: (plugin: BuiltinPlugin) => Promise<void>): Promise<void> {
    for (const id of this.list) {
      await start({ id, directory: path.join(this.root, id) });
    }
  }
}
