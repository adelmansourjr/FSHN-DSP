// src/components/upload/SelectModal.tsx
import React from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { hairline, radius, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';

type Props = {
  visible: boolean;
  title: string;
  options: string[];
  value: string | null;
  onSelect: (v: string) => void;
  onClose: () => void;
  type?: 'list' | 'grid' | 'chips';
  multiple?: boolean;
  values?: string[];
  onToggle?: (v: string) => void;
};

export default function SelectModal({
  visible,
  title,
  options,
  value,
  onSelect,
  onClose,
  type = 'list',
  multiple = false,
  values = [],
  onToggle,
}: Props) {
  const { colors, isDark } = useTheme();
  const selectedValues = new Set(values);
  const isActive = (option: string) => (multiple ? selectedValues.has(option) : option === value);
  const handlePress = (option: string) => {
    if (multiple) {
      onToggle?.(option);
      return;
    }
    onSelect(option);
  };
  const styles = React.useMemo(
    () =>
      StyleSheet.create({
        backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.25)' },
        sheet: {
          position: 'absolute',
          left: s(3), right: s(3), bottom: s(6),
          borderRadius: 16,
          backgroundColor: isDark ? 'rgba(17,17,20,0.96)' : 'rgba(255,255,255,0.96)',
          borderWidth: hairline,
          borderColor: colors.borderLight,
          padding: s(3),
          ...Platform.select({
            ios: { shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
            android: { elevation: 4 },
          }),
        },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          marginBottom: s(2),
        },
        title: { flex: 1, fontWeight: '900', color: colors.text, fontSize: 16 },
        closeBtn: {
          width: 34, height: 34, borderRadius: 17,
          alignItems: 'center', justifyContent: 'center',
          borderWidth: hairline, borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#fff',
        },
        sep: { height: hairline, backgroundColor: colors.borderLight },
        row: {
          minHeight: 46,
          paddingHorizontal: s(2),
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        rowTxt: { color: colors.text, fontWeight: '700' },
        rowTxtActive: { textDecorationLine: 'underline' },
        grid: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: s(2),
        },
        card: {
          width: '30.5%',
          height: s(14),
          borderRadius: radius.tile,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#fff',
          borderWidth: hairline,
          borderColor: colors.borderLight,
        },
        cardActive: { backgroundColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.06)' },
        cardTxt: { color: colors.text, fontWeight: '800' },
        cardTxtActive: { textDecorationLine: 'underline' },
        chips: { flexDirection: 'row', flexWrap: 'wrap', gap: s(2) },
        chip: {
          paddingHorizontal: s(3),
          height: 40,
          borderRadius: 999,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#fff',
          alignItems: 'center',
          justifyContent: 'center',
        },
        chipActive: { backgroundColor: colors.text, borderColor: colors.text },
        chipTxt: { color: colors.text, fontWeight: '900' },
        chipTxtActive: { color: isDark ? colors.bg : '#fff' },
      }),
    [colors, isDark]
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={18} color={colors.text} />
          </Pressable>
        </View>

        {type === 'list' && (
          <FlatList
            data={options}
            keyExtractor={(i) => i}
            ItemSeparatorComponent={() => <View style={styles.sep} />}
            renderItem={({ item }) => {
              const active = isActive(item);
              return (
                <Pressable onPress={() => handlePress(item)} style={styles.row}>
                  <Text style={[styles.rowTxt, active && styles.rowTxtActive]}>{item}</Text>
                  {active && <Ionicons name="checkmark" size={16} color={colors.text} />}
                </Pressable>
              );
            }}
          />
        )}

        {type === 'grid' && (
          <View style={styles.grid}>
            {options.map((opt) => {
              const active = isActive(opt);
              return (
                <Pressable key={opt} onPress={() => handlePress(opt)} style={[styles.card, active && styles.cardActive]}>
                  <Text style={[styles.cardTxt, active && styles.cardTxtActive]}>{opt}</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {type === 'chips' && (
          <View style={styles.chips}>
            {options.map((opt) => {
              const active = isActive(opt);
              return (
                <Pressable key={opt} onPress={() => handlePress(opt)} style={[styles.chip, active && styles.chipActive]}>
                  <Text style={[styles.chipTxt, active && styles.chipTxtActive]}>{opt}</Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
    </Modal>
  );
}
