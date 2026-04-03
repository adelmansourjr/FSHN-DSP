import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  Text,
  TextInput,
  Pressable,
  FlatList,
  Dimensions,
  Animated,
  Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { hairline, s } from '../theme/tokens';
import { pressFeedback } from '../theme/pressFeedback';
import type { Item } from '../data/mock';
import ItemCard from './ItemCard';
import type { SearchPost, SearchUser } from './HeaderSearchOverlay';
import UserAvatar from './UserAvatar';
import CachedImage from './ui/CachedImage';
import { warmImageCache } from '../lib/imageCache';
import { useTheme } from '../theme/ThemeContext';

type Props = {
  visible: boolean;
  query: string;
  onChangeQuery: (value: string) => void;
  scope: 'users' | 'posts' | 'listings';
  listingResults: Item[];
  userResults: SearchUser[];
  postResults: SearchPost[];
  onBack: () => void;
  onSelectItem: (item: Item) => void;
  onSelectUser: (user: SearchUser) => void;
  onSelectPost: (post: SearchPost) => void;
};

export default function SearchResultsPage({
  visible,
  query,
  onChangeQuery,
  scope,
  listingResults,
  userResults,
  postResults,
  onBack,
  onSelectItem,
  onSelectUser,
  onSelectPost,
}: Props) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const screenWidth = Dimensions.get('window').width;
  const cardWidth = Math.floor((screenWidth - s(8) - s(2)) / 2);
  const [mounted, setMounted] = useState(visible);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateX = useRef(new Animated.Value(18)).current;

  useEffect(() => {
    if (!visible) return;
    const uris = [
      ...listingResults.slice(0, 24).map((item) => item.image),
      ...postResults.slice(0, 24).map((post) => post.image),
      ...userResults.slice(0, 24).map((user) => user.avatarUri || ''),
    ];
    void warmImageCache(uris, {
      cachePolicy: 'memory-disk',
      chunkSize: 18,
    });
  }, [listingResults, postResults, userResults, visible]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      opacity.setValue(0);
      translateX.setValue(18);
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 220,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(translateX, {
          toValue: 0,
          duration: 260,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }

    if (mounted) {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 180,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(translateX, {
          toValue: 18,
          duration: 200,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(() => setMounted(false));
    }
  }, [visible, mounted, opacity, translateX]);

  const styles = React.useMemo(
    () =>
      StyleSheet.create({
        root: {
          ...StyleSheet.absoluteFillObject,
          backgroundColor: isDark ? 'rgba(13,13,16,0.98)' : '#fff',
          paddingHorizontal: s(4),
          gap: s(3),
          zIndex: 20,
        },
        headerRow: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        backBtn: {
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
        },
        title: { fontSize: 20, fontWeight: '800', color: colors.text },
        inputRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(2),
          paddingHorizontal: s(3),
          paddingVertical: s(3),
          borderRadius: 16,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(245,245,245,0.9)',
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
        sectionHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        sectionTitle: { fontSize: 14, fontWeight: '800', color: colors.text },
        sectionMeta: { fontSize: 12, color: colors.textDim, fontWeight: '700' },
        grid: { paddingBottom: s(10), gap: s(2) },
        columnRow: { justifyContent: 'space-between', marginBottom: s(2) },
        gridItem: { flex: 1 },
        list: { paddingBottom: s(8), gap: s(2) },
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
        empty: {
          paddingVertical: s(6),
          alignItems: 'center',
          justifyContent: 'center',
        },
        emptyText: { fontSize: 13, color: colors.textDim, fontWeight: '600' },
      }),
    [colors, isDark]
  );

  if (!mounted) return null;

  return (
    <Animated.View
      style={[
        styles.root,
        {
          paddingTop: insets.top + s(2),
          paddingBottom: insets.bottom + s(4),
          opacity,
          transform: [{ translateX }],
        },
      ]}
    >
      <View style={styles.headerRow}>
        <Pressable onPress={onBack} style={({ pressed }) => [styles.backBtn, pressFeedback(pressed)]} hitSlop={8}>
          <Ionicons name="chevron-back" size={18} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Results</Text>
        <View style={{ width: 34 }} />
      </View>

      <View style={styles.inputRow}>
        <Ionicons name="search" size={16} color={colors.textDim} />
        <TextInput
          value={query}
          onChangeText={onChangeQuery}
          placeholder={`Search ${scope}`}
          placeholderTextColor={colors.textDim}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>
          {scope === 'users' ? 'Users' : scope === 'posts' ? 'Posts' : 'Listings'}
        </Text>
        <Text style={styles.sectionMeta}>
          {scope === 'users'
            ? userResults.length
            : scope === 'posts'
              ? postResults.length
              : listingResults.length}{' '}
          results found
        </Text>
      </View>

      {scope === 'users' ? (
        <FlatList
          data={userResults}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.userRow, pressFeedback(pressed)]}
              onPress={() => onSelectUser(item)}
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
      ) : scope === 'posts' ? (
        <FlatList
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
              onPress={() => onSelectPost(item)}
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
      ) : (
        <FlatList
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
                onPress={() => onSelectItem(item)}
              />
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No listings found. Try another search.</Text>
            </View>
          }
        />
      )}
    </Animated.View>
  );
}
