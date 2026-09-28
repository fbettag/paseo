import { describe, expect, it, vi } from "vitest";

import {
  credentialIdForWebauthnChoice,
  enableMacosBrowserPasskeys,
  parseCodesignTeamId,
  webauthnAccountLabel,
  webauthnKeychainAccessGroup,
} from "./browser-webauthn.js";

describe("browser webauthn", () => {
  it("builds the keychain group from the signing team", () => {
    expect(parseCodesignTeamId("Executable=/app\nTeamIdentifier=ABCDE12345\n")).toBe("ABCDE12345");
    expect(webauthnKeychainAccessGroup({ teamId: "ABCDE12345" })).toBe(
      "ABCDE12345.sh.paseo.desktop.webauthn",
    );
    expect(
      webauthnKeychainAccessGroup({
        explicit: " TEAM.sh.paseo.desktop.webauthn ",
        teamId: "OTHER",
      }),
    ).toBe("TEAM.sh.paseo.desktop.webauthn");
  });

  it("picks a passkey account or cancels", () => {
    const accounts = [
      { credentialId: "one", displayName: "Ada", name: "ada@example.com" },
      { credentialId: "two", name: "bob@example.com" },
    ];
    expect(webauthnAccountLabel(accounts[0]!)).toBe("Ada");
    expect(webauthnAccountLabel(accounts[1]!)).toBe("bob@example.com");
    expect(credentialIdForWebauthnChoice(accounts, 1)).toBe("two");
    expect(credentialIdForWebauthnChoice(accounts, 2)).toBeUndefined();
  });

  it("configures Touch ID and auto-selects a single account", async () => {
    const configured: unknown[] = [];
    const callbacks: Array<string | null | undefined> = [];
    let listener:
      | ((
          event: unknown,
          details: { relyingPartyId: string; accounts: Array<{ credentialId: string }> },
          callback: (credentialId?: string | null) => void,
        ) => void)
      | undefined;
    const enabled = enableMacosBrowserPasskeys({
      platform: "darwin",
      app: {
        configureWebAuthn(options) {
          configured.push(options);
        },
      },
      sessions: [
        {
          on(_event, next) {
            listener = next;
          },
        },
      ],
      execPath: "/Applications/Paseo.app",
      env: { PASEO_APPLE_TEAM_ID: "ABCDE12345" },
      chooseAccount: async () => "should-not-run",
      logInfo: vi.fn(),
      logWarn: vi.fn(),
    });
    expect(enabled).toBe(true);
    expect(configured).toEqual([
      {
        touchID: {
          keychainAccessGroup: "ABCDE12345.sh.paseo.desktop.webauthn",
          promptReason: "use your passkey on $1",
        },
      },
    ]);
    listener?.({}, { relyingPartyId: "example.com", accounts: [{ credentialId: "only" }] }, (id) =>
      callbacks.push(id),
    );
    await Promise.resolve();
    expect(callbacks).toEqual(["only"]);
  });

  it("skips unsigned macOS builds without a team id", () => {
    const warn = vi.fn();
    expect(
      enableMacosBrowserPasskeys({
        platform: "darwin",
        app: { configureWebAuthn() {} },
        sessions: [],
        execPath: "/unsigned",
        env: {},
        chooseAccount: async () => undefined,
        logInfo: vi.fn(),
        logWarn: warn,
      }),
    ).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
