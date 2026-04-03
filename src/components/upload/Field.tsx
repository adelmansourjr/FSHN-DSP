// src/components/upload/Field.tsx
import React from 'react';
import { View, Text, StyleSheet, TextInput, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { hairline, radius, s } from '../../theme/tokens';
import { pressFeedback } from '../../theme/pressFeedback';
import { useTheme } from '../../theme/ThemeContext';

type Props = {
  label: string;
  value: string;
  placeholder?: string;
  onChangeText?: (t: string) => void;
  onSubmitEditing?: (e: any) => void;
  keyboardType?: 'default' | 'decimal-pad';
  multiline?: boolean;
  numberOfLines?: number;
  readOnly?: boolean;
  onPress?: () => void;
  blurOnSubmit?: boolean;
  returnKeyType?: 'done' | 'next' | 'search' | 'go' | 'send';
};

export default function Field({
  label,
  value,
  placeholder,
  onChangeText,
  onSubmitEditing,
  keyboardType = 'default',
  multiline,
  numberOfLines,
  readOnly,
  onPress,
  blurOnSubmit,
  returnKeyType,
}: Props) {
  const { colors, isDark } = useTheme();
  const styles = React.useMemo(
    () =>
      StyleSheet.create({
        label: { color: colors.text, fontWeight: '800', marginBottom: s(1) },
        inputWrap: {
          minHeight: 46,
          borderRadius: radius.capsule,
          paddingHorizontal: s(3),
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        input: {
          flex: 1,
          color: colors.text,
          fontWeight: '600',
          paddingVertical: s(2),
        },
        readonly: {
          flex: 1,
          fontWeight: '700',
          color: colors.text,
        },
      }),
    [colors, isDark]
  );

  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      {readOnly ? (
        <Pressable onPress={onPress} style={({ pressed }) => [styles.inputWrap, pressFeedback(pressed, 'subtle')]}>
          <Text style={[styles.readonly, !value && { color: colors.textDim }]}>
            {value || (placeholder ?? '')}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={colors.text} />
        </Pressable>
      ) : (
        <View style={styles.inputWrap}>
          <TextInput
            value={value}
            placeholder={placeholder}
            onChangeText={onChangeText}
            onSubmitEditing={onSubmitEditing}
            keyboardType={keyboardType}
            placeholderTextColor={colors.textDim}
            style={[styles.input, multiline && { height: s(20), textAlignVertical: 'top' }]}
            multiline={multiline}
            numberOfLines={numberOfLines}
            blurOnSubmit={blurOnSubmit}
            returnKeyType={returnKeyType}
          />
        </View>
      )}
    </View>
  );
}
