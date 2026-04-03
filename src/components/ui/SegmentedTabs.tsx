import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, Pressable, Text, ScrollView } from 'react-native';
import { BlurView } from 'expo-blur';
import { hairline, radius, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import { pressFeedback } from '../../theme/pressFeedback';

type Tab = { key: string; label: string };
type Props = {
  tabs: Tab[];
  activeKey: string;
  onChange: (key: string) => void;
  equalWidth?: boolean;
  snapGroupSize?: number;
  snapGroupStep?: number;
};

export default function SegmentedTabs({
  tabs,
  activeKey,
  onChange,
  equalWidth = false,
  snapGroupSize,
  snapGroupStep,
}: Props) {
  const { colors, isDark } = useTheme();
  const scrollRef = useRef<ScrollView | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const handlePress = (key: string) => {
    console.log('[SegmentedTabs] onPress', { pressedKey: key, activeKey });
    console.log('[SegmentedTabs] before onChange', { pressedKey: key, activeKey });
    onChange(key);
  };

  const snapEnabled =
    !equalWidth &&
    typeof snapGroupSize === 'number' &&
    snapGroupSize > 1 &&
    tabs.length > snapGroupSize &&
    containerWidth > 0;
  const resolvedSnapStep =
    snapEnabled
      ? Math.max(1, Math.min(snapGroupStep || snapGroupSize, snapGroupSize))
      : 0;
  const rowHorizontalPadding = s(1);
  const rowGap = s(1);
  const snappedTabWidth = snapEnabled
    ? Math.max(
        64,
        (containerWidth - rowHorizontalPadding * 2 - rowGap * ((snapGroupSize || 0) - 1)) /
          (snapGroupSize || 1)
      )
    : null;
  const snapOffsets = useMemo(() => {
    if (!snapEnabled || !snappedTabWidth) return [];
    const maxStartIndex = Math.max(0, tabs.length - (snapGroupSize || 1));
    const step = resolvedSnapStep || 1;
    const offsets: number[] = [];
    for (let start = 0; start <= maxStartIndex; start += step) {
      offsets.push(start * (snappedTabWidth + rowGap));
    }
    if (!offsets.includes(maxStartIndex * (snappedTabWidth + rowGap))) {
      offsets.push(maxStartIndex * (snappedTabWidth + rowGap));
    }
    return offsets;
  }, [resolvedSnapStep, rowGap, snapEnabled, snapGroupSize, snappedTabWidth, tabs.length]);

  useEffect(() => {
    if (!snapEnabled || !scrollRef.current || !snapOffsets.length) return;
    const activeIndex = tabs.findIndex((tab) => tab.key === activeKey);
    if (activeIndex < 0) return;

    let targetOffset = snapOffsets[0];
    const groupSize = snapGroupSize || 1;
    const maxStartIndex = Math.max(0, tabs.length - groupSize);
    for (let start = 0; start <= maxStartIndex; start += resolvedSnapStep || 1) {
      if (activeIndex >= start && activeIndex <= start + groupSize - 1) {
        targetOffset = start * ((snappedTabWidth || 0) + rowGap);
        break;
      }
    }
    if (activeIndex > maxStartIndex + groupSize - 1 && snapOffsets[snapOffsets.length - 1] != null) {
      targetOffset = snapOffsets[snapOffsets.length - 1];
    }

    scrollRef.current.scrollTo({ x: targetOffset, animated: false });
  }, [
    activeKey,
    resolvedSnapStep,
    rowGap,
    snapEnabled,
    snapGroupSize,
    snapOffsets,
    snappedTabWidth,
    tabs,
  ]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: {
          position: 'relative',
          borderRadius: radius.pill,
          overflow: 'hidden',
          backgroundColor: isDark ? 'rgba(17,17,20,0.6)' : 'rgba(255,255,255,0.6)',
          borderWidth: hairline,
          borderColor: colors.borderLight,
        },
        bg: { ...StyleSheet.absoluteFillObject },
        stroke: {
          ...StyleSheet.absoluteFillObject,
          borderRadius: radius.pill,
          borderWidth: hairline,
          borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.65)',
        },
        row: {
          paddingHorizontal: s(1),
          paddingVertical: s(1),
          gap: s(1),
          alignItems: 'center',
        },
        equalRow: {
          flexDirection: 'row',
          justifyContent: 'space-between',
        },
        tab: {
          paddingHorizontal: s(4),
          paddingVertical: s(2.5),
          borderRadius: 999,
          backgroundColor: 'transparent',
          borderWidth: hairline,
          borderColor: 'transparent',
        },
        snapTab: {
          minHeight: 42,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: s(1),
        },
        equalTab: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: s(1.5),
        },
        active: {
          backgroundColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.7)',
          borderColor: colors.borderLight,
        },
        label: {
          fontSize: 13,
          color: colors.textDim,
          fontWeight: '700',
          letterSpacing: 0.1,
          lineHeight: 16,
          textAlign: 'center',
        },
        labelActive: { color: colors.text },
      }),
    [colors, isDark]
  );

  return (
    <View
      style={styles.wrap}
      onLayout={(event) => {
        const nextWidth = Math.round(event.nativeEvent.layout.width);
        setContainerWidth((prev) => (prev === nextWidth ? prev : nextWidth));
      }}
    >
      <BlurView tint={isDark ? 'dark' : 'light'} intensity={22} style={styles.bg} pointerEvents="none" />
      <View style={styles.stroke} pointerEvents="none" />

      {equalWidth ? (
        <View style={[styles.row, styles.equalRow]}>
          {tabs.map((t) => {
            const active = t.key === activeKey;
            return (
              <Pressable
                key={t.key}
                onPress={() => handlePress(t.key)}
                style={({ pressed }) => [
                  styles.tab,
                  styles.equalTab,
                  active && styles.active,
                  pressFeedback(pressed),
                ]}
              >
                <Text style={[styles.label, active && styles.labelActive]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        // Keep content-width + horizontal scrolling for long tab sets elsewhere in the app
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          bounces={!snapEnabled}
          alwaysBounceHorizontal={!snapEnabled}
          decelerationRate={snapEnabled ? 'fast' : 'normal'}
          disableIntervalMomentum={snapEnabled}
          snapToOffsets={snapEnabled ? snapOffsets : undefined}
          snapToAlignment={snapEnabled ? 'start' : undefined}
          contentContainerStyle={styles.row}
        >
          {tabs.map((t) => {
            const active = t.key === activeKey;
            return (
              <Pressable
                key={t.key}
                onPress={() => handlePress(t.key)}
                style={({ pressed }) => [
                  styles.tab,
                  snapEnabled && styles.snapTab,
                  snapEnabled && snappedTabWidth ? { width: snappedTabWidth } : null,
                  active && styles.active,
                  pressFeedback(pressed),
                ]}
              >
                <Text
                  numberOfLines={snapEnabled ? 2 : undefined}
                  style={[styles.label, active && styles.labelActive]}
                >
                  {t.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}
