import { spawnSync } from "node:child_process";

export const PASEO_WEBAUTHN_KEYCHAIN_SUFFIX = "sh.paseo.desktop.webauthn";

export interface WebauthnAccountChoice {
  credentialId: string;
  displayName?: string;
  name?: string;
}

export interface ConfigureWebAuthnApp {
  configureWebAuthn(options: {
    touchID: { keychainAccessGroup: string; promptReason?: string };
  }): void;
}

export interface WebauthnSession {
  on(
    event: "select-webauthn-account",
    listener: (
      event: unknown,
      details: { relyingPartyId: string; accounts: WebauthnAccountChoice[] },
      callback: (credentialId?: string | null) => void,
    ) => void,
  ): void;
}

export function parseCodesignTeamId(output: string): string | null {
  const match = output.match(/^TeamIdentifier=(.+)$/m);
  const teamId = match?.[1]?.trim();
  if (!teamId || teamId === "not set") return null;
  return teamId;
}

export function webauthnKeychainAccessGroup(input: {
  explicit?: string;
  teamId?: string;
}): string | null {
  const explicit = input.explicit?.trim();
  if (explicit) return explicit;
  const teamId = input.teamId?.trim();
  if (!teamId) return null;
  return `${teamId}.${PASEO_WEBAUTHN_KEYCHAIN_SUFFIX}`;
}

export function webauthnAccountLabel(account: WebauthnAccountChoice): string {
  const displayName = account.displayName?.trim();
  if (displayName) return displayName;
  const name = account.name?.trim();
  if (name) return name;
  return account.credentialId;
}

export function credentialIdForWebauthnChoice(
  accounts: readonly WebauthnAccountChoice[],
  responseIndex: number,
): string | undefined {
  if (responseIndex < 0 || responseIndex >= accounts.length) return undefined;
  return accounts[responseIndex]?.credentialId;
}

export function readCodesignTeamId(
  execPath: string,
  run: typeof spawnSync = spawnSync,
): string | null {
  const result = run("/usr/bin/codesign", ["-dv", "--verbose=2", execPath], {
    encoding: "utf8",
  });
  return parseCodesignTeamId(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

export function enableMacosBrowserPasskeys(input: {
  platform: NodeJS.Platform;
  app: ConfigureWebAuthnApp;
  sessions: WebauthnSession[];
  execPath: string;
  env?: NodeJS.ProcessEnv;
  chooseAccount: (
    relyingPartyId: string,
    accounts: WebauthnAccountChoice[],
  ) => Promise<string | undefined>;
  logInfo: (message: string, meta?: Record<string, unknown>) => void;
  logWarn: (message: string, meta?: Record<string, unknown>) => void;
}): boolean {
  if (input.platform !== "darwin") return false;
  const group = webauthnKeychainAccessGroup({
    explicit: input.env?.PASEO_WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
    teamId: input.env?.PASEO_APPLE_TEAM_ID ?? readCodesignTeamId(input.execPath) ?? undefined,
  });
  if (!group) {
    input.logWarn(
      "[browser-webauthn] skipped Touch ID passkeys; no keychain access group (unsigned build or missing team id)",
    );
    return false;
  }
  try {
    input.app.configureWebAuthn({
      touchID: {
        keychainAccessGroup: group,
        promptReason: "use your passkey on $1",
      },
    });
  } catch (error) {
    input.logWarn("[browser-webauthn] configureWebAuthn failed", { error });
    return false;
  }
  for (const webauthnSession of input.sessions) {
    webauthnSession.on("select-webauthn-account", (_event, details, callback) => {
      void (async () => {
        try {
          if (details.accounts.length === 1) {
            callback(details.accounts[0]?.credentialId);
            return;
          }
          const chosen = await input.chooseAccount(details.relyingPartyId, details.accounts);
          callback(chosen);
        } catch (error) {
          input.logWarn("[browser-webauthn] account picker failed", { error });
          callback();
        }
      })();
    });
  }
  input.logInfo("[browser-webauthn] Touch ID platform authenticator enabled", {
    keychainAccessGroup: group,
  });
  return true;
}
