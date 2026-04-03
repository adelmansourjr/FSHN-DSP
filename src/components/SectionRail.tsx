import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { s, font, radius } from '../theme/tokens';
import { useTheme } from '../theme/ThemeContext';
import { pressFeedback } from '../theme/pressFeedback';
import ItemCard from './ItemCard';
import type { Item } from '../data/mock';
import ShimmerPlaceholder from './ui/ShimmerPlaceholder';

type Props = {
  title: string;
  items: Item[];
  loading?: boolean;
  skeletonCount?: number;
  onPressItem?: (item: Item) => void;
  onShowMore?: () => void;
  showMoreLabel?: string;
};

export default function SectionRail({
  title,
  items,
  loading = false,
  skeletonCount = 4,
  onPressItem,
  onShowMore,
  showMoreLabel = 'Show more',
}: Props) {
  const { colors, isDark } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: { marginTop: s(4) },
        head: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: s(2),
        },
        title: { ...font.h2, color: colors.text, marginBottom: s(2) },
        showMore: {
          paddingVertical: s(0.8),
          paddingHorizontal: s(1.6),
          borderRadius: 999,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.74)',
        },
        showMoreText: {
          fontSize: 11.5,
          fontWeight: '800',
          letterSpacing: 0.15,
          color: colors.text,
        },
        skeletonTileWrap: {
          width: 120,
        },
        skeletonTile: {
          height: 150,
          borderRadius: radius.tile,
          overflow: 'hidden',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.7)',
          marginBottom: s(1),
        },
        skeletonLine: {
          height: 10,
          borderRadius: 999,
          backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(11,11,14,0.08)',
          marginBottom: s(0.7),
        },
        skeletonLineShort: {
          width: '52%',
        },
      }),
    [colors, isDark]
  );
  const showSkeleton = loading || (!items.length && skeletonCount > 0);
  const skeletonItems = Array.from({ length: skeletonCount }, (_, i) => i);
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={[styles.title, { marginBottom: 0 }]}>{title}</Text>
        {!!onShowMore && (
          <Pressable
            style={({ pressed }) => [styles.showMore, pressFeedback(pressed)]}
            onPress={onShowMore}
            accessibilityRole="button"
            accessibilityLabel={`${title} show more`}
          >
            <Text style={styles.showMoreText}>{showMoreLabel}</Text>
          </Pressable>
        )}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', gap: s(2) }}>
          {showSkeleton
            ? skeletonItems.map((index) => (
                <View key={`skeleton-${title}-${index}`} style={styles.skeletonTileWrap}>
                  <View style={styles.skeletonTile}>
                    <ShimmerPlaceholder visible borderRadius={radius.tile} />
                  </View>
                  <View style={styles.skeletonLine} />
                  <View style={[styles.skeletonLine, styles.skeletonLineShort]} />
                </View>
              ))
            : items.map((it) => (
                <ItemCard
                  key={it.id}
                  title={it.title}
                  image={it.image}
                  price={it.price}
                  onPress={() => onPressItem?.(it)}
                />
              ))}
        </View>
      </ScrollView>
    </View>
  );
}
