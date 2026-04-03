import React, { useEffect, useMemo, useRef } from 'react';
import { ActivityIndicator, Animated, Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import Glass from '../Glass';
import UserAvatar from '../UserAvatar';
import PostGarmentRow from './PostGarmentRow';
import PostEngagementRow from './PostEngagementRow';
import type { ProductLike } from '../ProductModal';
import { useTheme } from '../../theme/ThemeContext';
import { pressFeedback } from '../../theme/pressFeedback';
import { font, hairline, s } from '../../theme/tokens';
import RevealOnMount from '../ui/RevealOnMount';
import CachedImage from '../ui/CachedImage';

const { width: W, height: H } = Dimensions.get('window');
const IMG_H = Math.round(H * 0.52);
const CARD_R = 20;

export type FeedPostCardUser = {
  id: string;
  username: string;
  avatarUri?: string | null;
};

export type FeedPostCardData = {
  id: string;
  user: FeedPostCardUser;
  modelUri: string;
  likes: number;
  commentCount: number;
  caption?: string | null;
  garments: ProductLike[];
};

type Props = {
  post: FeedPostCardData;
  liked: boolean;
  isFollowing: boolean;
  canFollow: boolean;
  isOwnPost: boolean;
  onOpenProduct: (product: ProductLike) => void;
  onOpenUser: (user: FeedPostCardUser) => void;
  onToggleFollow: () => void;
  onOpenOptions: () => void;
  onOpenComments?: () => void;
  onToggleLike?: () => void;
  optionsBusy?: boolean;
};

export default function FeedPostCard({
  post,
  liked,
  isFollowing,
  canFollow,
  isOwnPost,
  onOpenProduct,
  onOpenUser,
  onToggleFollow,
  onOpenOptions,
  onOpenComments,
  onToggleLike,
  optionsBusy = false,
}: Props) {
  const { colors, isDark } = useTheme();
  const lastImageTapAtRef = useRef(0);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartScale = useRef(new Animated.Value(0.7)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          borderRadius: CARD_R,
          overflow: 'hidden',
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(17,17,20,0.85)' : 'rgba(255,255,255,0.86)',
        },
        postHeader: {
          paddingHorizontal: s(3),
          paddingTop: s(2),
          paddingBottom: s(1.2),
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.78)',
          borderBottomWidth: hairline,
          borderBottomColor: colors.borderLight,
        },
        userLeft: { flexDirection: 'row', alignItems: 'center', gap: s(2), flexShrink: 1 },
        avatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#EEE' },
        username: { fontWeight: '800', color: colors.text, maxWidth: W * 0.46 },
        headerActions: { flexDirection: 'row', alignItems: 'center', gap: s(1.2) },
        followPill: {
          minWidth: 66,
          height: 28,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: s(1.4),
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
        },
        followingPill: {
          minWidth: 78,
          height: 28,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: s(1.5),
          borderWidth: hairline,
          borderColor: colors.text,
          backgroundColor: isDark ? '#fff' : colors.text,
        },
        followTxt: {
          ...font.meta,
          color: colors.text,
          fontWeight: '800',
        },
        followingTxt: {
          ...font.meta,
          color: isDark ? colors.bg : '#fff',
          fontWeight: '800',
        },
        iconPill: {
          width: 28,
          height: 28,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
        },
        imageWrap: { width: '100%', height: IMG_H, backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : '#fff' },
        image: { width: '100%', height: '100%' },
        imageOverlayTap: {
          ...StyleSheet.absoluteFillObject,
        },
        likeBurst: {
          position: 'absolute',
          top: '50%',
          left: '50%',
          marginLeft: -34,
          marginTop: -34,
          width: 68,
          height: 68,
          borderRadius: 34,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.16)',
        },
        garmentsWrap: {
          paddingHorizontal: s(3),
          paddingTop: s(1),
          paddingBottom: s(0.9),
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.78)',
          borderTopWidth: hairline,
          borderTopColor: colors.borderLight,
        },
        engagementWrap: {
          paddingHorizontal: s(3),
          paddingTop: s(1),
          paddingBottom: s(0.9),
        },
        captionWrap: {
          paddingHorizontal: s(3),
          paddingBottom: s(1.1),
        },
        captionSpacer: {
          height: s(0.7),
        },
        caption: { ...font.p, color: colors.text, lineHeight: 18 },
      }),
    [colors, isDark]
  );

  useEffect(() => {
    return () => {
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
    };
  }, []);

  const animateLikeBurst = () => {
    heartScale.setValue(0.7);
    heartOpacity.setValue(0);
    Animated.parallel([
      Animated.timing(heartOpacity, {
        toValue: 1,
        duration: 120,
        useNativeDriver: true,
      }),
      Animated.spring(heartScale, {
        toValue: 1,
        friction: 6,
        tension: 140,
        useNativeDriver: true,
      }),
    ]).start(() => {
      Animated.timing(heartOpacity, {
        toValue: 0,
        duration: 220,
        delay: 140,
        useNativeDriver: true,
      }).start();
    });
  };

  const handleImagePress = () => {
    const now = Date.now();
    if (now - lastImageTapAtRef.current < 250) {
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      lastImageTapAtRef.current = 0;
      if (!liked) {
        onToggleLike?.();
      }
      animateLikeBurst();
      return;
    }
    lastImageTapAtRef.current = now;
    singleTapTimerRef.current = setTimeout(() => {
      singleTapTimerRef.current = null;
      lastImageTapAtRef.current = 0;
      onOpenComments?.();
    }, 250);
  };

  const showFollow = canFollow && !isOwnPost;

  return (
    <RevealOnMount delay={35} distance={12}>
      <Glass style={styles.card}>
      <View style={styles.postHeader}>
        <Pressable
          onPress={() => onOpenUser(post.user)}
          style={({ pressed }) => [styles.userLeft, pressFeedback(pressed, 'subtle')]}
          hitSlop={8}
        >
          <UserAvatar uri={post.user.avatarUri || ''} size={28} style={styles.avatar} transition={80} />
          <Text style={styles.username} numberOfLines={1}>@{post.user.username}</Text>
        </Pressable>

        <View style={styles.headerActions}>
          {showFollow && (
            <Pressable
              onPress={onToggleFollow}
              style={({ pressed }) => [
                isFollowing ? styles.followingPill : styles.followPill,
                pressFeedback(pressed),
              ]}
              hitSlop={8}
            >
              <Text style={isFollowing ? styles.followingTxt : styles.followTxt}>
                {isFollowing ? 'Following' : 'Follow'}
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={onOpenOptions}
            style={({ pressed }) => [styles.iconPill, pressFeedback(pressed)]}
            hitSlop={8}
            disabled={optionsBusy}
          >
            {optionsBusy ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : (
              <Ionicons name="ellipsis-horizontal" size={16} color={colors.text} />
            )}
          </Pressable>
        </View>
      </View>

      <View style={styles.imageWrap}>
        <CachedImage
          source={{ uri: post.modelUri }}
          style={styles.image}
          contentFit="contain"
          contentPosition="center"
          cachePolicy="memory-disk"
          transition={100}
          priority="high"
          borderRadius={0}
        />
        <Pressable
          onPress={handleImagePress}
          style={({ pressed }) => [styles.imageOverlayTap, pressed ? { opacity: 0.98 } : null]}
          disabled={!onOpenComments && !onToggleLike}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.likeBurst,
            {
              opacity: heartOpacity,
              transform: [{ scale: heartScale }],
            },
          ]}
        >
          <Ionicons name="heart" size={36} color="#fff" />
        </Animated.View>
      </View>

      <View style={styles.engagementWrap}>
        <PostEngagementRow
          likes={post.likes || 0}
          comments={post.commentCount || 0}
          liked={liked}
          onToggleLike={onToggleLike}
          onPressComments={onOpenComments}
        />
      </View>

      {post.garments.length > 0 && (
        <View style={styles.garmentsWrap}>
          <PostGarmentRow garments={post.garments} onPressItem={onOpenProduct} />
        </View>
      )}

      {!!post.caption && (
        <View style={styles.captionWrap}>
          <Text style={styles.caption} numberOfLines={1}>
            {post.caption}
          </Text>
        </View>
      )}
      {!post.caption && <View style={styles.captionSpacer} />}
      </Glass>
    </RevealOnMount>
  );
}
