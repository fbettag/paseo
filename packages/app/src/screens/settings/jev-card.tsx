import React, { useCallback } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { createJevPatch, getJevCardState, getJevMutationViewState } from "./jev-config";

export function JevSettingsCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const state = getJevCardState({ isConnected, config });
  const mutation = useMutation({
    mutationFn: async (patch: Parameters<typeof createJevPatch>[0]) => {
      const result = await patchConfig(
        createJevPatch({
          enabled: state.enabled,
          compact: state.compact,
          toolAdmission: state.toolAdmission,
          browserPolicy: state.browserPolicy,
          ...patch,
        }),
      );
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return result;
    },
  });
  const mutationView = getJevMutationViewState({
    isPending: mutation.isPending,
    error: mutation.error,
  });

  const handleEnabledChange = useCallback(
    (next: boolean) => {
      mutation.mutate({ enabled: next });
    },
    [mutation],
  );
  const handleCompactChange = useCallback(
    (next: boolean) => {
      mutation.mutate({ enabled: true, compact: next });
    },
    [mutation],
  );
  const handleAdmissionChange = useCallback(
    (next: boolean) => {
      mutation.mutate({ enabled: true, toolAdmission: next });
    },
    [mutation],
  );
  const handleBrowserChange = useCallback(
    (next: boolean) => {
      mutation.mutate({ enabled: true, browserPolicy: next });
    },
    [mutation],
  );

  if (!state.isVisible) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-jev-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{state.title}</Text>
          <Text style={settingsStyles.rowHint}>{state.warning}</Text>
          {mutationView.loadingText ? (
            <Text style={settingsStyles.rowHint} testID="host-page-jev-loading">
              {mutationView.loadingText}
            </Text>
          ) : null}
          {mutationView.errorText ? (
            <Text style={settingsStyles.rowError} testID="host-page-jev-error">
              {mutationView.errorText}
            </Text>
          ) : null}
        </View>
        <Switch
          value={state.enabled}
          onValueChange={handleEnabledChange}
          disabled={mutationView.isSwitchDisabled}
          accessibilityLabel="Enable Jev"
          testID="host-page-jev-switch"
        />
      </View>
      {state.enabled ? (
        <>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Compact transcripts</Text>
              <Text style={settingsStyles.rowHint}>
                Claude sessions keep verbatim history and drop stale tool calls instead of
                summarizing.
              </Text>
            </View>
            <Switch
              value={state.compact}
              onValueChange={handleCompactChange}
              disabled={mutationView.isSwitchDisabled}
              accessibilityLabel="Enable Jev transcript compaction"
              testID="host-page-jev-compact-switch"
            />
          </View>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Admit tool results</Text>
              <Text style={settingsStyles.rowHint}>
                Truncate Paseo, MCP, and browser tool output before it reaches Codex, Grok, Kimi, or
                Claude.
              </Text>
            </View>
            <Switch
              value={state.toolAdmission}
              onValueChange={handleAdmissionChange}
              disabled={mutationView.isSwitchDisabled}
              accessibilityLabel="Enable Jev tool-result admission"
              testID="host-page-jev-admission-switch"
            />
          </View>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Browser action policy</Text>
              <Text style={settingsStyles.rowHint}>
                Let Jev pick the next browser operation and target from a snapshot. Off until you
                opt in.
              </Text>
            </View>
            <Switch
              value={state.browserPolicy}
              onValueChange={handleBrowserChange}
              disabled={mutationView.isSwitchDisabled}
              accessibilityLabel="Enable Jev browser action policy"
              testID="host-page-jev-browser-switch"
            />
          </View>
        </>
      ) : null}
    </View>
  );
}
