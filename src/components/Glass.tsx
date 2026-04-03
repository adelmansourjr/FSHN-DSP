import React, { useMemo } from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { hairline, radius } from '../theme/tokens';
import { useTheme } from '../theme/ThemeContext';

type Props = {
  children?: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  tint?: 'light' | 'dark';
  intensity?: number;
};

export default function Glass({ children, style, tint = 'light', intensity = 22 }: Props) {
  const { colors, isDark } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrapper: {
          borderRadius: radius.card,
          overflow: 'hidden',
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: colors.glassTint,
        },
        borderOuter: {
          ...StyleSheet.absoluteFillObject,
          borderRadius: radius.card,
          borderWidth: hairline,
          borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)',
        },
        borderInner: {
          ...StyleSheet.absoluteFillObject,
          borderRadius: radius.card,
          borderWidth: hairline,
          borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.16)',
        },
      }),
    [colors, isDark]
  );

  return (
    <View style={[styles.wrapper, style]}>
      <BlurView tint={tint} intensity={intensity} style={StyleSheet.absoluteFill} />
      <View style={styles.borderOuter} pointerEvents="none" />
      <View style={styles.borderInner} pointerEvents="none" />
      {children}
    </View>
  );
}
