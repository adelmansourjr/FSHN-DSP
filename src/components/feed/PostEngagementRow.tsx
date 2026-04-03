import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { font, hairline, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import { pressFeedback } from '../../theme/pressFeedback';
import { formatCompactCount } from '../../lib/formatCounts';

type Props = {
  likes: number;
  comments: number;
  liked?: boolean;
  onToggleLike?: () => void;
  onPressComments?: () => void;
  showFollow?: boolean;
  isFollowing?: boolean;
  onToggleFollow?: () => void;
  style?: ViewStyle;
};

export default function PostEngagementRow({
  likes,
  comments,
  liked = false,
  onToggleLike,
  onPressComments,
  showFollow = false,
  isFollowing = false,
  onToggleFollow,
  style,
}: Props) {
  const { colors, isDark } = useTheme();
  const filledPillBg = isDark ? '#fff' : colors.text;
  const filledPillFg = isDark ? colors.bg : '#fff';

  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: s(1.2),
        },
        pill: {
          height: 30,
          borderRadius: 15,
          paddingHorizontal: s(2),
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.94)',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        },
        pillText: {
          ...font.meta,
          color: colors.text,
          fontWeight: '700',
        },
        followPill: {
          height: 30,
          borderRadius: 15,
          paddingHorizontal: s(2),
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isFollowing
            ? filledPillBg
            : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.94)'),
          alignItems: 'center',
          justifyContent: 'center',
        },
        followTxt: {
          ...font.meta,
          color: isFollowing ? filledPillFg : colors.text,
          fontWeight: '800',
          letterSpacing: 0.1,
        },
      }),
    [colors, filledPillBg, filledPillFg, isDark, isFollowing]
  );

  const likeValue = formatCompactCount(Math.max(0, likes || 0));
  const commentValue = formatCompactCount(Math.max(0, comments || 0));

  return (
    <View style={[styles.row, style]}>
      <Pressable
        onPress={onToggleLike}
        disabled={!onToggleLike}
        style={({ pressed }) => [styles.pill, onToggleLike ? pressFeedback(pressed) : null]}
      >
        <Ionicons
          name={liked ? 'heart' : 'heart-outline'}
          size={14}
          color={liked ? '#e53935' : colors.text}
        />
        <Text style={styles.pillText}>{likeValue}</Text>
      </Pressable>

      <Pressable
        onPress={onPressComments}
        disabled={!onPressComments}
        style={({ pressed }) => [styles.pill, onPressComments ? pressFeedback(pressed) : null]}
      >
        <Ionicons name="chatbubble-ellipses-outline" size={14} color={colors.text} />
        <Text style={styles.pillText}>{commentValue}</Text>
      </Pressable>

      {showFollow && !!onToggleFollow && (
        <Pressable
          onPress={onToggleFollow}
          style={({ pressed }) => [styles.followPill, pressFeedback(pressed)]}
        >
          <Text style={styles.followTxt}>{isFollowing ? 'Following' : 'Follow'}</Text>
        </Pressable>
      )}
    </View>
  );
}
