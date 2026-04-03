import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { radius, s } from '../theme/tokens';
import { useTheme } from '../theme/ThemeContext';
import { pressFeedback } from '../theme/pressFeedback';
import { toGBPPriceLabel } from '../lib/currency';
import RevealOnMount from './ui/RevealOnMount';
import CachedImage from './ui/CachedImage';

type Props = {
  title: string;
  image: string;
  price?: string | null;
  onPress?: () => void;
  width?: number;
};

export default function ItemCard({ title, image, price, onPress, width = 120 }: Props) {
  const { colors, isDark } = useTheme();
  const priceLabel = toGBPPriceLabel(price);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        tile: {
          height: 150,
          borderRadius: radius.tile,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.65)',
          marginBottom: s(1),
        },
        img: { width: '100%', height: '100%' },
        title: { fontSize: 12, fontWeight: '700', letterSpacing: 0.2, color: colors.text },
        price: { fontSize: 12, color: colors.muted, marginTop: 2 },
      }),
    [colors, isDark]
  );
  return (
    <RevealOnMount delay={70} distance={10}>
      <Pressable onPress={onPress} style={({ pressed }) => [{ width }, pressFeedback(pressed)]}>
        <View style={styles.tile}>
          <CachedImage
            source={{ uri: image }}
            style={styles.img}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={140}
            borderRadius={radius.tile}
          />
        </View>
        <Text numberOfLines={1} style={styles.title}>{title}</Text>
        {!!priceLabel && <Text style={styles.price}>{priceLabel}</Text>}
      </Pressable>
    </RevealOnMount>
  );
}
