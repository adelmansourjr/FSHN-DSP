import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  Pressable,
  Animated,
  TextInput,
  Keyboard,
  Easing,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { colors, font, hairline, s } from '../../theme/tokens';
import { mock, Item } from '../../data/mock';
import { ensureAssetUri } from '../../data/assets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toGBPPriceLabel } from '../../lib/currency';

export type GarmentMap = {
  top: string | null;
  bottom: string | null;
  mono: string | null;
  shoes: string | null;
};

export type Props = {
  visible: boolean;
  onClose: () => void;
  garments: GarmentMap;
  onChange: (key: keyof GarmentMap, uri: string | null) => void;
  gender: 'any' | 'men' | 'women';
  onGenderChange: (value: 'any' | 'men' | 'women') => void;
  onPromptSearch: (prompt: string) => Promise<boolean> | boolean;
  recommendBusy: boolean;
  items?: Item[];
  closetItems?: Item[];
  recommendations?: Partial<Record<keyof GarmentMap, Item[]>>;
  authoritativeRecommendations?: boolean;
};

const categories: Array<{
  key: keyof GarmentMap;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}> = [
  { key: 'top', label: 'Top', icon: 'shirt-outline' },
  { key: 'bottom', label: 'Bottom', icon: 'trail-sign-outline' },
  { key: 'mono', label: 'Mono', icon: 'woman-outline' },
  { key: 'shoes', label: 'Footwear', icon: 'footsteps-outline' },
];

const genderOptions: Array<{ label: string; value: 'any' | 'men' | 'women' }> = [
  { label: 'Any', value: 'any' },
  { label: 'Men', value: 'men' },
  { label: 'Women', value: 'women' },
];

