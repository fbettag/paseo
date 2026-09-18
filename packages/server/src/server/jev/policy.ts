import type { MutableJevConfig } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";

import type { DaemonConfigStore } from "../daemon-config-store.js";
import { JevClient, noulAnswer, resolveJevApiKey } from "./client.js";
import { DEFAULT_JEV_BASE_URL, resolveJevConfig } from "./defaults.js";

export class DaemonConfigJevPolicy {
  private readonly logger?: Logger;

  public constructor(
    private readonly configStore: Pick<DaemonConfigStore, "get">,
    logger?: Logger,
  ) {
    this.logger = logger?.child({ module: "jev" });
  }

  public snapshot(): MutableJevConfig {
    return resolveJevConfig(this.configStore.get().jev);
  }

  public isEnabled(): boolean {
    return this.snapshot().enabled === true;
  }

  public compactEnabled(): boolean {
    const snapshot = this.snapshot();
    return snapshot.enabled === true && snapshot.compact !== false;
  }

  public toolAdmissionEnabled(): boolean {
    const snapshot = this.snapshot();
    return snapshot.enabled === true && snapshot.toolAdmission !== false;
  }

  public browserPolicyEnabled(): boolean {
    const snapshot = this.snapshot();
    return snapshot.enabled === true && snapshot.browserPolicy === true;
  }

  public hasApiKey(): boolean {
    const snapshot = this.snapshot();
    return resolveJevApiKey({ apiKeyFile: snapshot.apiKeyFile }) !== null;
  }

  public claudeLaunchEnv(): Record<string, string> | undefined {
    return this.launchEnv();
  }

  public launchEnv(): Record<string, string> | undefined {
    if (!this.isEnabled()) return undefined;
    const snapshot = this.snapshot();
    const env: Record<string, string> = {};
    if (this.compactEnabled()) {
      env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = "1";
    }
    if (snapshot.baseUrl) env.PASEO_JEV_BASE_URL = snapshot.baseUrl;
    if (snapshot.apiKeyFile) env.TYPESAFE_API_KEY_FILE = snapshot.apiKeyFile;
    return Object.keys(env).length > 0 ? env : undefined;
  }

  public createClient(): JevClient | null {
    if (!this.isEnabled()) return null;
    const snapshot = this.snapshot();
    try {
      return new JevClient({
        baseUrl: snapshot.baseUrl,
        apiKeyFile: snapshot.apiKeyFile,
        logger: this.logger,
      });
    } catch (error) {
      this.logger?.warn({ err: error }, "Jev client unavailable");
      return null;
    }
  }

  public reportStartup(): void {
    const snapshot = this.snapshot();
    const hasApiKey = this.hasApiKey();
    this.logger?.info(
      {
        enabled: snapshot.enabled === true,
        compact: snapshot.compact !== false,
        toolAdmission: snapshot.toolAdmission !== false,
        browserPolicy: snapshot.browserPolicy === true,
        hasApiKey,
        apiKeyFile: snapshot.apiKeyFile ?? null,
        baseUrl: snapshot.baseUrl ?? DEFAULT_JEV_BASE_URL,
        pluginPathConfigured: Boolean(process.env.PASEO_JEV_PLUGIN_PATH),
      },
      "Jev policy loaded",
    );
    if (snapshot.enabled === true && !hasApiKey) {
      this.logger?.warn(
        { apiKeyFile: snapshot.apiKeyFile ?? null },
        "Jev enabled without TypeSafe API key; failing open",
      );
      return;
    }
    if (snapshot.enabled !== true || !hasApiKey) return;
    const client = this.createClient();
    if (!client) return;
    void this.probeConnectivity(client);
  }

  private async probeConnectivity(client: JevClient): Promise<void> {
    try {
      const answers = await client.ask({
        state: { probe: "paseo-daemon-startup" },
        questions: {
          connected: {
            type: "noul",
            instructions: "Is this a live TypeSafe connectivity check from a Paseo daemon?",
          },
        },
      });
      this.logger?.info({ noul: noulAnswer(answers, "connected") }, "Jev startup probe succeeded");
    } catch (error) {
      this.logger?.warn({ err: error }, "Jev startup probe failed");
    }
  }
}
