import React, { useMemo } from 'react';
import { View, StyleSheet, Pressable, Text } from 'react-native';
import { hairline, radius, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import { pressFeedback } from '../../theme/pressFeedback';

type Chip = { key: string; label: string };
type Props = {
  options: Chip[];
  value: string;
  onChange: (key: string) => void;
  style?: any;
};

export default function SegmentedChips({ options, value, onChange, style }: Props) {
  const { colors, isDark } = useTheme();
  const handlePress = (key: string) => {
    console.log('[SegmentedChips] onPress', { pressedKey: key, value });
    console.log('[SegmentedChips] before onChange', { pressedKey: key, value });
    onChange(key);
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: { flexDirection: 'row', gap: s(2) },
        chip: {
          paddingHorizontal: s(4),
          paddingVertical: s(2),
          borderRadius: 999,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.55)',
          borderWidth: hairline,
          borderColor: colors.borderLight,
        },
        chipActive: { backgroundColor: colors.text, borderColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)' },
        txt: { fontSize: 13, color: colors.textDim, fontWeight: '700' },
        txtActive: { color: isDark ? '#111' : '#fff' },
      }),
    [colors, isDark]
  );

  return (
    <View style={[styles.row, style]}>
      {options.map((opt) => {
        const active = opt.key === value;
        return (
          <Pressable
            key={opt.key}
            onPress={() => handlePress(opt.key)}
            style={({ pressed }) => [
              styles.chip,
              active && styles.chipActive,
              pressFeedback(pressed),
            ]}
          >
            <Text style={[styles.txt, active && styles.txtActive]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
