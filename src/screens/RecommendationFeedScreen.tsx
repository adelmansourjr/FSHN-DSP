import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Item } from '../data/mock';
import type { RecommendationMode } from '../lib/recommendations';
import { hairline, s } from '../theme/tokens';
import { useTheme } from '../theme/ThemeContext';
import { pressFeedback } from '../theme/pressFeedback';
import ItemCard from '../components/ItemCard';
import MinimalHeader from '../components/MinimalHeader';
import HeaderSearchOverlay from '../components/HeaderSearchOverlay';
import SearchResultsPage from '../components/SearchResultsPage';
import VisionSheet from '../components/Vision/VisionSheet';
import type { VisionPoolItem, VisionSlot } from '../components/Vision/visionEngine';
import ProductModal, { type ProductLike } from '../components/ProductModal';
import type { SearchPost, SearchUser } from '../components/HeaderSearchOverlay';
import { useNav } from '../navigation/NavContext';
import { useAuth } from '../context/AuthContext';
import { listingItemToProduct, type ListingItem } from '../lib/firestoreMappers';
import { useListingLikes } from '../lib/listingLikes';
import { warmImageCache } from '../lib/imageCache';

const { width: W } = Dimensions.get('window');

type Props = {
  initialMode: RecommendationMode;
  trendingItems: Item[];
  discoverItems: Item[];
  onClose: () => void;
};

const ROLE_TO_CATEGORY: Record<Item['role'] extends never ? string : NonNullable<Item['role']>, string> = {
  top: 'Top',
  bottom: 'Bottom',
  dress: 'Dress',
  outer: 'Outerwear',
  shoes: 'Shoes',
  accessory: 'Accessory',
};

const normalizeText = (value: string) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenizeQuery = (value: string) => normalizeText(value).split(' ').filter(Boolean);

const scoreText = (hay: string, tokens: string[]) => {
  if (!tokens.length) return 0;
  const normalized = normalizeText(hay);
  if (!normalized) return 0;
  let score = 0;
  tokens.forEach((t) => {
    if (normalized.includes(t)) score += 1;
  });
  if (!score) return 0;
  if (normalized.startsWith(tokens[0])) score += 0.5;
  return score;
};

const sexPreferenceToGenderPref = (value?: string | null): 'any' | 'men' | 'women' => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'male') return 'men';
  if (raw === 'female') return 'women';
  return 'any';
};

