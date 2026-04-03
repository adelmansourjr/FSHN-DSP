import React, { useMemo } from 'react';
import { View, StyleSheet, TextInput, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Glass from './Glass';
import SegmentedChips from './ui/SegmentedChips';
import { hairline, s } from '../theme/tokens';
import { useTheme } from '../theme/ThemeContext';

type Scope = 'users' | 'posts' | 'listings';

type Props = {
  value: string;
  onChangeText: (value: string) => void;
  scope: Scope;
  onScopeChange: (value: Scope) => void;
  placeholder?: string;
};

const OPTIONS = [
  { key: 'users', label: 'Users' },
  { key: 'posts', label: 'Posts' },
  { key: 'listings', label: 'Listings' },
] as const;

export default function HeaderSearch({
  value,
  onChangeText,
  scope,
  onScopeChange,
  placeholder = 'Search',
}: Props) {
  const { colors, isDark } = useTheme();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: {
          paddingHorizontal: s(3),
          paddingVertical: s(3),
          gap: s(2),
        },
        section: {
          gap: s(2),
        },
        inputRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(2),
          paddingHorizontal: s(2),
          paddingVertical: s(2.5),
          borderRadius: 14,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.7)',
          borderWidth: hairline,
          borderColor: colors.borderLight,
        },
        input: {
          flex: 1,
          fontSize: 14,
          color: colors.text,
          fontWeight: '600',
          paddingVertical: 0,
        },
        divider: {
          height: hairline,
          backgroundColor: colors.borderLight,
        },
        label: {
          fontSize: 12,
          fontWeight: '800',
          color: colors.textDim,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
        },
        scopeChips: {
          alignSelf: 'flex-start',
        },
      }),
    [colors, isDark]
  );

  return (
    <Glass style={styles.wrap}>
      <View style={styles.section}>
        <View style={styles.inputRow}>
          <Ionicons name="search" size={16} color={colors.textDim} />
          <TextInput
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={colors.textDim}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
        </View>
      </View>

      <View style={styles.divider} />

      <View style={styles.section}>
        <Text style={styles.label}>Search in</Text>
        <SegmentedChips
          options={[...OPTIONS]}
          value={scope}
          onChange={(key) => onScopeChange(key as Scope)}
          style={styles.scopeChips}
        />
      </View>
    </Glass>
  );
}
