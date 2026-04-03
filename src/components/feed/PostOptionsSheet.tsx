import React, { useMemo } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { font, hairline, radius, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';

type Props = {
  visible: boolean;
  isOwnPost?: boolean;
  blocked?: boolean;
  busy?: boolean;
  onClose: () => void;
  onViewProfile?: () => void;
  onReport?: () => void;
  onReportUser?: () => void;
  onToggleBlock?: () => void;
};

export default function PostOptionsSheet({
  visible,
  isOwnPost = false,
  blocked = false,
  busy = false,
  onClose,
  onViewProfile,
  onReport,
  onReportUser,
  onToggleBlock,
}: Props) {
  const { colors, isDark } = useTheme();
  const moderationDisabled = busy || isOwnPost;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
        wrap: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
        sheet: {
          borderTopLeftRadius: radius.card,
          borderTopRightRadius: radius.card,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(17,17,20,0.93)' : 'rgba(255,255,255,0.95)',
          paddingHorizontal: s(3),
          paddingTop: s(2.5),
          paddingBottom: s(4),
        },
        divider: { height: hairline, backgroundColor: colors.borderLight },
        rowText: { color: colors.text },
      }),
    [colors, isDark]
  );

  const rowColor = colors.text;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.wrap} pointerEvents="box-none">
        <BlurView tint={isDark ? 'dark' : 'light'} intensity={28} style={styles.sheet}>
          <Pressable
            onPress={onViewProfile}
            style={({ pressed }) => [
              { flexDirection: 'row', alignItems: 'center', gap: s(2), paddingVertical: s(2) },
              pressed && { opacity: 0.75 },
            ]}
          >
            <Ionicons name="person-outline" size={18} color={rowColor} />
            <Text style={[font.p, styles.rowText, { fontWeight: '700' }]}>View profile</Text>
          </Pressable>

          <View style={styles.divider} />
          <Pressable
            onPress={onToggleBlock}
            disabled={moderationDisabled}
            style={({ pressed }) => [
              { flexDirection: 'row', alignItems: 'center', gap: s(2), paddingVertical: s(2) },
              (pressed || moderationDisabled) && { opacity: 0.75 },
            ]}
          >
            <Ionicons name={blocked ? 'checkmark-circle-outline' : 'ban-outline'} size={18} color="#e53935" />
            <Text style={[font.p, { color: '#e53935', fontWeight: '700' }]}>
              {blocked ? 'Unblock user' : 'Block user'}
            </Text>
          </Pressable>

          <View style={styles.divider} />
          <Pressable
            onPress={onReport}
            disabled={moderationDisabled}
            style={({ pressed }) => [
              { flexDirection: 'row', alignItems: 'center', gap: s(2), paddingVertical: s(2) },
              (pressed || moderationDisabled) && { opacity: 0.75 },
            ]}
          >
            <Ionicons name="flag-outline" size={18} color="#e53935" />
            <Text style={[font.p, { color: '#e53935', fontWeight: '700' }]}>Report post</Text>
          </Pressable>

          <View style={styles.divider} />
          <Pressable
            onPress={onReportUser}
            disabled={moderationDisabled}
            style={({ pressed }) => [
              { flexDirection: 'row', alignItems: 'center', gap: s(2), paddingVertical: s(2) },
              (pressed || moderationDisabled) && { opacity: 0.75 },
            ]}
          >
            <Ionicons name="person-remove-outline" size={18} color="#e53935" />
            <Text style={[font.p, { color: '#e53935', fontWeight: '700' }]}>Report user</Text>
          </Pressable>

          <View style={styles.divider} />
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [
              { flexDirection: 'row', alignItems: 'center', gap: s(2), paddingVertical: s(2) },
              pressed && { opacity: 0.75 },
            ]}
          >
            <Ionicons name="close-outline" size={18} color={rowColor} />
            <Text style={[font.p, styles.rowText, { fontWeight: '700' }]}>Cancel</Text>
          </Pressable>
        </BlurView>
      </View>
    </Modal>
  );
}