export default function RecommendationFeedScreen({
  initialMode,
  trendingItems,
  discoverItems,
  onClose,
}: Props) {
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const { user, profile } = useAuth();
  const { isLiked, setLiked } = useListingLikes(user?.uid);
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);

  const [mode, setMode] = useState<RecommendationMode>(initialMode);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<'users' | 'posts' | 'listings'>('listings');
  const [resultsOpen, setResultsOpen] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([
    'baggy jeans',
    'vintage denim',
    'street hoodie',
    'smart casual',
  ]);
  const [visionVisible, setVisionVisible] = useState(false);
  const [activeProduct, setActiveProduct] = useState<ProductLike | null>(null);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [switchDir, setSwitchDir] = useState<1 | -1>(1);
  const listTransition = useRef(new Animated.Value(1)).current;
  const switchingModeRef = useRef(false);

  useEffect(() => {
    setMode(initialMode);
    listTransition.setValue(1);
    switchingModeRef.current = false;
  }, [initialMode, listTransition]);

  const allItems = useMemo(() => {
    const out: Item[] = [];
    const seen = new Set<string>();
    [...trendingItems, ...discoverItems].forEach((item, idx) => {
      const id = String(item.id || `rec-${idx}`);
      if (seen.has(id)) return;
      seen.add(id);
      out.push(item);
    });
    return out;
  }, [discoverItems, trendingItems]);

  const activeItems = mode === 'trending' ? trendingItems : discoverItems;
  const cardWidth = Math.floor((W - s(6) - s(2)) / 2);
  const title = mode === 'trending' ? 'Trending Feed' : 'Discover Feed';
  const visionGenderPref = useMemo(
    () => sexPreferenceToGenderPref((profile as any)?.sexPreference),
    [(profile as any)?.sexPreference]
  );

  useEffect(() => {
    void warmImageCache(
      allItems.slice(0, 72).map((item) => item.image),
      { cachePolicy: 'memory-disk', chunkSize: 24 }
    );
  }, [allItems]);

  const itemToProduct = useCallback((it: Item): ProductLike => {
    const listingItem = it as ListingItem;
    if (listingItem?.source === 'listing') return listingItemToProduct(listingItem);
    return {
      id: it.id,
      title: it.title,
      price: it.price ?? undefined,
      images: [it.image],
      image: it.image,
      colorName: it.colorName ?? undefined,
      colorHex: it.colorHex ?? undefined,
      imagePath: (it as any).imagePath ?? undefined,
      category: it.role ? ROLE_TO_CATEGORY[it.role] : undefined,
      likeCount:
        typeof (it as any)?.likeCount === 'number'
          ? Math.max(0, Math.round((it as any).likeCount))
          : typeof (it as any)?.likes === 'number'
            ? Math.max(0, Math.round((it as any).likes))
            : null,
    } as ProductLike;
  }, []);

  const onPressItem = useCallback((it: Item) => {
    const product = itemToProduct(it);
    setActiveProduct(product);
    setActiveProductId(product.id || null);
    setModalOpen(true);
  }, [itemToProduct]);

  const addRecent = useCallback((value: string) => {
    const next = value.trim();
    if (!next) return;
    setRecentSearches((prev) => [next, ...prev.filter((v) => v.toLowerCase() !== next.toLowerCase())].slice(0, 8));
  }, []);

  const openResults = useCallback((item?: Item | SearchUser | SearchPost) => {
    addRecent(searchQuery);
    setSearchOpen(false);
    setResultsOpen(true);
    if (item && searchScope === 'listings') {
      setTimeout(() => onPressItem(item as Item), 260);
    }
  }, [addRecent, onPressItem, searchQuery, searchScope]);

  const closeResults = useCallback(() => {
    setResultsOpen(false);
    setTimeout(() => setSearchOpen(true), 220);
  }, []);

  const closeSearchOverlay = useCallback(() => {
    setSearchOpen(false);
    setTimeout(() => setSearchQuery(''), 240);
  }, []);

  const listingResults = useMemo(() => {
    if (searchScope !== 'listings') return [];
    const tokens = tokenizeQuery(searchQuery);
    if (!tokens.length) return [];
    return allItems
      .map((item, idx) => {
        const listingItem = item as ListingItem;
        const hay = [
          item.title,
          item.colorName,
          item.role,
          listingItem.category,
          listingItem.brand,
          listingItem.description,
          ...(listingItem.tags || []),
          ...(listingItem.colors || []),
        ]
          .filter(Boolean)
          .join(' ');
        const score = scoreText(hay, tokens);
        if (!score) return null;
        return { item, score, idx };
      })
      .filter((entry): entry is { item: Item; score: number; idx: number } => Boolean(entry))
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .map((entry) => entry.item);
  }, [allItems, searchQuery, searchScope]);

  const onSelectVisionAppItem = useCallback((item: VisionPoolItem, _slot: VisionSlot) => {
    const product = itemToProduct(item as Item);
    setActiveProduct(product);
    setActiveProductId(product.id || null);
    setModalOpen(true);
    setVisionVisible(false);
  }, [itemToProduct]);

  const switchModeSmooth = useCallback((nextMode: RecommendationMode) => {
    if (nextMode === mode || switchingModeRef.current) return;
    switchingModeRef.current = true;
    const currentIdx = mode === 'trending' ? 0 : 1;
    const nextIdx = nextMode === 'trending' ? 0 : 1;
    setSwitchDir(nextIdx > currentIdx ? 1 : -1);

    Animated.timing(listTransition, {
      toValue: 0,
      duration: 120,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) {
        switchingModeRef.current = false;
        return;
      }
      setMode(nextMode);
      listTransition.setValue(0);
      Animated.timing(listTransition, {
        toValue: 1,
        duration: 170,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        switchingModeRef.current = false;
      });
    });
  }, [listTransition, mode]);

  const listAnimatedStyle = useMemo(
    () => ({
      opacity: listTransition,
      transform: [
        {
          translateX: listTransition.interpolate({
            inputRange: [0, 1],
            outputRange: [switchDir * 10, 0],
          }),
        },
      ],
    }),
    [listTransition, switchDir]
  );

  return (
    <View style={styles.root}>
      <MinimalHeader
        title="FSHN"
        leftIcon="chevron-back"
        onLeftPress={onClose}
        leftA11yLabel="Back"
        onSearch={() => setSearchOpen((prev) => !prev)}
        rightSecondaryIcon="scan-outline"
        rightSecondaryLabel="Vision"
        rightSecondaryA11yLabel="Open vision finder"
        onSecondaryPress={() => setVisionVisible(true)}
        onRightPress={() => nav.navigate({ name: 'basket' })}
      />

      <View style={styles.titleWrap}>
        <Text numberOfLines={1} style={styles.title}>{title}</Text>
        <Text numberOfLines={1} style={styles.meta}>
          {activeItems.length} picks based on your likes
        </Text>
      </View>

      <View style={styles.tabs}>
        <Pressable
          onPress={() => switchModeSmooth('trending')}
          style={({ pressed }) => [
            styles.tab,
            mode === 'trending' && styles.tabActive,
            pressFeedback(pressed),
          ]}
        >
          <Text style={[styles.tabText, mode === 'trending' && styles.tabTextActive]}>Trending</Text>
        </Pressable>
        <Pressable
          onPress={() => switchModeSmooth('discover')}
          style={({ pressed }) => [
            styles.tab,
            mode === 'discover' && styles.tabActive,
            pressFeedback(pressed),
          ]}
        >
          <Text style={[styles.tabText, mode === 'discover' && styles.tabTextActive]}>Discover</Text>
        </Pressable>
      </View>

      <Animated.View style={[styles.listWrap, listAnimatedStyle]}>
        <FlatList
          data={activeItems}
          keyExtractor={(item, index) => `${item.id}-${index}`}
          numColumns={2}
          columnWrapperStyle={styles.columnRow}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + s(16) }]}
          removeClippedSubviews
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={8}
          renderItem={({ item }) => (
            <View style={[styles.cell, { width: cardWidth }]}>
              <ItemCard
                title={item.title}
                image={item.image}
                price={item.price}
                width={cardWidth}
                onPress={() => onPressItem(item)}
              />
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyTitle}>No recommendations yet</Text>
              <Text style={styles.emptyBody}>Like a few items to improve your {mode} feed.</Text>
            </View>
          }
        />
      </Animated.View>

      <HeaderSearchOverlay
        visible={searchOpen}
        value={searchQuery}
        onChangeText={setSearchQuery}
        scope={searchScope}
        onScopeChange={(value) => setSearchScope(value)}
        onClose={closeSearchOverlay}
        recent={recentSearches}
        listingResults={listingResults}
        userResults={[]}
        postResults={[]}
        onOpenResults={openResults}
      />

      <SearchResultsPage
        visible={resultsOpen}
        query={searchQuery}
        onChangeQuery={setSearchQuery}
        scope={searchScope}
        listingResults={listingResults}
        userResults={[]}
        postResults={[]}
        onBack={closeResults}
        onSelectItem={onPressItem}
        onSelectUser={() => {}}
        onSelectPost={() => {}}
      />

      <ProductModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        product={activeProduct}
        initialLiked={isLiked(activeProductId, activeProduct?.listingId)}
        onLikeChange={(liked, product) => {
          if (product?.id) setLiked(product.id, liked, product.listingId);
        }}
      />

      <VisionSheet
        visible={visionVisible}
        onClose={() => setVisionVisible(false)}
        pool={allItems}
        genderPref={visionGenderPref}
        onApplyItem={onSelectVisionAppItem}
      />
    </View>
  );
}

