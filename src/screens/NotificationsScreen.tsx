import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import MinimalHeader from '../components/MinimalHeader';
import Glass from '../components/Glass';
import SegmentedChips from '../components/ui/SegmentedChips';
import { useTheme } from '../theme/ThemeContext';
import { colors as baseColors, font, s } from '../theme/tokens';
import { pressFeedback } from '../theme/pressFeedback';
import { useAuth } from '../context/AuthContext';
import {
  backfillNotifications,
  loadDerivedNotifications,
  markNotificationsRead,
  subscribeNotifications,
  type AppNotification,
  type AppNotificationType,
} from '../lib/notifications';
import { useNav } from '../navigation/NavContext';

export type NotificationsScreenProps = {
  onClose?: () => void;
};

type NotificationsTheme = {
  bg: string;
  cardBg: string;
  cardBorder: string;
  text: string;
  textDim: string;
  accent: string;
  unreadBg: string;
};

const DOCK_BOTTOM_OFFSET = 28;
const DOCK_HEIGHT = 64;
const DOCK_CLEAR = DOCK_BOTTOM_OFFSET + DOCK_HEIGHT;
const NOTIFICATIONS_OPEN_DURATION = 320;
const NOTIFICATIONS_CLOSE_DURATION = 260;
const NOTIFICATIONS_SMOOTH_OUT = Easing.bezier(0.22, 1, 0.36, 1);
const NOTIFICATIONS_SMOOTH_IN = Easing.bezier(0.4, 0, 0.2, 1);

const FILTER_OPTIONS: Array<{ key: 'all' | 'sales' | 'likes' | 'comments' | 'follows'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'sales', label: 'Sales' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
  { key: 'follows', label: 'Follows' },
];

