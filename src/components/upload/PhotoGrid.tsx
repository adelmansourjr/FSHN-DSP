// src/components/upload/PhotoGrid.tsx
import React from 'react';
import { View, StyleSheet, Pressable, Text } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { hairline, radius, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';

export type Photo = { uri: string };

type Props = {
  photos: Photo[];
  onChange: (next: Photo[]) => void;
  onAddFromGallery: () => void;
  onOpenCamera: () => void;
};

export default function PhotoGrid({ photos, onChange, onAddFromGallery, onOpenCamera }: Props) {
  const { colors, isDark } = useTheme();
  const removeAt = (i: number) => {
    const next = photos.slice();
    next.splice(i, 1);
    onChange(next);
  };

  const moveLeft = (i: number) => {
    if (i <= 0) return;
    const next = photos.slice();
    const tmp = next[i - 1];
    next[i - 1] = next[i];
    next[i] = tmp;
    onChange(next);
  };

  const makeCover = (i: number) => {
    if (i === 0) return;
    const next = photos.slice();
    const [item] = next.splice(i, 1);
    next.unshift(item);
    onChange(next);
  };

  // 3-column grid
  const items: Array<{ type: 'photo'; uri: string; i: number } | { type: 'add' } | { type: 'camera' }> = [
    { type: 'add' },
    { type: 'camera' },
    ...photos.map((p, i) => ({ type: 'photo' as const, uri: p.uri, i })),
  ];
  const styles = React.useMemo(
    () =>
      StyleSheet.create({
        grid: {
          marginTop: s(2),
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: s(2),
        },
        tile: {
          width: '31.5%',
          aspectRatio: 1,
          borderRadius: radius.tile,
          overflow: 'hidden',
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#fff',
          borderWidth: hairline,
          borderColor: colors.borderLight,
        },
        img: { width: '100%', height: '100%' },
        actionTile: {
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.85)',
        },
        actionTxt: { marginTop: 6, fontWeight: '700', color: colors.text, fontSize: 12 },
        coverBadge: {
          position: 'absolute',
          top: 6, left: 6,
          flexDirection: 'row',
          gap: 6,
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 12,
          backgroundColor: isDark ? 'rgba(11,11,14,0.78)' : 'rgba(255,255,255,0.92)',
          borderWidth: hairline,
          borderColor: colors.borderLight,
          alignItems: 'center',
        },
        coverTxt: { fontSize: 11, fontWeight: '800', color: colors.text },
        controlsRow: {
          position: 'absolute',
          right: 6, bottom: 6,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        },
        ctrlIcon: {
          width: 28, height: 28,
          borderRadius: 14,
          backgroundColor: isDark ? 'rgba(11,11,14,0.78)' : 'rgba(255,255,255,0.92)',
          borderWidth: hairline,
          borderColor: colors.borderLight,
          alignItems: 'center',
          justifyContent: 'center',
        },
        ctrlPill: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: 10,
          height: 28,
          borderRadius: 999,
          backgroundColor: isDark ? 'rgba(11,11,14,0.78)' : 'rgba(255,255,255,0.92)',
          borderWidth: hairline,
          borderColor: colors.borderLight,
        },
        ctrlTxt: { fontSize: 11, fontWeight: '800', color: colors.text },
      }),
    [colors, isDark]
  );

  return (
    <View style={styles.grid}>
      {items.map((it, idx) => {
        if (it.type === 'photo') {
          const { uri, i } = it;
          const isCover = i === 0;
          return (
            <View key={`p-${uri}-${idx}`} style={styles.tile}>
              <ExpoImage
                source={{ uri }}
                style={styles.img}
                contentFit="cover"
                transition={100}
                cachePolicy="memory-disk"
              />
              {isCover && (
                <View style={styles.coverBadge}>
                  <Ionicons name="star" size={12} color={colors.text} />
                  <Text style={styles.coverTxt}>Cover</Text>
                </View>
              )}
              {/* Controls */}
              <View style={styles.controlsRow}>
                {!isCover && (
                  <Pressable onPress={() => makeCover(i)} style={styles.ctrlPill}>
                    <Ionicons name="star-outline" size={14} color={colors.text} />
                    <Text style={styles.ctrlTxt}>Cover</Text>
                  </Pressable>
                )}
                {!isCover && (
                  <Pressable onPress={() => moveLeft(i)} style={styles.ctrlIcon}>
                    <Ionicons name="chevron-back" size={16} color={colors.text} />
                  </Pressable>
                )}
                <Pressable onPress={() => removeAt(i)} style={styles.ctrlIcon}>
                  <Ionicons name="close" size={14} color={colors.text} />
                </Pressable>
              </View>
            </View>
          );
        }
        if (it.type === 'add') {
          return (
            <Pressable key="add" onPress={onAddFromGallery} style={[styles.tile, styles.actionTile]}>
              <Ionicons name="image-outline" size={20} color={colors.text} />
              <Text style={styles.actionTxt}>Add photos</Text>
            </Pressable>
          );
        }
        return (
          <Pressable key="cam" onPress={onOpenCamera} style={[styles.tile, styles.actionTile]}>
            <Ionicons name="camera-outline" size={20} color={colors.text} />
            <Text style={styles.actionTxt}>Open camera</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
