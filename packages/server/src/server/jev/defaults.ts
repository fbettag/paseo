import type { MutableJevConfig } from "@getpaseo/protocol/messages";

export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_API_KEY_FILE = "/run/secrets/typesafe-api-key";

export const DEFAULT_JEV_CONFIG: MutableJevConfig = {
  enabled: false,
  compact: true,
  toolAdmission: true,
  browserPolicy: false,
};

export function resolveJevConfig(
  jev:
    | {
        enabled?: boolean;
        compact?: boolean;
        toolAdmission?: boolean;
        browserPolicy?: boolean;
        baseUrl?: string;
        apiKeyFile?: string;
      }
    | undefined,
): MutableJevConfig {
  return {
    enabled: jev?.enabled ?? DEFAULT_JEV_CONFIG.enabled,
    compact: jev?.compact ?? DEFAULT_JEV_CONFIG.compact,
    toolAdmission: jev?.toolAdmission ?? DEFAULT_JEV_CONFIG.toolAdmission,
    browserPolicy: jev?.browserPolicy ?? DEFAULT_JEV_CONFIG.browserPolicy,
    ...(jev?.baseUrl ? { baseUrl: jev.baseUrl } : {}),
    ...(jev?.apiKeyFile ? { apiKeyFile: jev.apiKeyFile } : {}),
  };
}
