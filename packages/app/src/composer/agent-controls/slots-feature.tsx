import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, Minus, Plus } from "lucide-react-native";
import type {
  AgentFeatureSlots,
  AgentFeatureSlotValue,
  AgentSelectOption,
} from "@getpaseo/protocol/agent-types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SearchField } from "@/components/ui/search-field";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { getAgentFeatureIcon } from "@/agent-controls/icons";
import type { Theme } from "@/styles/theme";
import {
  filterSlotOptions,
  replicaCount,
  setSlotReplicas,
  toggleSlot,
  workerCount,
} from "./slots-feature-model";

const ThemedCheck = withUnistyles(Check);
const ThemedMinus = withUnistyles(Minus);
const ThemedPlus = withUnistyles(Plus);

const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function SlotsFeatureItem({
  feature,
  disabled,
  open,
  onOpenChange,
  onSetFeature,
  surface,
}: {
  feature: AgentFeatureSlots;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSetFeature?: (featureId: string, value: unknown) => void;
  surface: "toolbar" | "sheet";
}): ReactElement {
  const { t } = useTranslation();
  const triggerRef = useRef<View>(null);
  const FeatureIcon = getAgentFeatureIcon(feature.icon);
  const workers = workerCount(feature.value);
  const summary =
    workers === 0
      ? t("agentControls.slots.empty")
      : t("agentControls.slots.workers", { count: workers });
  const tooltip = `${feature.label}: ${summary}`;
  const header = useMemo<SheetHeader>(
    () => ({ title: feature.label, subtitle: feature.description }),
    [feature.description, feature.label],
  );
  const handlePress = useCallback(() => onOpenChange(!open), [onOpenChange, open]);
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);
  const handleChange = useCallback(
    (value: AgentFeatureSlotValue[]) => {
      onSetFeature?.(feature.id, value);
    },
    [feature.id, onSetFeature],
  );

  return (
    <>
      <AgentControlTrigger
        ref={triggerRef}
        icon={FeatureIcon}
        surface={surface}
        label={feature.label}
        value={summary}
        showToolbarLabel={surface === "toolbar" && feature.desktopTrigger !== "icon"}
        open={open}
        disabled={disabled}
        onPress={handlePress}
        accessibilityLabel={tooltip}
        testID={`agent-feature-${feature.id}`}
      />
      <AdaptiveModalSheet
        header={header}
        visible={open}
        onClose={handleClose}
        testID={`agent-feature-${feature.id}-sheet`}
        desktopMaxWidth={520}
        desktopHeight="70%"
      >
        <SlotsFeaturePanel feature={feature} disabled={disabled} onChange={handleChange} />
      </AdaptiveModalSheet>
    </>
  );
}

export function SlotsFeaturePanel({
  feature,
  disabled,
  onChange,
}: {
  feature: AgentFeatureSlots;
  disabled: boolean;
  onChange: (value: AgentFeatureSlotValue[]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const options = useMemo(
    () => filterSlotOptions(feature.options, query),
    [feature.options, query],
  );
  const handleToggle = useCallback(
    (model: string) => {
      onChange(
        toggleSlot({
          slots: feature.value,
          model,
          minReplicas: feature.minReplicas,
          maxReplicas: feature.maxReplicas,
        }),
      );
    },
    [feature.maxReplicas, feature.minReplicas, feature.value, onChange],
  );
  const handleReplicas = useCallback(
    (model: string, replicas: number) => {
      onChange(
        setSlotReplicas({
          slots: feature.value,
          model,
          replicas,
          minReplicas: feature.minReplicas,
          maxReplicas: feature.maxReplicas,
        }),
      );
    },
    [feature.maxReplicas, feature.minReplicas, feature.value, onChange],
  );

  return (
    <View style={styles.panel} testID={`agent-feature-${feature.id}-panel`}>
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t("agentControls.slots.search")}
        clearAccessibilityLabel={t("agentControls.slots.clearSearch")}
        testID={`agent-feature-${feature.id}-search`}
        clearTestID={`agent-feature-${feature.id}-search-clear`}
      />
      <Text style={styles.hint}>{t("agentControls.slots.emptyHint")}</Text>
      {options.length === 0 ? (
        <Text style={styles.empty}>{t("agentControls.slots.noMatches")}</Text>
      ) : (
        options.map((option) => (
          <SlotOptionRow
            key={option.id}
            option={option}
            replicas={replicaCount(feature.value, option.id)}
            maxReplicas={feature.maxReplicas}
            disabled={disabled}
            onToggle={handleToggle}
            onSetReplicas={handleReplicas}
          />
        ))
      )}
    </View>
  );
}

function SlotOptionRow({
  option,
  replicas,
  maxReplicas,
  disabled,
  onToggle,
  onSetReplicas,
}: {
  option: AgentSelectOption;
  replicas: number;
  maxReplicas: number;
  disabled: boolean;
  onToggle: (model: string) => void;
  onSetReplicas: (model: string, replicas: number) => void;
}): ReactElement {
  const { t } = useTranslation();
  const selected = replicas > 0;
  const accessibilityState = useMemo(() => ({ checked: selected, disabled }), [disabled, selected]);
  const handleToggle = useCallback(() => onToggle(option.id), [onToggle, option.id]);
  const handleDecrease = useCallback(
    () => onSetReplicas(option.id, replicas - 1),
    [onSetReplicas, option.id, replicas],
  );
  const handleIncrease = useCallback(
    () => onSetReplicas(option.id, replicas + 1),
    [onSetReplicas, option.id, replicas],
  );
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType) => [
      styles.row,
      (hovered || pressed) && styles.rowInteractive,
    ],
    [],
  );

  return (
    <View style={styles.rowShell}>
      <Pressable
        onPress={handleToggle}
        disabled={disabled}
        style={rowStyle}
        accessibilityRole="checkbox"
        accessibilityState={accessibilityState}
        accessibilityLabel={option.label}
        testID={`agent-feature-slots-option-${option.id}`}
      >
        <View style={[styles.checkBox, selected && styles.checkBoxSelected]}>
          {selected ? <ThemedCheck size={12} uniProps={foregroundMapping} /> : null}
        </View>
        <View style={styles.rowMeta}>
          <Text style={styles.rowLabel} numberOfLines={1}>
            {option.label}
          </Text>
          {option.description ? (
            <Text style={styles.rowDescription} numberOfLines={1}>
              {option.description}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {selected ? (
        <View style={styles.stepper}>
          <Pressable
            onPress={handleDecrease}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={t("agentControls.slots.decrease")}
            testID={`agent-feature-slots-decrease-${option.id}`}
            style={styles.stepperButton}
          >
            <ThemedMinus size={14} uniProps={mutedMapping} />
          </Pressable>
          <Text style={styles.stepperValue} testID={`agent-feature-slots-replicas-${option.id}`}>
            {replicas}
          </Text>
          <Pressable
            onPress={handleIncrease}
            disabled={disabled || replicas >= maxReplicas}
            accessibilityRole="button"
            accessibilityLabel={t("agentControls.slots.increase")}
            testID={`agent-feature-slots-increase-${option.id}`}
            style={styles.stepperButton}
          >
            <ThemedPlus size={14} uniProps={mutedMapping} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    gap: theme.spacing[3],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    paddingVertical: theme.spacing[3],
  },
  rowShell: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  row: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowInteractive: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  checkBox: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    alignItems: "center",
    justifyContent: "center",
  },
  checkBoxSelected: {
    borderColor: theme.colors.foreground,
  },
  rowMeta: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  rowLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  stepperButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  stepperValue: {
    minWidth: 16,
    textAlign: "center",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
