import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  JEV_WARNING,
  createJevPatch,
  getJevCardState,
  getJevMutationViewState,
} from "./jev-config";

function makeConfig(jev?: MutableDaemonConfig["jev"]): MutableDaemonConfig {
  return {
    relay: { enabled: false },
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    jev,
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  };
}

describe("Jev settings card", () => {
  it("shows the card when connected", () => {
    expect(getJevCardState({ isConnected: true, config: makeConfig() })).toEqual({
      isVisible: true,
      enabled: false,
      compact: true,
      toolAdmission: true,
      browserPolicy: false,
      title: "Jev",
      warning: JEV_WARNING,
    });
  });

  it("reads enabled flags from daemon config", () => {
    expect(
      getJevCardState({
        isConnected: true,
        config: makeConfig({
          enabled: true,
          compact: false,
          toolAdmission: true,
          browserPolicy: true,
        }),
      }),
    ).toMatchObject({
      enabled: true,
      compact: false,
      toolAdmission: true,
      browserPolicy: true,
    });
  });

  it("hides the card when the host is disconnected", () => {
    expect(
      getJevCardState({
        isConnected: false,
        config: makeConfig({
          enabled: true,
          compact: true,
          toolAdmission: true,
          browserPolicy: false,
        }),
      }),
    ).toMatchObject({ isVisible: false });
  });

  it("writes daemon.jev when toggled", () => {
    expect(createJevPatch({ enabled: true })).toEqual({
      jev: {
        enabled: true,
        compact: true,
        toolAdmission: true,
        browserPolicy: false,
      },
    });
  });

  it("shows loading while Jev settings save", () => {
    expect(getJevMutationViewState({ isPending: true, error: null })).toEqual({
      isSwitchDisabled: true,
      loadingText: "Updating Jev…",
      errorText: null,
    });
  });
});
