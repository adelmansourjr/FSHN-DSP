import React, { useEffect, useMemo, useState } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import {
  Image as ExpoImage,
  type ImageContentFit,
  type ImageProps as ExpoImageProps,
} from 'expo-image';
import ShimmerPlaceholder from './ShimmerPlaceholder';

type CachePolicy = NonNullable<ExpoImageProps['cachePolicy']>;

type Props = {
  source: ExpoImageProps['source'];
  style: StyleProp<ViewStyle>;
  contentFit?: ImageContentFit;
  contentPosition?: ExpoImageProps['contentPosition'];
  cachePolicy?: CachePolicy;
  transition?: number;
  priority?: ExpoImageProps['priority'];
  borderRadius?: number;
  showShimmer?: boolean;
  shimmerDelayMs?: number;
  shimmerStyle?: StyleProp<ViewStyle>;
  onLoad?: ExpoImageProps['onLoad'];
  onError?: ExpoImageProps['onError'];
  onLoadEnd?: () => void;
};

const HOT_CACHE_LIMIT = 1400;
const hotSourceKeys = new Set<string>();
const hotSourceOrder: string[] = [];

const markHotSource = (key: string) => {
  if (!key || hotSourceKeys.has(key)) return;
  hotSourceKeys.add(key);
  hotSourceOrder.push(key);
  if (hotSourceOrder.length <= HOT_CACHE_LIMIT) return;
  const stale = hotSourceOrder.shift();
  if (!stale) return;
  hotSourceKeys.delete(stale);
};

const sourceKey = (source: ExpoImageProps['source']) => {
  if (!source) return '';
  if (typeof source === 'number') return String(source);
  if (Array.isArray(source)) {
    return source
      .map((item) => String((item as any)?.uri || ''))
      .join('|');
  }
  if (typeof source === 'string') return source;
  return String((source as any)?.uri || '');
};

export default function CachedImage({
  source,
  style,
  contentFit = 'cover',
  contentPosition = 'center',
  cachePolicy = 'memory-disk',
  transition = 160,
  priority = 'normal',
  borderRadius,
  showShimmer = true,
  shimmerDelayMs = 90,
  shimmerStyle,
  onLoad,
  onError,
  onLoadEnd,
}: Props) {
  const [loaded, setLoaded] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const key = useMemo(() => sourceKey(source), [source]);

  useEffect(() => {
    if (!key || hotSourceKeys.has(key)) {
      setLoaded(true);
      setShowSkeleton(false);
      return;
    }
    setLoaded(false);
    setShowSkeleton(false);
    if (!showShimmer) return;
    const timer = setTimeout(() => setShowSkeleton(true), Math.max(0, shimmerDelayMs));
    return () => clearTimeout(timer);
  }, [key, showShimmer, shimmerDelayMs]);

  const flattened = StyleSheet.flatten(style) as ViewStyle | undefined;
  const radius =
    typeof borderRadius === 'number'
      ? borderRadius
      : typeof flattened?.borderRadius === 'number'
        ? flattened.borderRadius
        : 0;

  return (
    <View style={[styles.wrap, style, radius ? { borderRadius: radius } : null]}>
      <ExpoImage
        source={source}
        style={StyleSheet.absoluteFill}
        contentFit={contentFit}
        contentPosition={contentPosition}
        cachePolicy={cachePolicy}
        transition={transition}
        priority={priority}
        onLoad={(event) => {
          markHotSource(key);
          setLoaded(true);
          onLoad?.(event);
        }}
        onError={(event) => {
          markHotSource(key);
          setLoaded(true);
          onError?.(event);
        }}
        onLoadEnd={() => {
          markHotSource(key);
          setLoaded(true);
          onLoadEnd?.();
        }}
      />
      {showShimmer && showSkeleton && (
        <ShimmerPlaceholder visible={!loaded} borderRadius={radius} style={shimmerStyle} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: 'hidden',
  },
});
