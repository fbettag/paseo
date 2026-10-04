import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Minus, Plus } from "lucide-react-native";
import type { AgentFeatureStepper } from "@getpaseo/protocol/agent-types";
import { getAgentFeatureIcon } from "@/agent-controls/icons";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";
import { getFeatureTooltip } from "@/composer/agent-controls/utils";
import type { Theme } from "@/styles/theme";

const ThemedMinus = withUnistyles(Minus);
const ThemedPlus = withUnistyles(Plus);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function StepperFeatureControl({
  feature,
  disabled,
  onSetFeature,
  surface,
}: {
  feature: AgentFeatureStepper;
  disabled: boolean;
  onSetFeature?: (featureId: string, value: unknown) => void;
  surface: "toolbar" | "sheet" | "profile";
}): ReactElement {
  const { t } = useTranslation();
  const { glyphSize } = useComposerControlLayout();
  const FeatureIcon = getAgentFeatureIcon(feature.icon);
  const atMin = feature.value <= feature.min;
  const atMax = feature.value >= feature.max;
  const decreaseState = useMemo(() => ({ disabled: disabled || atMin }), [atMin, disabled]);
  const increaseState = useMemo(() => ({ disabled: disabled || atMax }), [atMax, disabled]);
  const tooltip = getFeatureTooltip(feature);
  const handleDecrease = useCallback(() => {
    if (feature.value <= feature.min) return;
    onSetFeature?.(feature.id, feature.value - 1);
  }, [feature.id, feature.min, feature.value, onSetFeature]);
  const handleIncrease = useCallback(() => {
    if (feature.value >= feature.max) return;
    onSetFeature?.(feature.id, feature.value + 1);
  }, [feature.id, feature.max, feature.value, onSetFeature]);

  const iconSize = surface === "toolbar" ? glyphSize : 16;
  const showLabel =
    surface !== "profile" && (surface === "sheet" || feature.desktopTrigger !== "icon");

  return (
    <View
      style={surface === "sheet" ? styles.sheet : styles.toolbar}
      accessibilityLabel={tooltip}
      testID={`agent-feature-${feature.id}`}
    >
      {surface === "profile" ? null : (
        <View style={styles.icon}>
          {surface === "toolbar" ? (
            <ComposerToolbarGlyph size={iconSize}>
              <FeatureIcon size={iconSize} color={styles.iconColor.color} />
            </ComposerToolbarGlyph>
          ) : (
            <FeatureIcon size={iconSize} color={styles.iconColor.color} />
          )}
        </View>
      )}
      {showLabel ? (
        <Text
          style={surface === "sheet" ? styles.sheetLabel : styles.toolbarLabel}
          numberOfLines={1}
        >
          {feature.label}
        </Text>
      ) : null}
      <Pressable
        onPress={handleDecrease}
        disabled={disabled || atMin}
        accessibilityRole="button"
        accessibilityLabel={t("agentControls.stepper.decrease")}
        accessibilityState={decreaseState}
        testID={`agent-feature-${feature.id}-decrease`}
        style={[styles.button, (disabled || atMin) && styles.bound]}
      >
        <ThemedMinus size={14} uniProps={mutedMapping} />
      </Pressable>
      <Text style={styles.value} testID={`agent-feature-${feature.id}-value`}>
        {feature.value}
      </Text>
      <Pressable
        onPress={handleIncrease}
        disabled={disabled || atMax}
        accessibilityRole="button"
        accessibilityLabel={t("agentControls.stepper.increase")}
        accessibilityState={increaseState}
        testID={`agent-feature-${feature.id}-increase`}
        style={[styles.button, (disabled || atMax) && styles.bound]}
      >
        <ThemedPlus size={14} uniProps={mutedMapping} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  toolbar: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[1],
    borderRadius: theme.borderRadius["2xl"],
  },
  sheet: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: -theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: theme.colors.surface1,
  },
  icon: {
    width: 20,
    height: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  toolbarLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  sheetLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  button: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  bound: {
    opacity: 0.35,
  },
  value: {
    minWidth: 16,
    textAlign: "center",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontVariant: ["tabular-nums"],
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
}));