const makeStyles = (colors: any, isDark: boolean) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    titleWrap: {
      paddingHorizontal: s(3),
      marginTop: s(1.8),
      marginBottom: s(2),
    },
    title: {
      fontSize: 18,
      fontWeight: '800',
      letterSpacing: 0.2,
      color: colors.text,
    },
    meta: {
      marginTop: s(0.2),
      fontSize: 11.5,
      fontWeight: '600',
      color: colors.muted,
    },
    tabs: {
      flexDirection: 'row',
      gap: s(1),
      paddingHorizontal: s(3),
      marginBottom: s(2),
    },
    listWrap: {
      flex: 1,
    },
    tab: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 999,
      borderWidth: hairline,
      borderColor: colors.borderLight,
      backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.72)',
      paddingVertical: s(1.1),
    },
    tabActive: {
      backgroundColor: colors.text,
      borderColor: colors.text,
    },
    tabText: {
      fontSize: 12,
      fontWeight: '800',
      letterSpacing: 0.15,
      color: colors.text,
    },
    tabTextActive: {
      color: isDark ? '#101113' : '#fff',
    },
    listContent: {
      paddingTop: s(0.4),
      paddingHorizontal: s(3),
      gap: s(2),
    },
    columnRow: {
      justifyContent: 'space-between',
      marginBottom: s(1.8),
    },
    cell: {
      flex: 1,
    },
    emptyWrap: {
      marginTop: s(6),
      borderRadius: s(2.4),
      borderWidth: hairline,
      borderColor: colors.borderLight,
      backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.72)',
      paddingVertical: s(2.2),
      paddingHorizontal: s(2),
      alignItems: 'center',
    },
    emptyTitle: {
      fontSize: 13.4,
      fontWeight: '800',
      color: colors.text,
    },
    emptyBody: {
      marginTop: s(0.5),
      fontSize: 11.5,
      lineHeight: 17,
      textAlign: 'center',
      color: colors.muted,
    },
  });
