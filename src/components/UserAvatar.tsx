import React, { useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle, type ImageStyle } from 'react-native';
import type { ImageContentFit } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';
import { hairline } from '../theme/tokens';
import CachedImage from './ui/CachedImage';

type Props = {
  uri?: string | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
  contentFit?: ImageContentFit;
  transition?: number;
  iconScale?: number;
};

const INVALID_URI_VALUES = new Set(['', 'null', 'undefined', 'nan']);

function normalizeAvatarUri(value?: string | null) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (INVALID_URI_VALUES.has(lower)) return null;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return trimmed;
}

export default function UserAvatar({
  uri,
  size = 32,
  style,
  imageStyle,
  contentFit = 'cover',
  transition = 100,
  iconScale = 0.88,
}: Props) {
  const { colors, isDark } = useTheme();
  const normalizedUri = useMemo(() => normalizeAvatarUri(uri), [uri]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [normalizedUri]);

  const showImage = Boolean(normalizedUri) && !failed;

  return (
    <View
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#EEE',
          borderColor: colors.borderLight,
        },
        style,
      ]}
    >
      {showImage ? (
        <CachedImage
          source={{ uri: normalizedUri! }}
          style={[styles.image, imageStyle as any]}
          contentFit={contentFit}
          transition={transition}
          cachePolicy="memory-disk"
          borderRadius={size / 2}
          onError={() => setFailed(true)}
        />
      ) : (
        <View style={styles.fallback}>
          <Ionicons name="person-circle-outline" size={size * iconScale} color={colors.textDim} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: hairline,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  fallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