export default function ClothingSelectorModal({
  visible,
  onClose,
  garments,
  onChange,
  gender,
  onGenderChange,
  onPromptSearch,
  recommendBusy,
  items,
  closetItems,
  recommendations,
  authoritativeRecommendations = false,
}: Props) {
  const insets = useSafeAreaInsets();
  const monoSelected = !!garments.mono;
  const splitSelected = !!garments.top || !!garments.bottom;
  const [prompt, setPrompt] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<keyof GarmentMap | null>(null);
  const [sourceFilter, setSourceFilter] = useState<'all' | 'closet'>('all');
  const [colorFilter, setColorFilter] = useState<string>('All');
  const [typeFilter, setTypeFilter] = useState<string>('All');
  const promptAnim = useRef(new Animated.Value(0)).current;
  const searchAnim = useRef(new Animated.Value(0)).current;
  const [promptActive, setPromptActive] = useState(false);

  useEffect(() => {
    if (!visible) {
      setPrompt('');
      setSearchQuery('');
      setActiveCategory(null);
      setSourceFilter('all');
      setColorFilter('All');
      setTypeFilter('All');
      promptAnim.setValue(0);
      searchAnim.setValue(0);
      setPromptActive(false);
      Keyboard.dismiss();
    }
  }, [visible, promptAnim, searchAnim]);

  const animateSearch = useCallback(
    (toValue: number) => {
      Animated.timing(searchAnim, {
        toValue,
        duration: 220,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }).start();
    },
    [searchAnim]
  );

  const animatePrompt = useCallback(
    (toValue: number) => {
      Animated.timing(promptAnim, {
        toValue,
        duration: toValue === 1 ? 320 : 360,
        easing:
          toValue === 1
            ? Easing.bezier(0.16, 1, 0.3, 1)
            : Easing.bezier(0.16, 0, 0.3, 1),
        useNativeDriver: false,
      }).start(() => {
        if (toValue === 0) {
          setPromptActive(false);
        }
      });
    },
    [promptAnim]
  );

  const handlePromptFocus = useCallback(() => {
    setPromptActive(true);
    animatePrompt(1);
  }, [animatePrompt]);

  const handlePromptBlur = useCallback(() => {
    animatePrompt(0);
  }, [animatePrompt]);

  const promptScale = useMemo(
    () => promptAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] }),
    [promptAnim]
  );
  const promptPadding = useMemo(
    () => promptAnim.interpolate({ inputRange: [0, 1], outputRange: [s(2), s(4.4)] }),
    [promptAnim]
  );
  const promptTranslateY = useMemo(
    () => promptAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -s(1.2)] }),
    [promptAnim]
  );
  const promptBg = useMemo(
    () =>
      promptAnim.interpolate({
        inputRange: [0, 1],
        outputRange: ['rgba(255,255,255,0.08)', 'rgba(255,255,255,0.18)'],
      }),
    [promptAnim]
  );
  const overlayOpacity = useMemo(
    () => promptAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.45] }),
    [promptAnim]
  );

  const handlePromptSubmit = useCallback(async () => {
    if (recommendBusy) return;
    const ok = await onPromptSearch(prompt);
    if (ok) {
      setPrompt('');
      Keyboard.dismiss();
      animatePrompt(0);
    }
  }, [prompt, onPromptSearch, recommendBusy, animatePrompt]);

  const openCategorySearch = useCallback(
    (key: keyof GarmentMap) => {
      searchAnim.setValue(0);
      setActiveCategory(key);
      setSearchQuery('');
      setSourceFilter('all');
      setColorFilter('All');
      setTypeFilter('All');
      Keyboard.dismiss();
      animateSearch(1);
    },
    [animateSearch, searchAnim]
  );

  const closeCategorySearch = useCallback(() => {
    animateSearch(0);
    setTimeout(() => {
      setActiveCategory(null);
      setSearchQuery('');
      setSourceFilter('all');
      setColorFilter('All');
      setTypeFilter('All');
      Keyboard.dismiss();
    }, 220);
  }, [animateSearch]);

  const disabledMap = useMemo(() => {
    const map: Record<keyof GarmentMap, boolean> = {
      top: monoSelected,
      bottom: monoSelected,
      mono: splitSelected,
      shoes: false,
    };
    return map;
  }, [monoSelected, splitSelected]);

  const rationale = useMemo(() => {
    if (monoSelected) return 'One-piece looks can only be paired with shoes.';
    if (splitSelected) return 'Tops & bottoms can be combined, but mono outfits are disabled.';
    return 'Pick any combination to build your look.';
  }, [monoSelected, splitSelected]);

  const roleForCategory = useCallback((key: keyof GarmentMap) => {
    if (key === 'mono') return 'dress';
    if (key === 'shoes') return 'shoes';
    if (key === 'top') return 'top';
    if (key === 'bottom') return 'bottom';
    return undefined;
  }, []);

  const allItems = items && items.length ? items : (mock.allItems ?? []);

  const inferItemRole = useCallback((item: Item): Item['role'] | null => {
    const explicitRole = item.role;
    if (explicitRole === 'top' || explicitRole === 'bottom' || explicitRole === 'dress' || explicitRole === 'shoes') {
      return explicitRole;
    }

    const corpus = [
      item.title || '',
      String((item as any)?.category || ''),
      String((item as any)?.sub || ''),
      String((item as any)?.description || ''),
      Array.isArray((item as any)?.tags) ? (item as any).tags.join(' ') : '',
    ]
      .join(' ')
      .toLowerCase();

    if (
      /\bdress\b|\bgown\b|\bjumpsuit\b|\bromper\b|\bslip dress\b|\bmaxi dress\b|\bmini dress\b|\bone piece\b|\bone-piece\b/.test(
        corpus
      )
    ) {
      return 'dress';
    }
    if (
      /\bshoe\b|\bshoes\b|\bsneaker\b|\bsneakers\b|\btrainer\b|\btrainers\b|\bboot\b|\bboots\b|\bloafer\b|\bheel\b|\bheels\b|\bsandal\b|\bfootwear\b/.test(
        corpus
      )
    ) {
      return 'shoes';
    }
    if (
      /\bjean\b|\bjeans\b|\bdenim\b|\bpants\b|\btrouser\b|\btrousers\b|\bshorts\b|\bcargo\b|\bcargos\b|\bjogger\b|\bjoggers\b|\bleggings\b|\bskirt\b|\bskort\b|\bculottes\b/.test(
        corpus
      )
    ) {
      return 'bottom';
    }
    if (
      /\btop\b|\bshirt\b|\bt shirt\b|\bt-shirt\b|\btshirt\b|\btee\b|\bhoodie\b|\bcrewneck\b|\bsweater\b|\bknit\b|\bjacket\b|\bcoat\b|\bblazer\b|\bjersey\b|\bpolo\b/.test(
        corpus
      )
    ) {
      return 'top';
    }

    return null;
  }, []);

  const matchesCategoryRole = useCallback(
    (item: Item, category: keyof GarmentMap) => {
      const expectedRole = roleForCategory(category);
      if (!expectedRole) return true;
      return inferItemRole(item) === expectedRole;
    },
    [inferItemRole, roleForCategory]
  );

  const inferType = useCallback((title: string, category: keyof GarmentMap) => {
    const t = title.toLowerCase();
    if (category === 'top') {
      if (t.includes('hoodie') || t.includes('sweat')) return 'Hoodie';
      if (t.includes('tee') || t.includes('t-shirt') || t.includes('shirt')) return 'Shirt';
      if (t.includes('knit') || t.includes('sweater')) return 'Knit';
      if (t.includes('jacket') || t.includes('coat')) return 'Outer';
      return 'Top';
    }
    if (category === 'bottom') {
      if (t.includes('jean') || t.includes('denim')) return 'Denim';
      if (t.includes('trouser') || t.includes('pant')) return 'Pants';
      if (t.includes('short')) return 'Shorts';
      if (t.includes('skirt')) return 'Skirt';
      return 'Bottom';
    }
    if (category === 'mono') {
      if (t.includes('dress')) return 'Dress';
      if (t.includes('jumpsuit')) return 'Jumpsuit';
      if (t.includes('romper')) return 'Romper';
      return 'Mono';
    }
    if (category === 'shoes') {
      if (t.includes('sneaker')) return 'Sneakers';
      if (t.includes('boot')) return 'Boots';
      if (t.includes('heel')) return 'Heels';
      if (t.includes('sandal')) return 'Sandals';
      return 'Footwear';
    }
    return 'All';
  }, []);

  const normalizeColor = useCallback((value?: string | null) => {
    if (!value) return null;
    return String(value).trim().toLowerCase();
  }, []);

  const normalizeGender = useCallback((value?: string | null): 'men' | 'women' | 'any' | null => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    if (/\bunisex\b|\ball\b|\bany\b|\bgender[\s-]?neutral\b/.test(raw)) return 'any';
    if (/\bmen'?s?\b|\bmale\b|\bboy\b|\bboys\b/.test(raw)) return 'men';
    if (/\bwomen'?s?\b|\bfemale\b|\bgirl\b|\bgirls\b|\blad(?:y|ies)\b/.test(raw)) return 'women';
    return null;
  }, []);

  const inferItemGender = useCallback(
    (item: Item): 'men' | 'women' | 'any' | null => {
      const fromMeta = normalizeGender((item as any)?.meta?.gender);
      if (fromMeta) return fromMeta;
      const direct = normalizeGender((item as any)?.gender);
      if (direct) return direct;
      const text = [
        item.title || '',
        String((item as any)?.brand || ''),
        String((item as any)?.category || ''),
        Array.isArray((item as any)?.tags) ? (item as any).tags.join(' ') : '',
      ]
        .join(' ')
        .trim();
      const inferred = normalizeGender(text);
      if (inferred === 'any') {
        const semantic = text.toLowerCase();
        if (/\blegging|leggings|tights|stockings|hosiery|jeggings|pump|pumps|heel|heels|stiletto|stilettos|slingback|slingbacks|mary jane|mary janes|bralette|corset|camisole|blouse\b/.test(semantic)) {
          return 'women';
        }
      }
      return inferred;
    },
    [normalizeGender]
  );

  const matchesGender = useCallback(
    (item: Item) => {
      if (gender === 'any') return true;
      const itemId = String(item?.id || '').trim();
      const isClosetSource = itemId.startsWith('closet:') || (item as any)?.source === 'closet';
      const inferred = inferItemGender(item);
      if (!inferred) return isClosetSource;
      if (inferred === 'any') return true;
      return inferred === gender;
    },
    [gender, inferItemGender]
  );

  const categoryItems = useMemo(() => {
    if (!activeCategory) return [] as Item[];
    const genderFiltered = allItems.filter((item) => matchesGender(item));
    return genderFiltered.filter((item) => matchesCategoryRole(item, activeCategory));
  }, [activeCategory, allItems, matchesCategoryRole, matchesGender]);

  const recommendedItems = useMemo(() => {
    if (!activeCategory) return [] as Item[];
    const suggested = recommendations?.[activeCategory];
    if (suggested && suggested.length) {
      const filtered = suggested.filter((item) => {
        if (!matchesCategoryRole(item, activeCategory)) return false;
        return matchesGender(item);
      });
      const unique = new Map(filtered.map((item) => [item.id, item]));
      const list = Array.from(unique.values());
      return list.length ? list.slice(0, 10) : [];
    }
    const pool = [...(mock.recentlyTried ?? []), ...(mock.trending ?? []), ...(mock.discover ?? [])];
    const filtered = pool
      .filter((item) => matchesGender(item))
      .filter((item) => matchesCategoryRole(item, activeCategory));
    const unique = new Map(filtered.map((item) => [item.id, item]));
    const list = Array.from(unique.values());
    return list.length ? list.slice(0, 10) : categoryItems.slice(0, 10);
  }, [activeCategory, categoryItems, matchesCategoryRole, matchesGender, recommendations]);

  const searchedItems = useMemo(() => {
    if (!activeCategory) return [] as Item[];
    const q = searchQuery.trim().toLowerCase();
    let list = categoryItems;
    if (typeFilter !== 'All') {
      list = list.filter((item) => inferType(item.title, activeCategory) === typeFilter);
    }
    if (colorFilter !== 'All') {
      list = list.filter((item) => normalizeColor(item.colorName) === normalizeColor(colorFilter));
    }
    if (!q) return list;
    return list.filter((item) => item.title.toLowerCase().includes(q));
  }, [activeCategory, categoryItems, colorFilter, inferType, normalizeColor, searchQuery, typeFilter]);

  const isListingItem = useCallback((item: Item) => {
    const id = String(item.id || '');
    return id.startsWith('listing:') || (item as any)?.source === 'listing';
  }, []);

  const isClosetItem = useCallback((item: Item) => {
    const id = String(item.id || '');
    return id.startsWith('closet:') || (item as any)?.source === 'closet';
  }, []);

  const closetItemsBase = useMemo(() => {
    if (closetItems?.length) return closetItems;
    return allItems.filter((item) => isClosetItem(item));
  }, [allItems, closetItems, isClosetItem]);

  const closetItemsForCategory = useMemo(() => {
    if (!activeCategory) return [] as Item[];
    let filtered = closetItemsBase.filter((item) => matchesCategoryRole(item, activeCategory));
    filtered = filtered.filter((item) => matchesGender(item));
    if (typeFilter !== 'All') {
      filtered = filtered.filter((item) => inferType(item.title, activeCategory) === typeFilter);
    }
    if (colorFilter !== 'All') {
      filtered = filtered.filter((item) => normalizeColor(item.colorName) === normalizeColor(colorFilter));
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter((item) => item.title.toLowerCase().includes(q));
    }
    return filtered;
  }, [
    activeCategory,
    closetItemsBase,
    colorFilter,
    inferType,
    matchesCategoryRole,
    normalizeColor,
    searchQuery,
    typeFilter,
    matchesGender,
  ]);

  const listingItemsForCategory = useMemo(() => {
    if (!activeCategory) return [] as Item[];
    let base = (items && items.length ? items : (mock.allItems ?? [])) as Item[];
    base = base.filter((item) => isListingItem(item));
    base = base.filter((item) => matchesGender(item));
    base = base.filter((item) => matchesCategoryRole(item, activeCategory));
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      base = base.filter((item) => item.title.toLowerCase().includes(q));
    }
    return base;
  }, [activeCategory, isListingItem, items, matchesCategoryRole, matchesGender, searchQuery]);

  const catalogItemsForCategory = useMemo(() => {
    if (!activeCategory) return [] as Item[];
    const base = searchedItems;
    return base.filter((item) => !isListingItem(item) && !isClosetItem(item));
  }, [activeCategory, isClosetItem, isListingItem, searchedItems]);

  const typeOptions = useMemo(() => {
    if (!activeCategory) return ['All'];
    const source = sourceFilter === 'closet' ? closetItemsBase : categoryItems;
    const set = new Set<string>();
    source.forEach((item) => set.add(inferType(item.title, activeCategory)));
    return ['All', ...Array.from(set)];
  }, [activeCategory, categoryItems, closetItemsBase, inferType, sourceFilter]);

  const colorOptions = useMemo(() => {
    if (!activeCategory) return ['All'];
    const source = sourceFilter === 'closet' ? closetItemsBase : categoryItems;
    const set = new Set<string>();
    source.forEach((item) => {
      const color = normalizeColor(item.colorName);
      if (color) set.add(color);
    });
    const list = Array.from(set).map((c) => c.replace(/\b\w/g, (m) => m.toUpperCase()));
    return ['All', ...list];
  }, [activeCategory, categoryItems, closetItemsBase, normalizeColor, sourceFilter]);

  const handleSelectItem = useCallback(
    async (item: Item) => {
      if (!activeCategory) return;
      try {
        const resolved = item.imagePath ? await ensureAssetUri(item.imagePath) : null;
        onChange(activeCategory, resolved || item.image);
      } catch (err) {
        console.warn('[ClothingSelector] Failed to resolve asset uri', err);
        onChange(activeCategory, item.image);
      } finally {
        closeCategorySearch();
      }
    },
    [activeCategory, closeCategorySearch, onChange]
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <BlurView intensity={80} tint="light" style={StyleSheet.absoluteFillObject} />
          <Animated.View
            pointerEvents={promptActive ? 'auto' : 'none'}
            style={[styles.promptOverlay, { opacity: overlayOpacity }]}
          >
            <Pressable style={StyleSheet.absoluteFill} onPress={Keyboard.dismiss} />
          </Animated.View>
          <View style={styles.sheetHeader}>
            <Text style={[font.h2, styles.sheetTitle]}>Select Clothing Items</Text>
            <Pressable style={styles.closeBtn} onPress={onClose}>
              <Ionicons name="close" size={20} color={colors.text} />
            </Pressable>
          </View>
          <View style={styles.promptContainer}>
            <Animated.View
              style={[
                styles.promptBar,
                {
                  transform: [{ translateY: promptTranslateY }, { scale: promptScale }],
                  paddingVertical: promptPadding,
                  backgroundColor: promptBg,
                },
              ]}
            >
              <BlurView intensity={65} tint="light" style={StyleSheet.absoluteFillObject} />
              <Ionicons name="search-outline" size={20} color={colors.text} style={styles.promptIcon} />
              <TextInput
                value={prompt}
                onChangeText={setPrompt}
                placeholder="What you would like to wear? "
                placeholderTextColor="rgba(11,11,14,0.45)"
                style={styles.promptInput}
                returnKeyType="search"
                keyboardAppearance="dark"
                onFocus={handlePromptFocus}
                onBlur={handlePromptBlur}
                onSubmitEditing={handlePromptSubmit}
                autoCorrect
                autoCapitalize="sentences"
                editable={!recommendBusy}
              />
              <Pressable
                onPress={handlePromptSubmit}
                disabled={recommendBusy}
                style={({ pressed }) => [
                  styles.promptCta,
                  (recommendBusy || pressed) && { opacity: recommendBusy ? 0.45 : 0.8 },
                ]}
              >
                {recommendBusy ? (
                  <ActivityIndicator color={colors.text} size="small" />
                ) : (
                  <Ionicons name="sparkles" size={18} color={colors.text} />
                )}
              </Pressable>
            </Animated.View>
          </View>
          <View style={styles.genderRow}>
            {genderOptions.map((opt) => {
              const active = gender === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => onGenderChange(opt.value)}
                  style={[
                    styles.genderChip,
                    active && { backgroundColor: colors.text },
                  ]}
                >
                  <Text
                    style={[
                      styles.genderChipLabel,
                      active && { color: '#fff' },
                    ]}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.rationale}>{rationale}</Text>
          <View style={styles.grid}>
            {categories.map(({ key, label, icon }) => {
              const uri = garments[key];
              const disabled = disabledMap[key];
              return (
                <Pressable
                  key={String(key)}
                  disabled={disabled}
                  onPress={() => openCategorySearch(key)}
                  style={({ pressed }) => [
                    styles.tile,
                    disabled && { opacity: 0.4 },
                    pressed && !disabled && { transform: [{ scale: 0.97 }] },
                  ]}
                >
                  <Text style={styles.tileLabel}>{label}</Text>
                  <View style={styles.tileBody}>
                    {uri ? (
                      <ExpoImage source={{ uri }} style={styles.tileImage} contentFit="cover" cachePolicy="memory-disk" transition={120} />
                    ) : (
                      <View style={styles.plusWrap}>
                        <Ionicons name={icon} size={20} color={colors.text} />
                        <Ionicons name="add" size={18} color={colors.text} />
                      </View>
                    )}
                  </View>
                  {uri ? (
                    <Pressable style={styles.clearBtn} onPress={() => onChange(key, null)}>
                      <Ionicons name="trash-outline" size={16} color={colors.text} />
                    </Pressable>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>

        {activeCategory && (
          <Animated.View
            style={[
              styles.searchOverlay,
              {
                opacity: searchAnim,
                transform: [
                  {
                    translateY: searchAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [24, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <BlurView intensity={70} tint="light" style={StyleSheet.absoluteFillObject} />
            <View style={[styles.searchSheet, { paddingTop: insets.top + s(2) }]}
            >
              <View style={styles.searchHeader}>
                <Pressable onPress={closeCategorySearch} style={styles.searchBackBtn}>
                  <Ionicons name="chevron-back" size={18} color={colors.text} />
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text style={styles.searchTitle}>
                    {categories.find((c) => c.key === activeCategory)?.label} picks
                  </Text>
                  <Text style={styles.searchSubtitle}>Recommended for you</Text>
                </View>
              </View>

              <View style={styles.searchBar}>
                <Ionicons name="search-outline" size={18} color={colors.textDim} />
                <TextInput
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder={`Search ${categories.find((c) => c.key === activeCategory)?.label?.toLowerCase()}`}
                  placeholderTextColor="rgba(11,11,14,0.45)"
                  style={styles.searchInput}
                  returnKeyType="search"
                />
                {!!searchQuery && (
                  <Pressable onPress={() => setSearchQuery('')} style={styles.searchClear}>
                    <Ionicons name="close" size={14} color={colors.text} />
                  </Pressable>
                )}
              </View>

              <View style={styles.scopeRow}>
                <Pressable
                  onPress={() => setSourceFilter('all')}
                  style={[styles.scopeChip, sourceFilter === 'all' && styles.scopeChipActive]}
                >
                  <Text style={[styles.scopeChipText, sourceFilter === 'all' && styles.scopeChipTextActive]}>
                    All items
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setSourceFilter('closet')}
                  style={[styles.scopeChip, sourceFilter === 'closet' && styles.scopeChipActive]}
                >
                  <Text style={[styles.scopeChipText, sourceFilter === 'closet' && styles.scopeChipTextActive]}>
                    Closet items
                  </Text>
                </Pressable>
              </View>

              <View style={styles.filterGroup}>
                <Text style={styles.filterLabel}>Clothing type</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
                  {typeOptions.map((opt) => {
                    const active = opt === typeFilter;
                    return (
                      <Pressable
                        key={opt}
                        onPress={() => setTypeFilter(opt)}
                        style={[styles.filterChip, active && styles.filterChipActive]}
                      >
                        <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{opt}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>

              <View style={styles.filterGroup}>
                <Text style={styles.filterLabel}>Color</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
                  {colorOptions.map((opt) => {
                    const active = opt === colorFilter;
                    return (
                      <Pressable
                        key={opt}
                        onPress={() => setColorFilter(opt)}
                        style={[styles.filterChip, active && styles.filterChipActive]}
                      >
                        <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{opt}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>

              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.searchContent, { paddingBottom: insets.bottom + s(6) }]}>
                {sourceFilter === 'closet' ? (
                  <View style={styles.sectionBlock}>
                    <Text style={styles.sectionTitle}>Your closet</Text>
                    {closetItemsForCategory.length ? (
                      <View style={styles.itemGrid}>
                        {closetItemsForCategory.map((item) => (
                          <Pressable
                            key={item.id}
                            onPress={() => handleSelectItem(item)}
                            style={({ pressed }) => [styles.itemCard, pressed && { transform: [{ scale: 0.98 }] }]}
                          >
                            <ExpoImage source={{ uri: item.image }} style={styles.itemImage} contentFit="cover" cachePolicy="memory-disk" transition={120} />
                            <Text numberOfLines={1} style={styles.itemTitle}>{item.title}</Text>
                            {!!item.price && <Text style={styles.itemPrice}>{toGBPPriceLabel(item.price)}</Text>}
                          </Pressable>
                        ))}
                      </View>
                    ) : (
                      <View style={styles.emptyCard}>
                        <Text style={styles.emptyCardTitle}>No closet items in this category yet.</Text>
                        <Text style={styles.emptyCardText}>Add items in Profile → Closet and they will appear here.</Text>
                      </View>
                    )}
                  </View>
                ) : (
                  <>
                    {!searchQuery && (
                      <View style={styles.sectionBlock}>
                        <Text style={styles.sectionTitle}>Recommended</Text>
                        <View style={styles.itemGrid}>
                          {recommendedItems.map((item) => (
                            <Pressable
                              key={item.id}
                              onPress={() => handleSelectItem(item)}
                              style={({ pressed }) => [styles.itemCard, pressed && { transform: [{ scale: 0.98 }] }]}
                            >
                              <ExpoImage source={{ uri: item.image }} style={styles.itemImage} contentFit="cover" cachePolicy="memory-disk" transition={120} />
                              <Text numberOfLines={1} style={styles.itemTitle}>{item.title}</Text>
                              {!!item.price && <Text style={styles.itemPrice}>{toGBPPriceLabel(item.price)}</Text>}
                            </Pressable>
                          ))}
                        </View>
                      </View>
                    )}

                    {listingItemsForCategory.length > 0 && (
                      <View style={styles.sectionBlock}>
                        <Text style={styles.sectionTitle}>Listings</Text>
                        <View style={styles.itemGrid}>
                          {listingItemsForCategory.map((item) => (
                            <Pressable
                              key={item.id}
                              onPress={() => handleSelectItem(item)}
                              style={({ pressed }) => [styles.itemCard, pressed && { transform: [{ scale: 0.98 }] }]}
                            >
                              <ExpoImage source={{ uri: item.image }} style={styles.itemImage} contentFit="cover" cachePolicy="memory-disk" transition={120} />
                              <Text numberOfLines={1} style={styles.itemTitle}>{item.title}</Text>
                              {!!item.price && <Text style={styles.itemPrice}>{toGBPPriceLabel(item.price)}</Text>}
                            </Pressable>
                          ))}
                        </View>
                      </View>
                    )}

                    <View style={styles.sectionBlock}>
                      <Text style={styles.sectionTitle}>{searchQuery ? 'Results' : 'All items'}</Text>
                      <View style={styles.itemGrid}>
                        {catalogItemsForCategory.map((item) => (
                          <Pressable
                            key={item.id}
                            onPress={() => handleSelectItem(item)}
                            style={({ pressed }) => [styles.itemCard, pressed && { transform: [{ scale: 0.98 }] }]}
                          >
                            <ExpoImage source={{ uri: item.image }} style={styles.itemImage} contentFit="cover" cachePolicy="memory-disk" transition={120} />
                            <Text numberOfLines={1} style={styles.itemTitle}>{item.title}</Text>
                            {!!item.price && <Text style={styles.itemPrice}>{toGBPPriceLabel(item.price)}</Text>}
                          </Pressable>
                        ))}
                      </View>
                    </View>
                  </>
                )}
              </ScrollView>
            </View>
          </Animated.View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: 'transparent',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: s(5),
    paddingTop: s(5),
    maxHeight: '85%',
    position: 'relative',
    borderWidth: hairline,
    borderColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  promptOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.25)',
    zIndex: 5,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: s(2) },
  sheetTitle: { flex: 1, color: colors.text },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  rationale: { marginBottom: s(3), color: 'rgba(0,0,0,0.6)', textAlign: 'center' },
  genderRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: s(2),
    marginBottom: s(2),
  },
  genderChip: {
    paddingHorizontal: s(3),
    paddingVertical: s(1.2),
    borderRadius: s(999),
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  genderChipLabel: {
    fontWeight: '700',
    color: colors.text,
  },
  promptContainer: {
    marginBottom: s(3),
    paddingHorizontal: s(1),
  },
  promptBar: {
    borderRadius: s(999),
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: s(4),
    borderWidth: hairline,
    borderColor: 'rgba(255,255,255,0.55)',
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  promptIcon: {
    marginRight: s(3),
  },
  promptInput: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
    minHeight: 20,
  },
  promptCta: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: s(3),
    justifyContent: 'space-between',
    paddingBottom: s(4),
  },
  tile: {
    width: '48%',
    borderRadius: s(5),
    borderWidth: hairline,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    padding: s(3),
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  tileLabel: { fontWeight: '800', color: colors.text, marginBottom: s(2) },
  tileBody: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: s(3),
    borderWidth: hairline,
    borderColor: 'rgba(255,255,255,0.06)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tileImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  plusWrap: { alignItems: 'center', justifyContent: 'center', gap: 4 },
  clearBtn: {
    position: 'absolute',
    top: s(2),
    right: s(2),
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: hairline,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  searchOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
  },
  searchSheet: {
    flex: 1,
    paddingTop: s(3),
    paddingHorizontal: s(4),
  },
  searchHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: s(2),
    marginBottom: s(2),
  },
  searchBackBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderWidth: hairline,
    borderColor: colors.borderLight,
  },
  searchTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.text,
  },
  searchSubtitle: {
    fontSize: 12,
    color: colors.textDim,
    marginTop: 2,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: s(2),
    paddingHorizontal: s(3),
    paddingVertical: s(2),
    borderRadius: 999,
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: 'rgba(255,255,255,0.75)',
    marginBottom: s(2),
  },
  scopeRow: {
    flexDirection: 'row',
    gap: s(1.5),
    marginBottom: s(2),
  },
  scopeChip: {
    paddingHorizontal: s(2.5),
    paddingVertical: s(1.2),
    borderRadius: 999,
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: 'rgba(255,255,255,0.65)',
  },
  scopeChipActive: {
    backgroundColor: colors.text,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  scopeChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text,
  },
  scopeChipTextActive: {
    color: '#fff',
  },
  filterGroup: {
    marginBottom: s(2),
  },
  filterLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textDim,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginBottom: s(1.2),
  },
  filterRow: {
    flexDirection: 'row',
    gap: s(1.5),
    paddingBottom: s(0.5),
  },
  filterChip: {
    paddingHorizontal: s(2.5),
    paddingVertical: s(1.2),
    borderRadius: 999,
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: 'rgba(255,255,255,0.65)',
  },
  filterChipActive: {
    backgroundColor: colors.text,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text,
  },
  filterChipTextActive: {
    color: '#fff',
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: colors.text,
  },
  searchClear: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: hairline,
    borderColor: colors.borderLight,
  },
  searchContent: {
    paddingBottom: s(6),
  },
  sectionBlock: {
    marginBottom: s(3),
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.text,
    marginBottom: s(2),
  },
  itemGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: s(2.5),
  },
  itemCard: {
    width: '47%',
    borderRadius: s(3),
    borderWidth: hairline,
    borderColor: 'rgba(0,0,0,0.08)',
    backgroundColor: 'rgba(255,255,255,0.75)',
    padding: s(2),
  },
  itemImage: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: s(2.5),
    marginBottom: s(1.5),
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  itemTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text,
  },
  itemPrice: {
    fontSize: 12,
    color: colors.textDim,
    marginTop: 2,
  },
  emptyCard: {
    borderRadius: s(3),
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: 'rgba(255,255,255,0.5)',
    padding: s(3),
  },
  emptyCardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
    marginBottom: s(0.5),
  },
  emptyCardText: {
    fontSize: 12,
    color: colors.textDim,
  },
});
