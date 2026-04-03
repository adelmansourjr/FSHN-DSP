import React, { useEffect, useMemo, useRef } from 'react';
import {
  View,
  StyleSheet,
  Modal,
  Pressable,
  Text,
  TextInput,
  Keyboard,
  Animated,
  Easing,
  FlatList,
  Platform,
  Dimensions,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { hairline, s } from '../theme/tokens';
import { pressFeedback } from '../theme/pressFeedback';
import type { Item } from '../data/mock';
import ItemCard from './ItemCard';
import SegmentedChips from './ui/SegmentedChips';
import UserAvatar from './UserAvatar';
import CachedImage from './ui/CachedImage';
import { warmImageCache } from '../lib/imageCache';
import { useTheme } from '../theme/ThemeContext';

type Scope = 'users' | 'posts' | 'listings';

export type SearchUser = {
  id: string;
  username: string;
  displayName?: string | null;
  avatarUri?: string | null;
  bio?: string | null;
};

export type SearchPost = {
  id: string;
  image: string;
  caption?: string | null;
  authorId?: string | null;
  authorUsername?: string | null;
};

type Props = {
  visible: boolean;
  value: string;
  onChangeText: (value: string) => void;
  scope: Scope;
  onScopeChange: (value: Scope) => void;
  onClose: () => void;
  recent?: string[];
  listingResults?: Item[];
  userResults?: SearchUser[];
  postResults?: SearchPost[];
  onOpenResults?: (item?: Item | SearchUser | SearchPost) => void;
  onSelectUser?: (user: SearchUser) => void;
  onSelectPost?: (post: SearchPost) => void;
};

const OPTIONS = [
  { key: 'users', label: 'Users' },
  { key: 'posts', label: 'Posts' },
  { key: 'listings', label: 'Listings' },
] as const;

export default function HeaderSearchOverlay({
  visible,
  value,
  onChangeText,
  scope,
  onScopeChange,
  onClose,
  recent = [],
  listingResults = [],
  userResults = [],
  postResults = [],
  onOpenResults,
  onSelectUser,
  onSelectPost,
}: Props) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const screenWidth = Dimensions.get('window').width;
  const inputRef = useRef<TextInput>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(18)).current;

  useEffect(() => {
    if (!visible) return;
    opacity.setValue(0);
    translateY.setValue(18);
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();

    const timer = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, [visible, opacity, translateY]);

  const handleClose = () => {
    Keyboard.dismiss();
    onClose();
  };

  const data = useMemo(() => recent.filter(Boolean), [recent]);
  const hasQuery = value.trim().length > 0;
  const showListings = scope === 'listings' && hasQuery;
  const showUsers = scope === 'users' && hasQuery;
  const showPosts = scope === 'posts' && hasQuery;
  const showRecent = !showListings && !showUsers && !showPosts;
  const cardWidth = useMemo(() => Math.floor((screenWidth - s(8) - s(2)) / 2), [screenWidth]);

  useEffect(() => {
    if (!visible) return;
    const uris = [
      ...listingResults.slice(0, 20).map((item) => item.image),
      ...postResults.slice(0, 24).map((post) => post.image),
      ...userResults.slice(0, 24).map((user) => user.avatarUri || ''),
    ];
    void warmImageCache(uris, {
      cachePolicy: 'memory-disk',
      chunkSize: 18,
    });
  }, [listingResults, postResults, userResults, visible]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1 },
        sheet: {
          flex: 1,
          paddingHorizontal: s(4),
          gap: s(3),
          backgroundColor: isDark
            ? 'rgba(13,13,16,0.96)'
            : Platform.OS === 'ios'
              ? 'rgba(255,255,255,0.92)'
              : '#ffffff',
        },
        headerRow: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        title: { fontSize: 22, fontWeight: '800', color: colors.text },
        closeBtn: {
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.8)',
        },
        inputRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(2),
          paddingHorizontal: s(3),
          paddingVertical: s(3),
          borderRadius: 16,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
          borderWidth: hairline,
          borderColor: colors.borderLight,
        },
        input: {
          flex: 1,
          fontSize: 15,
          color: colors.text,
          fontWeight: '600',
          paddingVertical: 0,
        },
        segmentWrap: {
          gap: s(2),
        },
        label: {
          fontSize: 12,
          fontWeight: '800',
          color: colors.textDim,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
        },
        sectionHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: s(2),
        },
        sectionTitle: {
          fontSize: 14,
          fontWeight: '800',
          color: colors.text,
        },
        sectionMeta: { fontSize: 12, color: colors.textDim, fontWeight: '700' },
        list: {
          paddingBottom: s(8),
          gap: s(2),
        },
        grid: {
          paddingBottom: s(10),
          gap: s(2),
        },
        showAllBtn: {
          marginTop: s(1),
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: s(3),
          paddingVertical: s(2.5),
          borderRadius: 12,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.85)',
        },
        showAllText: { fontSize: 13, fontWeight: '700', color: colors.text },
        columnRow: {
          justifyContent: 'space-between',
          marginBottom: s(2),
        },
        gridItem: {
          flex: 1,
        },
        userRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(2),
          paddingVertical: s(2),
          paddingHorizontal: s(2),
          borderRadius: 14,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.8)',
        },
        userAvatar: {
          width: 36,
          height: 36,
          borderRadius: 18,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#eee',
          overflow: 'hidden',
        },
        userName: { fontWeight: '800', color: colors.text },
        userMeta: { fontSize: 12, color: colors.textDim, marginTop: 2 },
        postThumb: {
          width: '100%',
          aspectRatio: 1,
          borderRadius: 14,
          overflow: 'hidden',
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f4f4f4',
        },
        postThumbImg: { width: '100%', height: '100%' },
        recentRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(2),
          paddingVertical: s(2.5),
          paddingHorizontal: s(2),
          borderRadius: 12,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.85)',
          borderWidth: hairline,
          borderColor: colors.borderLight,
        },
        recentText: { fontSize: 14, color: colors.text, fontWeight: '600' },
        empty: {
          paddingVertical: s(6),
          alignItems: 'center',
          justifyContent: 'center',
        },
        emptyText: { fontSize: 13, color: colors.textDim, fontWeight: '600' },
      }),
    [colors, isDark]
  );

  return (
    <Modal visible={visible} animationType="fade" transparent statusBarTranslucent presentationStyle="overFullScreen">
      <View style={styles.root}>
        <BlurView intensity={18} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />

        <Animated.View
          style={[
            styles.sheet,
            {
              paddingTop: insets.top + s(3),
              paddingBottom: insets.bottom + s(4),
              opacity,
              transform: [{ translateY }],
            },
          ]}
        >
          <View style={styles.headerRow}>
            <Text style={styles.title}>Search</Text>
            <Pressable
              onPress={handleClose}
              style={({ pressed }) => [styles.closeBtn, pressFeedback(pressed)]}
              hitSlop={8}
            >
              <Ionicons name="close" size={18} color={colors.text} />
            </Pressable>
          </View>

          <View style={styles.inputRow}>
            <Ionicons name="search" size={16} color={colors.textDim} />
            <TextInput
              ref={inputRef}
              value={value}
              onChangeText={onChangeText}
              placeholder={`Search ${scope}`}
              placeholderTextColor={colors.textDim}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              autoFocus
            />
          </View>

          <View style={styles.segmentWrap}>
            <Text style={styles.label}>Search in</Text>
            <SegmentedChips
              options={[...OPTIONS]}
              value={scope}
              onChange={(key) => onScopeChange(key as Scope)}
            />
          </View>

          {showListings ? (
            <>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Listings</Text>
                <Text style={styles.sectionMeta}>{listingResults.length} results found</Text>
              </View>
              <Pressable
                style={({ pressed }) => [styles.showAllBtn, pressFeedback(pressed)]}
                onPress={() => onOpenResults?.()}
              >
                <Text style={styles.showAllText}>Show all results</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.text} />
              </Pressable>
              <FlatList
                key="listing-grid-2"
                data={listingResults}
                keyExtractor={(item) => item.id}
                numColumns={2}
                columnWrapperStyle={styles.columnRow}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.grid}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <View style={[styles.gridItem, { width: cardWidth }]}>
                    <ItemCard
                      title={item.title}
                      image={item.image}
                      price={item.price}
                      width={cardWidth}
                      onPress={() => onOpenResults?.(item)}
                    />
                  </View>
                )}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Text style={styles.emptyText}>No listings found. Try another search.</Text>
                  </View>
                }
              />
            </>
          ) : showUsers ? (
            <>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Users</Text>
                <Text style={styles.sectionMeta}>{userResults.length} results found</Text>
              </View>
              <Pressable
                style={({ pressed }) => [styles.showAllBtn, pressFeedback(pressed)]}
                onPress={() => onOpenResults?.()}
              >
                <Text style={styles.showAllText}>Show all results</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.text} />
              </Pressable>
              <FlatList
                key="user-list-1"
                data={userResults}
                keyExtractor={(item) => item.id}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.list}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <Pressable
                    style={({ pressed }) => [styles.userRow, pressFeedback(pressed)]}
                    onPress={() => onSelectUser?.(item)}
                  >
                    <UserAvatar uri={item.avatarUri} size={36} style={styles.userAvatar} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.userName}>@{item.username}</Text>
                      {!!item.displayName && <Text style={styles.userMeta}>{item.displayName}</Text>}
                    </View>
                  </Pressable>
                )}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Text style={styles.emptyText}>No users found. Try another search.</Text>
                  </View>
                }
              />
            </>
          ) : showPosts ? (
            <>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Posts</Text>
                <Text style={styles.sectionMeta}>{postResults.length} results found</Text>
              </View>
              <Pressable
                style={({ pressed }) => [styles.showAllBtn, pressFeedback(pressed)]}
                onPress={() => onOpenResults?.()}
              >
                <Text style={styles.showAllText}>Show all results</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.text} />
              </Pressable>
              <FlatList
                key="post-grid-2"
                data={postResults}
                keyExtractor={(item) => item.id}
                numColumns={2}
                columnWrapperStyle={styles.columnRow}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.grid}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <Pressable
                    style={({ pressed }) => [styles.gridItem, { width: cardWidth }, pressFeedback(pressed, 'subtle')]}
                    onPress={() => onSelectPost?.(item)}
                  >
                    <View style={styles.postThumb}>
                      <CachedImage
                        source={{ uri: item.image }}
                        style={styles.postThumbImg}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        transition={140}
                        borderRadius={14}
                      />
                    </View>
                  </Pressable>
                )}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Text style={styles.emptyText}>No posts found. Try another search.</Text>
                  </View>
                }
              />
            </>
          ) : (
            <>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Recent searches</Text>
              </View>
              <FlatList
                key="recent-list-1"
                data={data}
                keyExtractor={(item, idx) => `${item}-${idx}`}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.list}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <Pressable
                    style={({ pressed }) => [styles.recentRow, pressFeedback(pressed)]}
                    onPress={() => onChangeText(item)}
                  >
                    <Ionicons name="time-outline" size={16} color={colors.textDim} />
                    <Text style={styles.recentText}>{item}</Text>
                  </Pressable>
                )}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Text style={styles.emptyText}>No recent searches yet.</Text>
                  </View>
                }
              />
            </>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}
