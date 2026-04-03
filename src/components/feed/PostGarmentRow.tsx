import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ProductLike } from '../ProductModal';
import { font, hairline, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import CachedImage from '../ui/CachedImage';

type Props = {
  garments: ProductLike[];
  label?: string;
  onPressItem?: (item: ProductLike) => void;
  compact?: boolean;
};

export default function PostGarmentRow({
  garments,
  label = 'Tried on',
  onPressItem,
  compact = false,
}: Props) {
  const { colors, isDark } = useTheme();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: { gap: s(1.4) },
        label: {
          ...font.meta,
          color: colors.textDim,
          letterSpacing: 0.2,
          textTransform: 'uppercase',
          fontWeight: '700',
        },
        row: {
          paddingRight: s(2),
          flexDirection: 'row',
          gap: s(1.6),
        },
        chip: {
          width: compact ? 56 : 66,
          height: compact ? 56 : 66,
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#fff',
          borderWidth: hairline,
          borderColor: colors.borderLight,
        },
        image: {
          width: '100%',
          height: '100%',
        },
      }),
    [colors, compact, isDark]
  );

  if (!garments.length) return null;

  return (
    <View style={styles.wrap}>
      {!!label && <Text style={styles.label}>{label}</Text>}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {garments.map((item, index) => {
          const uri = item.images?.[0] || item.image || null;
          return (
            <Pressable
              key={`${item.id}:${index}`}
              onPress={() => onPressItem?.(item)}
              style={({ pressed }) => [styles.chip, pressed && { transform: [{ scale: 0.98 }] }]}
              hitSlop={8}
            >
              {uri ? (
                <CachedImage
                  source={{ uri }}
                  style={styles.image}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  transition={120}
                  borderRadius={12}
                />
              ) : (
                <View
                  style={[
                    styles.image,
                    {
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#F5F5F5',
                    },
                  ]}
                >
                  <Ionicons
                    name="shirt-outline"
                    size={18}
                    color={isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.25)'}
                  />
                </View>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
