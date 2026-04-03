import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import Glass from '../Glass';
import { font, hairline, radius, s } from '../../theme/tokens';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeContext';
import UserAvatar from '../UserAvatar';
import { formatCompactCount } from '../../lib/formatCounts';

type Props = {
  avatarUri?: string;
  name: string;
  username?: string;
  displayName?: string;
  bio?: string;
  subtitle?: string;
  stats: { listings: number; sold: number; likes: number };
  social?: { followers?: number | null; following?: number | null };
  onPressFollowers?: () => void;
  onPressFollowing?: () => void;
  onEdit?: () => void;
  onShare?: () => void;
  showEdit?: boolean;
  showShare?: boolean;
};

const formatMetric = (value?: number | null) => {
  return formatCompactCount(value || 0);
};

export default function ProfileHeader({
  avatarUri,
  name,
  username,
  displayName,
  bio,
  subtitle,
  stats,
  social,
  onPressFollowers,
  onPressFollowing,
  onEdit,
  onShare,
  showEdit,
  showShare,
}: Props) {
  const { colors, isDark } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          borderRadius: radius.card,
          overflow: 'hidden',
          backgroundColor: isDark ? 'rgba(17,17,20,0.85)' : 'rgba(255,255,255,0.85)',
          borderWidth: hairline,
          borderColor: colors.borderLight,
        },
        topSection: {
          flexDirection: 'row',
          paddingHorizontal: s(4),
          paddingVertical: s(3.5),
          gap: s(3),
        },
        meta: { flex: 1, minWidth: 0 },
        avatar: {
          width: AVATAR,
          height: AVATAR,
          borderRadius: AVATAR / 2,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#EEE',
          borderWidth: hairline,
          borderColor: colors.borderLight,
          alignItems: 'center',
          justifyContent: 'center',
        },
        identity: {
          gap: s(0.25),
          minWidth: 0,
        },
        displayName: {
          ...font.h2,
          color: colors.text,
        },
        username: {
          ...font.meta,
          color: colors.textDim,
          fontSize: 12,
          letterSpacing: 0.4,
          fontWeight: '800',
        },
        bioCard: {
          marginTop: s(1.1),
          paddingHorizontal: s(1.6),
          paddingVertical: s(1.2),
          borderRadius: 12,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.72)',
        },
        bioLabel: {
          ...font.meta,
          color: colors.textDim,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          fontSize: 10,
          fontWeight: '800',
          marginBottom: 4,
        },
        bioText: {
          ...font.p,
          color: colors.text,
          lineHeight: 18,
        },
        socialRow: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: s(2),
          marginTop: s(2),
        },
        socialMetric: {
          flexDirection: 'row',
          alignItems: 'baseline',
          gap: 4,
        },
        socialCount: {
          fontSize: 15,
          fontWeight: '900',
          color: colors.text,
        },
        socialLabel: {
          fontSize: 12,
          letterSpacing: 0.7,
          textTransform: 'uppercase',
          color: colors.textDim,
          fontWeight: '700',
        },
        actions: {
          flexDirection: 'row',
          marginTop: s(2.5),
        },
        pill: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: s(5),
          paddingVertical: s(3),
          borderRadius: 9999,
          borderWidth: hairline,
        },
        pillDark: { backgroundColor: isDark ? '#fff' : colors.text, borderColor: 'rgba(255,255,255,0.14)' },
        pillLight: { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.65)', borderColor: colors.borderLight },
        pillTxt: { fontWeight: '900', letterSpacing: 0.2, fontSize: 14 },
        pillTxtLight: { color: isDark ? colors.bg : '#fff' },
        pillTxtDark: { color: colors.text },
        footer: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: s(4),
          paddingVertical: s(2.5),
          gap: s(2.5),
          borderTopWidth: hairline,
          borderTopColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.65)',
        },
        stat: { flex: 1, alignItems: 'center' },
        statVal: { fontSize: 18, fontWeight: '900', color: colors.text },
        statLabel: { fontSize: 11, color: colors.textDim, marginTop: 2, letterSpacing: 0.6, textTransform: 'uppercase' },
        divider: { width: 1, height: 28, backgroundColor: colors.borderLight },
      }),
    [colors, isDark]
  );
  const hasFollowers = typeof social?.followers === 'number';
  const hasFollowing = typeof social?.following === 'number';
  const showSocial = hasFollowers || hasFollowing;

  const Stat = ({ label, value }: { label: string; value: number }) => (
    <View style={styles.stat}>
      <Text style={styles.statVal}>{formatCompactCount(value)}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );

  const Divider = () => <View style={styles.divider} />;

  const SocialMetric = ({
    label,
    value,
    onPress,
  }: {
    label: string;
    value: string;
    onPress?: () => void;
  }) => (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.socialMetric,
        onPress && pressed && { opacity: 0.7, transform: [{ scale: 0.98 }] },
      ]}
    >
      <Text style={styles.socialCount}>{value}</Text>
      <Text style={styles.socialLabel}>{label}</Text>
    </Pressable>
  );

  const PillButton = ({
    title,
    icon,
    onPress,
    tone = 'dark',
  }: {
    title: string;
    icon: keyof typeof Ionicons.glyphMap;
    onPress?: () => void;
    tone?: 'dark' | 'light';
  }) => {
    const isDarkTone = tone === 'dark';
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.pill, isDarkTone ? styles.pillDark : styles.pillLight, pressed && { transform: [{ scale: 0.98 }] }]}
      >
        <Ionicons name={icon} size={16} color={isDarkTone ? (isDark ? colors.bg : '#fff') : colors.text} />
        <Text style={[styles.pillTxt, isDarkTone ? styles.pillTxtLight : styles.pillTxtDark]}>{title}</Text>
      </Pressable>
    );
  };
  const canShowEdit = showEdit ?? true;
  const canShowShare = showShare ?? true;
  const hasActions = canShowEdit || canShowShare;
  const rawUsername = String(username || name || '').trim();
  const usernameLabel = rawUsername
    ? rawUsername.startsWith('@')
      ? rawUsername
      : `@${rawUsername}`
    : '@profile';
  const displayLabel = String(displayName || '').trim();
  const fallbackName = rawUsername.replace(/^@/, '') || 'profile';
  const displayNameLabel = displayLabel || fallbackName;
  const bioText = String(bio || subtitle || '').trim();

  return (
    <Glass style={styles.card}>
      <View style={styles.topSection}>
        <UserAvatar uri={avatarUri} size={AVATAR} style={styles.avatar} />

        <View style={styles.meta}>
          <View style={styles.identity}>
            <Text numberOfLines={1} style={styles.displayName}>
              {displayNameLabel}
            </Text>
            <Text numberOfLines={1} style={styles.username}>
              {usernameLabel}
            </Text>
          </View>
          {!!bioText && (
            <View style={styles.bioCard}>
              <Text style={styles.bioLabel}>Bio</Text>
              <Text numberOfLines={3} style={styles.bioText}>
                {bioText}
              </Text>
            </View>
          )}

          {showSocial && (
            <View style={styles.socialRow}>
              {hasFollowers && (
                <SocialMetric
                  label="Followers"
                  value={formatMetric(social?.followers || 0)}
                  onPress={onPressFollowers}
                />
              )}
              {hasFollowing && (
                <SocialMetric
                  label="Following"
                  value={formatMetric(social?.following || 0)}
                  onPress={onPressFollowing}
                />
              )}
            </View>
          )}

          {hasActions && (
            <View style={styles.actions}>
              {canShowEdit && (
                <PillButton title="Edit profile" icon="create-outline" onPress={onEdit} />
              )}
              {canShowEdit && canShowShare && <View style={{ width: s(2) }} />}
              {canShowShare && (
                <PillButton title="Share" icon="share-social-outline" onPress={onShare} tone="light" />
              )}
            </View>
          )}
        </View>
      </View>

      <View style={styles.footer}>
        <Stat label="Listings" value={stats.listings} />
        <Divider />
        <Stat label="Sold" value={stats.sold} />
        <Divider />
        <Stat label="Likes" value={stats.likes} />
      </View>
    </Glass>
  );
}

const AVATAR = 72;
