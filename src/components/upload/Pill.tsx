// src/components/upload/Pill.tsx
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { hairline, radius, s } from '../../theme/tokens';
import { pressFeedback } from '../../theme/pressFeedback';
import { useTheme } from '../../theme/ThemeContext';

type Props = {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  onRemove?: () => void;
  emphasis?: boolean;
};

export default function Pill({ label, icon, onPress, onRemove, emphasis }: Props) {
  const { colors, isDark } = useTheme();
  const styles = React.useMemo(
    () =>
      StyleSheet.create({
        pill: {
          borderRadius: radius.pill,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#fff',
        },
        inner: {
          paddingHorizontal: s(3),
          paddingVertical: s(2),
          flexDirection: 'row',
          alignItems: 'center',
        },
        innerEmphasis: {
          backgroundColor: colors.text,
          borderRadius: radius.pill,
        },
        txt: { color: colors.text, fontWeight: '900' },
        txtLight: { color: isDark ? colors.bg : '#fff' },
      }),
    [colors, isDark]
  );

  const content = (
    <View style={[styles.inner, emphasis && styles.innerEmphasis]}>
      {!!icon && (
        <Ionicons
          name={icon}
          size={14}
          color={emphasis ? (isDark ? colors.bg : '#fff') : colors.text}
          style={{ marginRight: 6 }}
        />
      )}
      <Text style={[styles.txt, emphasis && styles.txtLight]}>{label}</Text>
      {!!onRemove && (
        <>
          <View style={{ width: 6 }} />
          <Ionicons
            name="close"
            size={12}
            color={emphasis ? (isDark ? colors.bg : '#fff') : colors.text}
            onPress={onRemove}
          />
        </>
      )}
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [styles.pill, pressFeedback(pressed)]}>
        {content}
      </Pressable>
    );
  }
  return <View style={styles.pill}>{content}</View>;
}
