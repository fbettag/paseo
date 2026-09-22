import type { Logger } from "pino";
import { CodexQuotaProvider } from "./providers/codex.js";
import type { ProviderApiFetch } from "./provider.js";

interface CodexProviderConfig {
  extends?: unknown;
  env?: unknown;
  label?: unknown;
  enabled?: unknown;
}

export function extraCodexUsageFetchers(
  providers: Record<string, CodexProviderConfig> | undefined,
  options: { logger: Logger; fetch?: ProviderApiFetch },
): CodexQuotaProvider[] {
  if (!providers) return [];
  const fetchers: CodexQuotaProvider[] = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    if (providerId === "codex" || provider.enabled === false || provider.extends !== "codex") {
      continue;
    }
    const home = codexHome(provider.env);
    if (!home) continue;
    fetchers.push(
      new CodexQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
        codexHome: home,
        providerId,
        displayName: typeof provider.label === "string" ? provider.label : providerId,
      }),
    );
  }
  return fetchers;
}

function codexHome(env: unknown): string | null {
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  const home = (env as Record<string, unknown>).CODEX_HOME;
  if (typeof home !== "string") return null;
  const trimmed = home.trim();
  return trimmed.length > 0 ? trimmed : null;
}
