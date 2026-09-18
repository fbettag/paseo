import type { MutableJevConfig } from "@getpaseo/protocol/messages";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { JevClient, resolveJevApiKey } from "./client.js";
import { resolveJevConfig } from "./defaults.js";

export class DaemonConfigJevPolicy {
  public constructor(private readonly configStore: Pick<DaemonConfigStore, "get">) {}

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
    if (!this.compactEnabled()) return undefined;
    const snapshot = this.snapshot();
    const env: Record<string, string> = {
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1",
    };
    if (snapshot.baseUrl) env.PASEO_JEV_BASE_URL = snapshot.baseUrl;
    if (snapshot.apiKeyFile) env.TYPESAFE_API_KEY_FILE = snapshot.apiKeyFile;
    return env;
  }

  public createClient(): JevClient | null {
    if (!this.isEnabled()) return null;
    const snapshot = this.snapshot();
    try {
      return new JevClient({
        baseUrl: snapshot.baseUrl,
        apiKeyFile: snapshot.apiKeyFile,
      });
    } catch {
      return null;
    }
  }
}
