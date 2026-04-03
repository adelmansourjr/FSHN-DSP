import React, { useMemo } from 'react';
import { View, StyleSheet, Pressable, Text } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, { useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';
import { pressFeedback } from '../theme/pressFeedback';

// 🔐 Tab keys must match Root.tsx
export type TabKey = 'home' | 'feed' | 'tryon' | 'upload' | 'profile';
type Props = { active: TabKey; onChange: (t: TabKey) => void };

// Order with Studio in the middle
const TABS: { key: TabKey; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'home',   label: 'Home',   icon: 'home-outline' },
  { key: 'feed',   label: 'Feed',   icon: 'grid-outline' },
  { key: 'tryon',  label: 'Studio', icon: 'aperture-outline' }, // center
  { key: 'upload', label: 'Upload', icon: 'cloud-upload-outline' },
  { key: 'profile',label: 'Profile',icon: 'person-outline' },
];

/* Layout */
export const DOCK_HEIGHT = 64;
const PAD_H = 12;
const ICON_HALO = 58;
const TAB_COUNT = TABS.length;

/* Shared visuals */
const ICON_SIZE = 22;
const GAP = 4;
const LABEL_SIZE = 11;

/** Match RootNavigator speed */
const SPEED = 1.4;
const BASE_STIFFNESS = 240;
const BASE_DAMPING = 18;
const STIFFNESS = BASE_STIFFNESS * (SPEED * SPEED);
const DAMPING = BASE_DAMPING * SPEED;

export default function Dock({ active, onChange }: Props) {
  const { colors, isDark } = useTheme();
  const [dockW, setDockW] = React.useState(320);
  const index = Math.max(0, TABS.findIndex(t => t.key === active));
  const activeTab = TABS[index];

  const innerW = dockW - PAD_H * 2;
  const tabW = innerW / TAB_COUNT;

  const indicatorStyle = useAnimatedStyle(() => {
    const x = PAD_H + index * tabW + (tabW - ICON_HALO) / 2;
    return {
      transform: [
        {
          translateX: withSpring(x, {
            stiffness: STIFFNESS,
            damping: DAMPING,
            mass: 1,
          }),
        },
      ],
    };
  }, [index, tabW]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: {
          position: 'absolute',
          bottom: 28,
          left: 0,
          right: 0,
          alignItems: 'center',
          zIndex: 120,
          elevation: 20,
        },
        dock: {
          width: 320,
          height: DOCK_HEIGHT,
          borderRadius: DOCK_HEIGHT / 2,
          overflow: 'hidden',
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: PAD_H,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(17,17,20,0.6)' : 'rgba(255,255,255,0.6)',
        },
        tab: { flex: 1, height: DOCK_HEIGHT, alignItems: 'center', justifyContent: 'center' },
        inlineStack: { alignItems: 'center', justifyContent: 'center', minWidth: ICON_HALO },
        label: { fontSize: LABEL_SIZE, color: colors.textDim, fontWeight: '600', letterSpacing: -0.2 },
        activeLabel: { color: colors.text },
        indicator: {
          position: 'absolute',
          zIndex: 10,
          top: (DOCK_HEIGHT - ICON_HALO) / 2,
          width: ICON_HALO,
          height: ICON_HALO,
          borderRadius: 9999,
          overflow: 'hidden',
        },
        indicatorFill: { ...StyleSheet.absoluteFillObject, backgroundColor: isDark ? 'rgba(17,17,20,0.85)' : 'rgba(255,255,255,0.78)' },
        indicatorStroke: { ...StyleSheet.absoluteFillObject, borderRadius: 9999, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderLight },
        indicatorContent: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 },
        indicatorLabel: { fontSize: LABEL_SIZE, lineHeight: 12, color: colors.text, fontWeight: '600', letterSpacing: -0.2 },
      }),
    [colors, isDark]
  );

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <BlurView
        tint={isDark ? 'dark' : 'light'}
        intensity={30}
        style={styles.dock}
        onLayout={e => setDockW(e.nativeEvent.layout.width)}
      >
        {TABS.map((t) => {
          const isActive = t.key === active;
          return (
            <Pressable
              key={t.key}
              onPress={() => onChange(t.key)}  // ✅ sends the exact key Root expects
              style={({ pressed }) => [styles.tab, pressFeedback(pressed)]}
              android_ripple={{ color: 'rgba(0,0,0,0.06)', borderless: true }}
              accessibilityRole="button"
              accessibilityLabel={t.label}
              accessibilityState={{ selected: isActive }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <View style={[styles.inlineStack, isActive && { opacity: 0 }]}>
                <Ionicons name={t.icon} size={ICON_SIZE} color={isActive ? colors.text : colors.textDim} style={{ marginBottom: GAP }} />
                <Text numberOfLines={1} style={[styles.label, isActive && styles.activeLabel]} allowFontScaling={false}>
                  {t.label}
                </Text>
              </View>
            </Pressable>
          );
        })}

        <Animated.View style={[styles.indicator, indicatorStyle]} pointerEvents="none">
          <BlurView intensity={22} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFillObject as any} />
          <View style={styles.indicatorFill} />
          <View style={styles.indicatorStroke} />
          <View style={styles.indicatorContent}>
            <Ionicons name={activeTab.icon} size={ICON_SIZE} color={colors.text} style={{ marginBottom: GAP }} />
            <Text numberOfLines={1} style={styles.indicatorLabel} allowFontScaling={false}>
              {activeTab.label}
            </Text>
          </View>
        </Animated.View>
      </BlurView>
    </View>
  );
}