const formatRelativeTime = (timestampMs: number) => {
  if (!timestampMs) return 'Now';
  const delta = Math.max(0, Date.now() - timestampMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (delta < minute) return 'Just now';
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  if (delta < week) return `${Math.floor(delta / day)}d ago`;
  return `${Math.floor(delta / week)}w ago`;
};

const iconForType = (type: AppNotificationType) => {
  if (type === 'sale') return 'cash-outline';
  if (type === 'follow') return 'person-add-outline';
  if (type === 'post_comment') return 'chatbubble-ellipses-outline';
  return 'heart-outline';
};

const tintForType = (type: AppNotificationType) => {
  if (type === 'sale') return { bg: 'rgba(46, 125, 50, 0.12)', color: '#2e7d32' };
  if (type === 'follow') return { bg: 'rgba(13, 110, 253, 0.12)', color: '#0d6efd' };
  if (type === 'post_comment') return { bg: 'rgba(245, 124, 0, 0.12)', color: '#f57c00' };
  return { bg: 'rgba(229, 57, 53, 0.12)', color: '#e53935' };
};

export default function NotificationsScreen({ onClose }: NotificationsScreenProps) {
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const nav = useNav();
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const [filter, setFilter] = useState<'all' | 'sales' | 'likes' | 'comments' | 'follows'>('all');
  const [items, setItems] = useState<AppNotification[]>([]);
  const [derivedItems, setDerivedItems] = useState<AppNotification[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [derivedHydrated, setDerivedHydrated] = useState(false);

  const theme: NotificationsTheme = {
    bg: colors.bg,
    cardBg: isDark ? 'rgba(17,17,20,0.85)' : 'rgba(255,255,255,0.85)',
    cardBorder: isDark ? 'rgba(255,255,255,0.08)' : colors.borderLight,
    text: colors.text,
    textDim: colors.textDim,
    accent: colors.accent,
    unreadBg: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(13,110,253,0.04)',
  };

  const bottomPad = insets.bottom + DOCK_CLEAR + s(12);

  useEffect(() => {
    closingRef.current = false;
    anim.setValue(0);
    Animated.timing(anim, {
      toValue: 1,
      duration: NOTIFICATIONS_OPEN_DURATION,
      easing: NOTIFICATIONS_SMOOTH_OUT,
      useNativeDriver: true,
    }).start();
  }, [anim]);

  const close = useCallback((afterClose?: () => void) => {
    if (closingRef.current) return;
    closingRef.current = true;
    anim.stopAnimation(() => {
      Animated.timing(anim, {
        toValue: 0,
        duration: NOTIFICATIONS_CLOSE_DURATION,
        easing: NOTIFICATIONS_SMOOTH_IN,
        useNativeDriver: true,
      }).start(({ finished }) => {
        closingRef.current = false;
        if (!finished) return;
        if (afterClose) {
          afterClose();
          return;
        }
        onClose?.();
      });
    });
  }, [anim, onClose]);

  useEffect(() => {
    if (!user?.uid) {
      setItems([]);
      setHydrated(true);
      return;
    }
    setHydrated(false);
    const unsub = subscribeNotifications(user.uid, (next) => {
      setItems(next);
      setHydrated(true);
    });
    return () => unsub();
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) {
      setDerivedItems([]);
      setDerivedHydrated(true);
      return;
    }
    let cancelled = false;
    setDerivedHydrated(false);
    void loadDerivedNotifications(user.uid)
      .then((next) => {
        if (!cancelled) setDerivedItems(next);
      })
      .catch((error) => {
        console.warn('[NotificationsScreen] derived notifications failed', error);
        if (!cancelled) setDerivedItems([]);
      })
      .finally(() => {
        if (!cancelled) setDerivedHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) return;
    void backfillNotifications({ actorUid: user.uid, force: true });
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid || !items.length) return;
    const unreadIds = items.filter((item) => !item.read).map((item) => item.id);
    if (!unreadIds.length) return;
    void markNotificationsRead(user.uid, unreadIds).catch(() => {});
  }, [items, user?.uid]);

  const mergedItems = useMemo(() => {
    const byId = new Map<string, AppNotification>();
    derivedItems.forEach((item) => byId.set(item.id, item));
    items.forEach((item) => byId.set(item.id, item));
    return Array.from(byId.values()).sort((a, b) => b.createdAtMs - a.createdAtMs);
  }, [derivedItems, items]);

  const filteredItems = useMemo(() => {
    if (filter === 'all') return mergedItems;
    if (filter === 'sales') return mergedItems.filter((item) => item.type === 'sale');
    if (filter === 'follows') return mergedItems.filter((item) => item.type === 'follow');
    if (filter === 'comments') return mergedItems.filter((item) => item.type === 'post_comment');
    return mergedItems.filter(
      (item) =>
        item.type === 'listing_like' ||
        item.type === 'post_like' ||
        item.type === 'comment_like' ||
        item.type === 'reply_like'
    );
  }, [filter, mergedItems]);

  const handleOpenActor = useCallback((item: AppNotification) => {
    const actorUid = String(item.actorUid || '').trim();
    if (!actorUid || actorUid === user?.uid) return;
    close(() => {
      void nav.navigate({
        name: 'user',
        user: {
          id: actorUid,
          username: item.actorUsername || item.actorDisplayName || 'user',
          avatarUri: item.actorPhotoURL || '',
          bio: '',
          source: 'real',
        },
      } as any);
    });
  }, [close, nav, user?.uid]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: theme.bg },
        content: {
          paddingHorizontal: s(2.2),
          paddingTop: s(2.2),
          paddingBottom: bottomPad,
        },
        intro: {
          ...font.meta,
          color: theme.textDim,
          lineHeight: 17,
          marginTop: s(0.6),
          marginBottom: s(1.8),
        },
        stack: {
          gap: s(1),
          marginTop: s(1.8),
        },
        card: {
          borderRadius: 18,
          borderWidth: 1,
          borderColor: theme.cardBorder,
          backgroundColor: theme.cardBg,
          paddingHorizontal: s(1.4),
          paddingVertical: s(1.35),
        },
        unreadCard: {
          backgroundColor: theme.unreadBg,
        },
        row: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: s(1.1),
        },
        actorWrap: {
          width: 42,
          height: 42,
          borderRadius: 21,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.7)',
          borderWidth: 1,
          borderColor: theme.cardBorder,
          flexShrink: 0,
        },
        actorImage: {
          width: '100%',
          height: '100%',
        },
        actorFallback: {
          width: '100%',
          height: '100%',
          alignItems: 'center',
          justifyContent: 'center',
        },
        body: {
          flex: 1,
          minHeight: 0,
        },
        topRow: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: s(0.8),
          marginBottom: 2,
        },
        title: {
          ...font.h3,
          color: theme.text,
          flex: 1,
          marginBottom: 0,
          fontSize: 15,
        },
        time: {
          ...font.meta,
          color: theme.textDim,
          fontSize: 11,
        },
        bodyText: {
          ...font.p,
          color: theme.textDim,
          lineHeight: 17,
          fontSize: 13,
        },
        footer: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(0.8),
          marginTop: s(1),
        },
        pill: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(0.7),
          paddingHorizontal: s(1.1),
          paddingVertical: s(0.55),
          borderRadius: 999,
        },
        pillText: {
          ...font.meta,
          fontWeight: '800',
          fontSize: 10,
        },
        unreadDot: {
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.accent,
        },
        previewWrap: {
          width: 48,
          height: 60,
          borderRadius: 12,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: theme.cardBorder,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.72)',
          flexShrink: 0,
        },
        previewImage: {
          width: '100%',
          height: '100%',
        },
        previewFallback: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
        },
        emptyCard: {
          borderRadius: 18,
          borderWidth: 1,
          borderColor: theme.cardBorder,
          backgroundColor: theme.cardBg,
          paddingHorizontal: s(2.2),
          paddingVertical: s(2.6),
          alignItems: 'center',
          marginTop: s(1.8),
        },
        emptyTitle: {
          ...font.meta,
          color: theme.text,
          fontWeight: '900',
          marginTop: s(1.2),
          marginBottom: s(0.8),
        },
        emptyBody: {
          ...font.meta,
          color: theme.textDim,
          textAlign: 'center',
          lineHeight: 18,
        },
      }),
    [bottomPad, isDark, theme]
  );

  return (
    <Animated.View
      style={{
        flex: 1,
        opacity: anim,
        transform: [
          {
            translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }),
          },
        ],
      }}
    >
      <View style={styles.root}>
        <MinimalHeader
          title="Notifications"
          onRightPress={close}
          rightIcon="close"
          rightA11yLabel="Close notifications"
        />

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
        >
          <Text style={styles.intro}>
            Keep up with sales, likes, comments, and new followers from one place.
          </Text>

          <SegmentedChips
            options={FILTER_OPTIONS as any}
            value={filter}
            onChange={(value) => setFilter(value as any)}
          />

          {!hydrated || !derivedHydrated ? (
            <View style={styles.emptyCard}>
              <ActivityIndicator color={baseColors.accent} />
            </View>
          ) : filteredItems.length ? (
            <View style={styles.stack}>
              {filteredItems.map((item) => {
                const typeTone = tintForType(item.type);
                return (
                  <Pressable
                    key={item.id}
                    style={({ pressed }) => [
                      styles.card,
                      !item.read && styles.unreadCard,
                      pressFeedback(pressed, 'subtle'),
                    ]}
                    onPress={() => handleOpenActor(item)}
                  >
                    <View style={styles.row}>
                      <View style={styles.actorWrap}>
                        {item.actorPhotoURL ? (
                          <ExpoImage
                            source={{ uri: item.actorPhotoURL }}
                            style={styles.actorImage}
                            contentFit="cover"
                          />
                        ) : (
                          <View style={styles.actorFallback}>
                            <Ionicons name="person-outline" size={18} color={theme.textDim} />
                          </View>
                        )}
                      </View>

                      <View style={styles.body}>
                        <View style={styles.topRow}>
                          <Text style={styles.title} numberOfLines={1}>
                            {item.title}
                          </Text>
                          <Text style={styles.time}>{formatRelativeTime(item.createdAtMs)}</Text>
                        </View>
                        <Text style={styles.bodyText}>
                          {item.body}
                        </Text>
                        <View style={styles.footer}>
                          <View style={[styles.pill, { backgroundColor: typeTone.bg }]}>
                            <Ionicons name={iconForType(item.type)} size={14} color={typeTone.color} />
                            <Text style={[styles.pillText, { color: typeTone.color }]}>
                              {item.type === 'sale'
                                ? 'Sale'
                                : item.type === 'follow'
                                  ? 'Follower'
                                  : item.type === 'post_comment'
                                    ? 'Comment'
                                    : 'Like'}
                            </Text>
                          </View>
                          {!item.read ? <View style={styles.unreadDot} /> : null}
                        </View>
                      </View>

                      <View style={styles.previewWrap}>
                        {item.imageUri ? (
                          <ExpoImage
                            source={{ uri: item.imageUri }}
                            style={styles.previewImage}
                            contentFit="cover"
                          />
                        ) : (
                          <View style={styles.previewFallback}>
                            <Ionicons name={iconForType(item.type)} size={18} color={typeTone.color} />
                          </View>
                        )}
                      </View>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <Glass style={styles.emptyCard}>
              <Ionicons name="notifications-outline" size={22} color={theme.textDim} />
              <Text style={styles.emptyTitle}>No notifications yet</Text>
              <Text style={styles.emptyBody}>
                New sales, likes, comments, and followers will appear here.
              </Text>
            </Glass>
          )}
        </ScrollView>
      </View>
    </Animated.View>
  );
}
