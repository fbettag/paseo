import type { MutableDaemonConfig, MutableJevConfig } from "@getpaseo/protocol/messages";

export const JEV_TITLE = "Jev";
export const JEV_WARNING =
  "Use TypeSafe Jev for lossless transcript compaction, Paseo tool-result admission, and optional browser action selection. Reads TYPESAFE_API_KEY or TYPESAFE_API_KEY_FILE; never store the key in Paseo config.";

export interface JevCardState {
  isVisible: boolean;
  enabled: boolean;
  compact: boolean;
  toolAdmission: boolean;
  browserPolicy: boolean;
  title: string;
  warning: string;
}

export interface JevMutationViewState {
  isSwitchDisabled: boolean;
  loadingText: string | null;
  errorText: string | null;
}

const DEFAULTS: MutableJevConfig = {
  enabled: false,
  compact: true,
  toolAdmission: true,
  browserPolicy: false,
};

export function getJevCardState(input: {
  isConnected: boolean;
  config: MutableDaemonConfig | null;
}): JevCardState {
  const jev = input.config?.jev;
  return {
    isVisible: input.isConnected,
    enabled: jev?.enabled === true,
    compact: jev?.compact !== false,
    toolAdmission: jev?.toolAdmission !== false,
    browserPolicy: jev?.browserPolicy === true,
    title: JEV_TITLE,
    warning: JEV_WARNING,
  };
}

export function createJevPatch(patch: Partial<MutableJevConfig>): Partial<MutableDaemonConfig> {
  return {
    jev: {
      ...DEFAULTS,
      ...patch,
    },
  };
}

export function getJevMutationViewState(input: {
  isPending: boolean;
  error: unknown;
}): JevMutationViewState {
  return {
    isSwitchDisabled: input.isPending,
    loadingText: input.isPending ? "Updating Jev…" : null,
    errorText: input.error ? toErrorMessage(input.error) : null,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
