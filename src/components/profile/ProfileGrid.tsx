import React, { useMemo } from 'react';
import { View, StyleSheet, Dimensions, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { hairline, radius, s } from '../../theme/tokens';
import { toGBPPriceLabel } from '../../lib/currency';
import RevealOnMount from '../ui/RevealOnMount';
import CachedImage from '../ui/CachedImage';
import ShimmerPlaceholder from '../ui/ShimmerPlaceholder';
import { useTheme } from '../../theme/ThemeContext';

const { width: W } = Dimensions.get('window');
const GAP = s(2);
const COLS = 2;
const TILE_W = Math.floor((W - s(3) * 2 - GAP) / COLS);
const TILE_H = Math.floor(TILE_W * 1.25);

export type GridItem = {
  id: string;
  uri: string;
  price?: number;
  sold?: boolean;
  meta?: string;
  listingId?: string;
  title?: string;
};

type Props = {
  items: GridItem[];
  loading?: boolean;
  skeletonCount?: number;
  animateItems?: boolean;
  onPressItem?: (it: GridItem) => void;
  onPressItemOption?: (it: GridItem) => void;
  showItemOption?: (it: GridItem) => boolean;
};

export default function ProfileGrid({
  items,
  loading = false,
  skeletonCount = 6,
  animateItems = true,
  onPressItem,
  onPressItemOption,
  showItemOption,
}: Props) {
  const { colors, isDark } = useTheme();
  const rows = useMemo(() => {
    const out: GridItem[][] = [];
    for (let i = 0; i < items.length; i += COLS) out.push(items.slice(i, i + COLS));
    return out;
  }, [items]);
  const skeletonRows = useMemo(() => {
    const out: number[][] = [];
    const count = Math.max(COLS, skeletonCount);
    const entries = Array.from({ length: count }, (_, index) => index);
    for (let i = 0; i < entries.length; i += COLS) out.push(entries.slice(i, i + COLS));
    return out;
  }, [skeletonCount]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: { flexDirection: 'row', gap: GAP },
        card: {
          width: TILE_W,
          height: TILE_H,
          overflow: 'hidden',
          borderRadius: radius.tile,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#FFF',
        },
        image: { width: '100%', height: '100%', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#F6F6F6' },
        priceChip: {
          position: 'absolute',
          left: s(2),
          bottom: s(2),
          backgroundColor: isDark ? 'rgba(11,11,14,0.78)' : 'rgba(255,255,255,0.92)',
          borderRadius: 10,
          paddingHorizontal: s(2),
          paddingVertical: s(1),
          borderWidth: hairline,
          borderColor: colors.borderLight,
        },
        priceTxt: { fontSize: 12, fontWeight: '900', color: colors.text },
        metaChip: {
          position: 'absolute',
          right: s(2),
          top: s(2),
          backgroundColor: isDark ? 'rgba(11,11,14,0.76)' : 'rgba(255,255,255,0.9)',
          borderRadius: 10,
          paddingHorizontal: s(2),
          paddingVertical: s(1),
          borderWidth: hairline,
          borderColor: colors.borderLight,
        },
        metaTxt: { fontSize: 11, fontWeight: '800', color: colors.text },
        soldBadge: {
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.28)',
          alignItems: 'center',
          justifyContent: 'center',
        },
        soldTxt: { color: '#fff', fontWeight: '900', letterSpacing: 2, fontSize: 16 },
        optionBtn: {
          position: 'absolute',
          right: s(2),
          bottom: s(2),
          width: 30,
          height: 30,
          borderRadius: 15,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(11,11,14,0.76)' : 'rgba(255,255,255,0.92)',
          alignItems: 'center',
          justifyContent: 'center',
        },
        skeletonCard: {
          position: 'relative',
        },
        skeletonChip: {
          position: 'absolute',
          borderRadius: 999,
          overflow: 'hidden',
        },
        skeletonMetaChip: {
          right: s(2),
          top: s(2),
          width: TILE_W * 0.26,
          height: 22,
        },
        skeletonPriceChip: {
          left: s(2),
          bottom: s(2),
          width: TILE_W * 0.32,
          height: 24,
        },
      }),
    [colors, isDark]
  );

  return (
    <View style={{ gap: GAP }}>
      {loading
        ? skeletonRows.map((row, i) => (
            <View key={`skeleton-row-${i}`} style={styles.row}>
              {row.map((index) => (
                <View key={`skeleton-${index}`} style={[styles.card, styles.skeletonCard]}>
                  <ShimmerPlaceholder borderRadius={radius.tile} />
                  <View style={[styles.skeletonChip, styles.skeletonMetaChip]}>
                    <ShimmerPlaceholder borderRadius={999} />
                  </View>
                  <View style={[styles.skeletonChip, styles.skeletonPriceChip]}>
                    <ShimmerPlaceholder borderRadius={999} />
                  </View>
                </View>
              ))}
              {row.length < COLS && <View style={[styles.card, { opacity: 0 }]} />}
            </View>
          ))
        : rows.map((row, i) => (
            animateItems ? (
            <RevealOnMount key={`r-${i}`} delay={i * 60} distance={11}>
              <View style={styles.row}>
                {row.map((it) => (
                  <Pressable
                    key={it.id}
                    onPress={() => onPressItem?.(it)}
                    style={({ pressed }) => [styles.card, pressed && { transform: [{ scale: 0.99 }] }]}
                  >
                    <CachedImage
                      source={{ uri: it.uri }}
                      style={styles.image}
                      contentFit="cover"
                      cachePolicy="memory-disk"
                      transition={120}
                      borderRadius={radius.tile}
                    />

                    {!!it.price && (
                      <View style={styles.priceChip}>
                        <Text style={styles.priceTxt}>{toGBPPriceLabel(it.price)}</Text>
                      </View>
                    )}

                    {!!it.meta && (
                      <View style={styles.metaChip}>
                        <Text style={styles.metaTxt}>{it.meta}</Text>
                      </View>
                    )}

                    {it.sold && (
                      <View style={styles.soldBadge}>
                        <Text style={styles.soldTxt}>SOLD</Text>
                      </View>
                    )}

                    {!!onPressItemOption && !!showItemOption?.(it) && (
                      <Pressable
                        hitSlop={8}
                        onPress={(event) => {
                          event.stopPropagation();
                          onPressItemOption(it);
                        }}
                        style={({ pressed }) => [styles.optionBtn, pressed && { transform: [{ scale: 0.96 }] }]}
                      >
                        <Ionicons name="create-outline" size={14} color={colors.text} />
                      </Pressable>
                    )}
                  </Pressable>
                ))}
                {row.length < COLS && <View style={[styles.card, { opacity: 0 }]} />}
              </View>
            </RevealOnMount>
            ) : (
              <View key={`r-${i}`} style={styles.row}>
                {row.map((it) => (
                  <Pressable
                    key={it.id}
                    onPress={() => onPressItem?.(it)}
                    style={({ pressed }) => [styles.card, pressed && { transform: [{ scale: 0.99 }] }]}
                  >
                    <CachedImage
                      source={{ uri: it.uri }}
                      style={styles.image}
                      contentFit="cover"
                      cachePolicy="memory-disk"
                      transition={120}
                      borderRadius={radius.tile}
                    />

                    {!!it.price && (
                      <View style={styles.priceChip}>
                        <Text style={styles.priceTxt}>{toGBPPriceLabel(it.price)}</Text>
                      </View>
                    )}

                    {!!it.meta && (
                      <View style={styles.metaChip}>
                        <Text style={styles.metaTxt}>{it.meta}</Text>
                      </View>
                    )}

                    {it.sold && (
                      <View style={styles.soldBadge}>
                        <Text style={styles.soldTxt}>SOLD</Text>
                      </View>
                    )}

                    {!!onPressItemOption && !!showItemOption?.(it) && (
                      <Pressable
                        hitSlop={8}
                        onPress={(event) => {
                          event.stopPropagation();
                          onPressItemOption(it);
                        }}
                        style={({ pressed }) => [styles.optionBtn, pressed && { transform: [{ scale: 0.96 }] }]}
                      >
                        <Ionicons name="create-outline" size={14} color={colors.text} />
                      </Pressable>
                    )}
                  </Pressable>
                ))}
                {row.length < COLS && <View style={[styles.card, { opacity: 0 }]} />}
              </View>
            )
          ))}
    </View>
  );
}
