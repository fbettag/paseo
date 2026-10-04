import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  ComposerTrackPill,
  ComposerTrackRow,
  type ComposerTrackPillSegment,
} from "@/composer/tracks";
import { EditingTextInput } from "@/components/ui/text-input";
import { usePaneContext } from "@/panels/pane-context";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import {
  selectCampaignFindings,
  type CampaignFinding,
  type CampaignSnapshot,
  type CampaignWorkerSnapshot,
  type CampaignWorkerState,
} from "./campaign-snapshot";

export function CampaignTrack({
  snapshot,
  title,
  onOpenWorker,
}: {
  snapshot: CampaignSnapshot;
  title?: string | null;
  onOpenWorker: (agentId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { openFileInWorkspace } = usePaneContext();
  const [query, setQuery] = useState("");
  const [includePrior, setIncludePrior] = useState(false);
  const finished = snapshot.done + snapshot.skipped + snapshot.failed;
  const segments = useMemo((): ComposerTrackPillSegment[] => {
    const progress: ComposerTrackPillSegment = {
      bucket: campaignBucket(snapshot),
      text: t("security.campaign.progress", { done: finished, total: snapshot.total }),
    };
    if (snapshot.findingsCount === 0) return [progress];
    return [
      progress,
      {
        bucket: "attention",
        text: t("security.campaign.findings", { count: snapshot.findingsCount }),
      },
    ];
  }, [finished, snapshot, t]);
  const ratio = snapshot.total > 0 ? Math.min(1, finished / snapshot.total) : 0;
  const findings = useMemo(
    () => selectCampaignFindings(snapshot, { title, query, includePrior }),
    [includePrior, query, snapshot, title],
  );
  const priorCount = snapshot.findings.filter((finding) => finding.prior === true).length;

  const togglePrior = useCallback(() => {
    setIncludePrior((current) => !current);
  }, []);

  const handleOpenFinding = useCallback(
    (finding: CampaignFinding) => {
      openFileInWorkspace({
        location: { path: finding.relativePath },
        disposition: "preferred",
      });
    },
    [openFileInWorkspace],
  );

  return (
    <ComposerTrackPill
      testID="security-campaign-track"
      segments={segments}
      accessibilityLabel={t("security.campaign.title")}
      panelTitle={t("security.campaign.title")}
    >
      <View style={styles.progressBlock} testID="security-campaign-progress">
        <View style={styles.progressTrack}>
          <CampaignProgressFill ratio={ratio} />
        </View>
        <Text style={styles.progressLabel}>
          {t("security.campaign.progress", { done: finished, total: snapshot.total })}
        </Text>
      </View>
      {snapshot.workers.map((worker) => (
        <CampaignWorkerRow key={worker.key} worker={worker} onOpenWorker={onOpenWorker} />
      ))}
      <EditingTextInput
        initialValue=""
        onChangeText={setQuery}
        placeholder={t("security.campaign.search")}
        placeholderTextColor={styles.searchPlaceholder.color}
        style={styles.search}
        testID="security-campaign-search"
      />
      {priorCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={togglePrior}
          style={styles.priorToggle}
          testID="security-campaign-prior"
        >
          <Text style={styles.rowTrailing}>
            {includePrior
              ? t("security.campaign.hideEarlier")
              : t("security.campaign.showEarlier", { count: priorCount })}
          </Text>
        </Pressable>
      ) : null}
      {findings.length === 0 ? (
        <Text style={styles.empty}>{t("security.campaign.emptyFindings")}</Text>
      ) : (
        findings.map((finding) => (
          <CampaignFindingRow
            key={finding.relativePath}
            finding={finding}
            onOpenFinding={handleOpenFinding}
          />
        ))
      )}
    </ComposerTrackPill>
  );
}

function CampaignWorkerRow({
  worker,
  onOpenWorker,
}: {
  worker: CampaignWorkerSnapshot;
  onOpenWorker: (agentId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const label = `${worker.providerId}/${worker.modelId} #${worker.replica}`;
  const agentId = worker.agentId;
  const handlePress = useCallback(() => {
    if (agentId) onOpenWorker(agentId);
  }, [agentId, onOpenWorker]);
  return (
    <ComposerTrackRow
      testID={`security-campaign-worker-${worker.key}`}
      accessibilityLabel={t("security.campaign.openWorker", { label })}
      onPress={agentId ? handlePress : undefined}
    >
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.rowTrailing}>{workerStateLabel(t, worker)}</Text>
    </ComposerTrackRow>
  );
}

function CampaignFindingRow({
  finding,
  onOpenFinding,
}: {
  finding: CampaignFinding;
  onOpenFinding: (finding: CampaignFinding) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onOpenFinding(finding);
  }, [finding, onOpenFinding]);
  return (
    <ComposerTrackRow
      testID={`security-campaign-finding-${finding.relativePath}`}
      accessibilityLabel={t("security.campaign.openFinding", { title: finding.title })}
      onPress={handlePress}
    >
      {({ active }) => (
        <View style={styles.findingBody}>
          <Text style={active ? styles.findingTitleActive : styles.findingTitle} numberOfLines={1}>
            {finding.title}
          </Text>
          {finding.providerId || finding.modelId ? (
            <Text style={styles.findingSummary} numberOfLines={1}>
              {[finding.providerId, finding.modelId].filter(Boolean).join("/")}
            </Text>
          ) : null}
          {finding.chain ? (
            <Text style={styles.findingSummary} numberOfLines={2}>
              {t("security.campaign.chain", { chain: finding.chain })}
            </Text>
          ) : null}
          {finding.alsoFoundBy && finding.alsoFoundBy.length > 0 ? (
            <Text style={styles.findingSummary} numberOfLines={1}>
              {t("security.campaign.also", { models: alsoFoundLabel(finding) })}
            </Text>
          ) : null}
          {finding.summary ? (
            <Text style={styles.findingSummary} numberOfLines={2}>
              {finding.summary}
            </Text>
          ) : null}
        </View>
      )}
    </ComposerTrackRow>
  );
}

function CampaignProgressFill({ ratio }: { ratio: number }): ReactElement {
  const width: `${number}%` = `${Math.round(ratio * 100)}%`;
  const fillStyle = useMemo(() => [styles.progressFill, { width }], [width]);
  return <View style={fillStyle} />;
}

function alsoFoundLabel(finding: CampaignFinding): string {
  return (finding.alsoFoundBy ?? [])
    .map((item) => [item.providerId, item.modelId].filter(Boolean).join("/") || item.relativePath)
    .join(", ");
}

function campaignBucket(snapshot: CampaignSnapshot): SidebarStateBucket | null {
  if (snapshot.failed > 0) return "failed";
  if (snapshot.running > 0) return "running";
  if (snapshot.complete) return "done";
  return null;
}

function workerStateLabel(t: (key: string) => string, worker: CampaignWorkerSnapshot): string {
  return t(stateKey(worker.state, worker.error));
}

function stateKey(state: CampaignWorkerState, error?: string): string {
  if (state === "queued") return "security.campaign.queued";
  if (state === "running") return "security.campaign.running";
  if (state === "completed") return "security.campaign.completed";
  if (state === "failed") return "security.campaign.failed";
  if (error === "free") return "security.campaign.skippedFree";
  if (error === "credits") return "security.campaign.skippedCredits";
  return "security.campaign.skippedUsage";
}

const styles = StyleSheet.create((theme) => ({
  progressBlock: {
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: theme.colors.border,
  },
  progressFill: {
    height: 4,
    backgroundColor: theme.colors.accent,
  },
  progressLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  rowTrailing: {
    flexShrink: 2,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  search: {
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  searchPlaceholder: {
    color: theme.colors.foregroundMuted,
  },
  priorToggle: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  empty: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  findingBody: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    gap: theme.spacing[1],
  },
  findingTitle: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  findingTitleActive: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  findingSummary: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
