import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, ViewStyle } from 'react-native';
import { radius, s } from '../theme/tokens';
import { useTheme } from '../theme/ThemeContext';

type Props = {
  children: React.ReactNode;
  onPress?: () => void;
  style?: ViewStyle | ViewStyle[];
  selected?: boolean;
  size?: 'sm' | 'md' | 'lg';
};

export default function BlurPill({ children, onPress, style, selected, size = 'md' }: Props) {
  const { colors, isDark } = useTheme();
  const pad = size === 'lg' ? s(3) : size === 'sm' ? s(1.5) : s(2);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        pill: {
          borderRadius: radius.pill,
          borderWidth: 1,
        },
        text: {
          fontSize: 12,
          letterSpacing: 0.2,
          color: colors.text,
        },
      }),
    [colors]
  );
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        {
          paddingHorizontal: pad * 1.4,
          paddingVertical: pad * 0.6,
          opacity: pressed ? 0.8 : 1,
          backgroundColor: selected
            ? colors.text
            : isDark
              ? 'rgba(255,255,255,0.08)'
              : 'rgba(255,255,255,0.45)',
          borderColor: selected
            ? (isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)')
            : colors.borderLight,
        },
        style,
      ]}
    >
      <Text
        style={[
          styles.text,
          { fontWeight: selected ? '800' : '700', color: selected ? (isDark ? colors.bg : '#fff') : colors.text },
        ]}
      >
        {children}
      </Text>
    </Pressable>
  );
}
