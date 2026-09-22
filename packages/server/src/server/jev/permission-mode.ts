export const JEV_PERMISSION_MODES = [
  {
    id: "ask",
    label: "Always Ask",
    description: "The chosen provider asks before tools run.",
  },
  {
    id: "auto",
    label: "Auto",
    description: "The chosen provider reviews ordinary permission prompts itself.",
  },
  {
    id: "acceptEdits",
    label: "Accept File Edits",
    description: "File edits run without a prompt. Other tools still follow the provider.",
  },
  {
    id: "bypass",
    label: "Bypass",
    description: "Skip permission prompts on the chosen provider.",
  },
] as const;

export type JevPermissionMode = (typeof JEV_PERMISSION_MODES)[number]["id"];

const BYPASS_MODE_IDS = ["bypassPermissions", "full-access", "allow-all", "full", "yolo"];
const EDIT_MODE_IDS = ["acceptEdits", "write", "auto-review", "auto", "default"];
const AUTO_MODE_IDS = ["auto-review", "auto", "default"];
const ASK_MODE_IDS = ["default", "build", "plan", "auto"];

export function isJevPermissionMode(value: string | undefined): value is JevPermissionMode {
  return JEV_PERMISSION_MODES.some((mode) => mode.id === value);
}

export function mapJevPermissionMode(
  mode: string,
  providerModes: readonly { id: string }[],
): string | undefined {
  const ids = new Set(providerModes.map((entry) => entry.id));
  const first = (candidates: readonly string[]) => candidates.find((id) => ids.has(id));
  if (mode === "bypass") return first(BYPASS_MODE_IDS);
  if (mode === "acceptEdits") return first(EDIT_MODE_IDS);
  if (mode === "auto") return first(AUTO_MODE_IDS);
  if (mode === "ask") return first(ASK_MODE_IDS);
  if (ids.has(mode)) return mode;
  return undefined;
}
