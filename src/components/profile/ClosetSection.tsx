import React, { useMemo } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { font, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import type { LocalClosetItem } from '../../lib/localCloset';
import CachedImage from '../ui/CachedImage';
import ShimmerPlaceholder from '../ui/ShimmerPlaceholder';

type Props = {
  items: LocalClosetItem[];
  loading?: boolean;
  skeletonCount?: number;
  adding: boolean;
  onAddPress: () => void;
  onEditItem: (item: LocalClosetItem) => void;
  onOpenItemMenu: (item: LocalClosetItem) => void;
};

export default function ClosetSection({
  items,
  loading = false,
  skeletonCount = 5,
  adding,
  onAddPress,
  onEditItem,
  onOpenItemMenu,
}: Props) {
  const { colors, isDark } = useTheme();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        title: { ...font.h2, color: colors.text },
        emptyHint: {
          ...font.meta,
          color: colors.textDim,
          marginTop: s(0.5),
          marginBottom: s(1.5),
        },
        grid: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          rowGap: s(2),
        },
        addBtn: {
          width: '48%',
          aspectRatio: 0.8,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
          alignSelf: 'flex-start',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        },
        addBtnTxt: { ...font.meta, color: colors.text, fontWeight: '800', textAlign: 'center' },
        addBtnSkeletonIcon: {
          width: 26,
          height: 26,
          borderRadius: 13,
          overflow: 'hidden',
        },
        addBtnSkeletonText: {
          width: '58%',
          height: 14,
          borderRadius: 999,
          overflow: 'hidden',
        },
        itemCard: {
          width: '48%',
          aspectRatio: 0.8,
          borderRadius: 16,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
        },
        itemImage: {
          width: '100%',
          height: '100%',
          backgroundColor: 'rgba(0,0,0,0.04)',
        },
        skeletonCard: {
          position: 'relative',
        },
        metaChip: {
          position: 'absolute',
          left: s(1.4),
          top: s(1.4),
          borderRadius: 10,
          paddingHorizontal: s(1.2),
          paddingVertical: s(0.6),
          backgroundColor: isDark ? 'rgba(11,11,14,0.72)' : 'rgba(255,255,255,0.9)',
          borderWidth: 1,
          borderColor: colors.borderLight,
        },
        skeletonMetaChip: {
          width: '34%',
          height: 22,
          overflow: 'hidden',
        },
        metaTxt: {
          ...font.meta,
          color: colors.text,
          fontSize: 11,
          fontWeight: '800',
        },
        embeddingChip: {
          position: 'absolute',
          left: s(1.4),
          top: s(5.1),
          borderRadius: 10,
          paddingHorizontal: s(1.2),
          paddingVertical: s(0.55),
          borderWidth: 1,
        },
        skeletonEmbeddingChip: {
          width: '42%',
          height: 20,
          overflow: 'hidden',
        },
        embeddingChipReady: {
          backgroundColor: 'rgba(231,248,236,0.96)',
          borderColor: 'rgba(69,140,89,0.35)',
        },
        embeddingChipMissing: {
          backgroundColor: 'rgba(255,245,224,0.96)',
          borderColor: 'rgba(184,133,35,0.28)',
        },
        embeddingTxt: {
          ...font.meta,
          color: colors.text,
          fontSize: 10,
          fontWeight: '800',
        },
        tagsChip: {
          position: 'absolute',
          left: s(1.4),
          right: s(1.4),
          bottom: s(1.4),
          borderRadius: 10,
          paddingHorizontal: s(1.2),
          paddingVertical: s(0.6),
          backgroundColor: isDark ? 'rgba(11,11,14,0.78)' : 'rgba(255,255,255,0.92)',
          borderWidth: 1,
          borderColor: colors.borderLight,
        },
        skeletonTagsChip: {
          height: 22,
          overflow: 'hidden',
        },
        tagsTxt: {
          ...font.meta,
          color: colors.textDim,
          fontSize: 11,
        },
        itemOptionBtn: {
          position: 'absolute',
          right: s(1.3),
          top: s(1.3),
          width: 28,
          height: 28,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(11,11,14,0.74)' : 'rgba(255,255,255,0.92)',
          alignItems: 'center',
          justifyContent: 'center',
        },
        skeletonOptionBtn: {
          overflow: 'hidden',
        },
        status: {
          ...font.meta,
          color: colors.textDim,
          marginBottom: s(2),
        },
      }),
    [colors, isDark]
  );

  if (loading) {
    return (
      <>
        <Text style={styles.title}>Closet</Text>
        <View style={styles.grid}>
          <View style={styles.addBtn}>
            <View style={styles.addBtnSkeletonIcon}>
              <ShimmerPlaceholder borderRadius={13} />
            </View>
            <View style={styles.addBtnSkeletonText}>
              <ShimmerPlaceholder borderRadius={999} />
            </View>
          </View>

          {Array.from({ length: Math.max(2, skeletonCount - 1) }, (_, index) => (
            <View key={`closet-skeleton-${index}`} style={[styles.itemCard, styles.skeletonCard]}>
              <ShimmerPlaceholder borderRadius={16} />
              <View style={[styles.metaChip, styles.skeletonMetaChip]}>
                <ShimmerPlaceholder borderRadius={10} />
              </View>
              <View style={[styles.embeddingChip, styles.skeletonEmbeddingChip]}>
                <ShimmerPlaceholder borderRadius={10} />
              </View>
              <View style={[styles.itemOptionBtn, styles.skeletonOptionBtn]}>
                <ShimmerPlaceholder borderRadius={14} />
              </View>
              <View style={[styles.tagsChip, styles.skeletonTagsChip]}>
                <ShimmerPlaceholder borderRadius={10} />
              </View>
            </View>
          ))}
        </View>
      </>
    );
  }

  return (
    <>
      <Text style={styles.title}>Closet</Text>
      {!items.length && !adding && (
        <Text style={styles.emptyHint}>No closet items yet. Tap the add box to start building your closet.</Text>
      )}
      <View style={styles.grid}>
        <Pressable
          style={[styles.addBtn, adding && { opacity: 0.72 }]}
          onPress={onAddPress}
          disabled={adding}
        >
          {adding ? (
            <ActivityIndicator size="small" color={colors.text} />
          ) : (
            <Ionicons name="add" size={22} color={colors.text} />
          )}
          <Text style={styles.addBtnTxt}>{adding ? 'Adding...' : 'Tap to add item'}</Text>
        </Pressable>

        {items.map((item) => {
          const label = item.category || item.brand || 'Closet';
          const tagsText = item.tags?.length ? item.tags.slice(0, 3).join(' • ') : 'No tags';
          const hasEmbedding = Array.isArray(item.embedding?.vector) && item.embedding.vector.length > 0;
          const embeddingStatus = hasEmbedding
            ? `Embedded${item.embedding?.slot ? ` • ${item.embedding.slot}` : ''}`
            : 'No embedding';
          return (
            <Pressable key={item.id} style={styles.itemCard} onPress={() => onEditItem(item)}>
              <CachedImage
                source={{ uri: item.uri }}
                style={styles.itemImage}
                contentFit="cover"
                transition={120}
                borderRadius={16}
              />
              <View style={styles.metaChip}>
                <Text style={styles.metaTxt}>{label}</Text>
              </View>
              <View
                style={[
                  styles.embeddingChip,
                  hasEmbedding ? styles.embeddingChipReady : styles.embeddingChipMissing,
                ]}
              >
                <Text style={styles.embeddingTxt}>{embeddingStatus}</Text>
              </View>
              <Pressable
                style={styles.itemOptionBtn}
                onPress={(event) => {
                  event.stopPropagation();
                  onOpenItemMenu(item);
                }}
              >
                <Ionicons name="create-outline" size={14} color={colors.text} />
              </Pressable>
              <View style={styles.tagsChip}>
                <Text style={styles.tagsTxt} numberOfLines={1}>
                  {tagsText}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      {adding && (
        <Text style={styles.status}>Auto-tagging and saving this item on your device...</Text>
      )}
    </>
  );
}
