import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, ActivityIndicator, StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { font, radius, s } from '../theme/tokens';
import { recommendFromPrompt } from '../utils/localRecommender';
import { ensureAssetUri } from '../data/assets';
import { useTheme } from '../theme/ThemeContext';
import { pressFeedback } from '../theme/pressFeedback';
import type { ProductLike } from './ProductModal';
import UserAvatar from './UserAvatar';
import CachedImage from './ui/CachedImage';
import ShimmerPlaceholder from './ui/ShimmerPlaceholder';
import { warmImageCache } from '../lib/imageCache';

const BASE_PROMPT = 'Generate an outfit that matches a user closet item using available inventory.';
const BOX_SIZE = 88;

type OutfitGarments = {
  top?: string | null;
  bottom?: string | null;
  mono?: string | null;
  shoes?: string | null;
};

type SlotKey = keyof OutfitGarments;

const SLOT_LABEL_MAP: Record<SlotKey, string> = {
  top: 'Top',
  bottom: 'Bottom',
  mono: 'Mono',
  shoes: 'Shoes',
};

type TodaysPickAnchor = {
  id: string;
  category: SlotKey;
  uri: string;
  detail?: string | null;
};

export type TodaysPickCardData = {
  outfit: OutfitGarments;
  anchor?: TodaysPickAnchor | null;
  slotProducts?: Partial<Record<SlotKey, ProductLike | null>>;
};

type Props = {
  modelUri?: string;
  profileUri?: string | null;
  topUri?: string;
  bottomUri?: string;
  onTryOutfit?: (garments: OutfitGarments) => void;
  onGenerateFromCloset?: (options?: { refresh?: boolean }) => Promise<TodaysPickCardData | OutfitGarments | null>;
  onSelectProduct?: (product: ProductLike) => void;
  autoGenerateOnMount?: boolean;
  closetStatus?: 'loading' | 'empty' | 'ready';
  emptyStateMessage?: string;
  onEmptyStatePress?: () => void;
};

export default function OutfitGeneratorCard({
  modelUri,
  profileUri,
  topUri,
  bottomUri,
  onTryOutfit,
  onGenerateFromCloset,
  onSelectProduct,
  autoGenerateOnMount = false,
  closetStatus = 'ready',
  emptyStateMessage = 'Add an item to your closet to get a custom tailored outfit.',
  onEmptyStatePress,
}: Props) {
  const { colors, isDark } = useTheme();
  const [genBusy, setGenBusy] = useState(false);

  const [generated, setGenerated] = useState<OutfitGarments>(() => ({
    top: onGenerateFromCloset ? null : topUri ?? null,
    bottom: onGenerateFromCloset ? null : bottomUri ?? null,
  }));
  const [anchor, setAnchor] = useState<TodaysPickAnchor | null>(null);
  const [slotProducts, setSlotProducts] = useState<Partial<Record<SlotKey, ProductLike | null>>>({});
  const usesClosetGenerator = Boolean(onGenerateFromCloset);

  const primarySlot: 'top' | 'mono' = generated.mono ? 'mono' : 'top';
  const primaryGarmentLabel: 'Top' | 'Mono' = generated.mono ? 'Mono' : 'Top';
  const primaryGarmentUri = generated.mono ?? generated.top ?? (usesClosetGenerator ? undefined : topUri ?? undefined);
  const bottomUriResolved = generated.bottom ?? (usesClosetGenerator ? undefined : bottomUri ?? undefined);
  const shoesUri = generated.shoes ?? undefined;
  const showClosetEmptyState = closetStatus === 'empty';
  const isClosetLoading = closetStatus === 'loading';
  const canRefresh = !genBusy && !showClosetEmptyState && !isClosetLoading;
  const canTryOn =
    !showClosetEmptyState &&
    !isClosetLoading &&
    Boolean(generated.top || generated.bottom || generated.mono || generated.shoes);
  // Top-right avatar should always represent the signed-in user.
  const headerAvatarUri = profileUri || null;

  const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);

  const applyPickData = useCallback(
    (value: TodaysPickCardData | OutfitGarments | null) => {
      if (!value) return false;
      const hasOutfitShape = typeof value === 'object' && (
        'top' in (value as any) || 'bottom' in (value as any) || 'mono' in (value as any) || 'shoes' in (value as any)
      );
      const payload = hasOutfitShape && !('outfit' in (value as any))
        ? ({ outfit: value as OutfitGarments } as TodaysPickCardData)
        : (value as TodaysPickCardData);
      const nextOutfit = payload.outfit || {};
      const hasAny = Boolean(nextOutfit.top || nextOutfit.bottom || nextOutfit.mono || nextOutfit.shoes);
      if (!hasAny) return false;
      setGenerated({
        top: nextOutfit.top ?? null,
        bottom: nextOutfit.bottom ?? null,
        mono: nextOutfit.mono ?? null,
        shoes: nextOutfit.shoes ?? null,
      });
      setAnchor(payload.anchor || null);
      setSlotProducts(payload.slotProducts || {});
      return true;
    },
    []
  );

  const refreshOutfit = useCallback(
    async ({ silent = false, refresh = false }: { silent?: boolean; refresh?: boolean } = {}) => {
      if (genBusy) return;
      setGenBusy(true);
      try {
        if (onGenerateFromCloset) {
          const picked = await onGenerateFromCloset({ refresh });
          const applied = applyPickData(picked);
          if (!applied) {
            if (!silent) Alert.alert('No suggestions', 'Add closet items first to generate a pick.');
          }
          return;
        }

        const selection = await recommendFromPrompt(BASE_PROMPT, 'any');
        let resolved = 0;
        const resolvedUris: Partial<Record<'top' | 'bottom' | 'mono' | 'shoes', string | null>> = {};
        for (const key of Object.keys(selection) as Array<'top' | 'bottom' | 'mono' | 'shoes'>) {
          const item = selection[key];
          if (!item) continue;
          const uri = await ensureAssetUri(item.imagePath);
          if (uri) {
            resolvedUris[key] = uri;
            resolved += 1;
          }
        }

        if (!resolved) {
          if (!silent) Alert.alert('No suggestions', 'Could not generate an outfit for you.');
        } else {
          applyPickData({
            outfit: {
              top: resolvedUris.top ?? null,
              bottom: resolvedUris.bottom ?? null,
              mono: resolvedUris.mono ?? null,
              shoes: resolvedUris.shoes ?? null,
            },
          });
        }
      } catch (err) {
        console.error('generator error', err);
        if (!silent) Alert.alert('Generator error', 'Failed to generate outfit.');
      } finally {
        setGenBusy(false);
      }
    },
    [applyPickData, genBusy, onGenerateFromCloset]
  );

  useEffect(() => {
    if (!autoGenerateOnMount) return;
    void refreshOutfit({ silent: true, refresh: false });
    // only auto-run once when enabled
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGenerateOnMount]);

  const onPressSlot = useCallback(
    (slot: SlotKey, fallbackUri?: string | null, fallbackLabel?: string) => {
      const fromMap = slotProducts[slot];
      if (fromMap) {
        onSelectProduct?.(fromMap);
        return;
      }
      const uri = String(fallbackUri || '').trim();
      if (!uri || !onSelectProduct) return;
      onSelectProduct({
        title: fallbackLabel || 'Outfit pick',
        images: [uri],
        image: uri,
        category: fallbackLabel || null,
      });
    },
    [onSelectProduct, slotProducts]
  );

  useEffect(() => {
    void warmImageCache(
      [
        primaryGarmentUri || '',
        bottomUriResolved || '',
        shoesUri || '',
        anchor?.uri || '',
        headerAvatarUri || '',
      ],
      { cachePolicy: 'memory-disk', chunkSize: 8 }
    );
  }, [anchor?.uri, bottomUriResolved, headerAvatarUri, primaryGarmentUri, shoesUri]);

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={[font.h2, styles.title]}>Today's pick</Text>
          <Text style={styles.subtitle}>Tailored from your closet</Text>
          {!!anchor && (
            <View style={styles.anchorChip}>
              <Ionicons name="shirt-outline" size={12} color={colors.text} />
              <Text style={styles.anchorChipTxt}>
                Closet anchor: {SLOT_LABEL_MAP[anchor.category]}
                {anchor.detail ? ` • ${anchor.detail}` : ''}
              </Text>
            </View>
          )}
        </View>
        <UserAvatar uri={headerAvatarUri} size={36} style={styles.modelChip} />
      </View>

      <View style={styles.surface}>
        <Text style={styles.sectionLabel}>Outfit snapshot</Text>
        {genBusy || isClosetLoading ? (
          <View style={styles.previewGrid}>
            {[0, 1, 2].map((index) => (
              <View key={`pick-skeleton-${index}`} style={styles.slot}>
                <View style={[styles.skeletonLine, index === 2 && styles.skeletonLineShort]}>
                  <ShimmerPlaceholder borderRadius={6} />
                </View>
                <View style={[styles.slotBox, styles.squareBox, styles.skeletonSlotBox]}>
                  <ShimmerPlaceholder borderRadius={10} />
                </View>
              </View>
            ))}
          </View>
        ) : showClosetEmptyState ? (
          <Pressable
            onPress={onEmptyStatePress}
            disabled={!onEmptyStatePress}
            style={({ pressed }) => [
              styles.emptyState,
              onEmptyStatePress ? pressFeedback(pressed, 'subtle') : null,
            ]}
          >
            <View style={styles.emptyStateIconWrap}>
              <Ionicons name="shirt-outline" size={20} color={colors.text} />
            </View>
            <Text style={styles.emptyStateText}>{emptyStateMessage}</Text>
            {!!onEmptyStatePress && <Text style={styles.emptyStateAction}>Tap to add an item</Text>}
          </Pressable>
        ) : (
          <View style={styles.previewGrid}>
            <Slot
              label={primaryGarmentLabel}
              uri={primaryGarmentUri}
              isAnchor={anchor?.category === primarySlot}
              containerStyle={styles.squareBox}
              styles={styles}
              onPress={() => onPressSlot(primarySlot, primaryGarmentUri, primaryGarmentLabel)}
            />
            <Slot
              label="Bottom"
              uri={bottomUriResolved}
              isAnchor={anchor?.category === 'bottom'}
              containerStyle={styles.squareBox}
              styles={styles}
              onPress={() => onPressSlot('bottom', bottomUriResolved, 'Bottom')}
            />
            <Slot
              label="Shoes"
              uri={shoesUri}
              isAnchor={anchor?.category === 'shoes'}
              containerStyle={styles.squareBox}
              styles={styles}
              onPress={() => onPressSlot('shoes', shoesUri, 'Shoes')}
            />
          </View>
        )}
      </View>

      <View style={styles.footerRow}>
        <Pressable
          style={({ pressed }) => [styles.secondaryBtn, !canRefresh && styles.btnDisabled, canRefresh ? pressFeedback(pressed) : null]}
          disabled={!canRefresh}
          onPress={() => void refreshOutfit({ silent: false, refresh: true })}
        >
          {genBusy ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(1.5) }}>
              <Ionicons name="refresh-outline" size={15} color={colors.text} />
              <Text style={styles.secondaryTxt}>Refresh</Text>
            </View>
          )}
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.primaryBtn, !canTryOn && styles.btnDisabled, canTryOn ? pressFeedback(pressed) : null]}
          disabled={!canTryOn}
          onPress={() =>
            onTryOutfit?.({
              top: generated.top ?? null,
              bottom: generated.bottom ?? null,
              mono: generated.mono ?? null,
              shoes: generated.shoes ?? null,
            })
          }
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(1.5) }}>
            <Ionicons name="sparkles" size={16} color={isDark ? colors.bg : '#fff'} />
            <Text style={styles.primaryTxt}>Try On</Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

function Slot({
  label,
  uri,
  isAnchor,
  containerStyle,
  styles,
  onPress,
}: {
  label: 'Top' | 'Bottom' | 'Mono' | 'Shoes';
  uri?: string;
  isAnchor?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  styles: any;
  onPress?: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.slot, pressFeedback(pressed, 'subtle')]}
      onPress={onPress}
      disabled={!uri || !onPress}
    >
      <Text style={styles.slotLabel}>{label}</Text>
      <View style={[styles.slotBox, containerStyle]}>
        {!!isAnchor && (
          <View style={styles.slotAnchorBadge}>
            <Text style={styles.slotAnchorBadgeTxt}>Closet</Text>
          </View>
        )}
        {uri ? (
          <CachedImage
            source={{ uri }}
            style={styles.slotImg}
            contentFit="contain"
            cachePolicy="memory-disk"
            transition={170}
            borderRadius={10}
          />
        ) : (
          <Text style={styles.placeholder}>Add {label}</Text>
        )}
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: any, isDark: boolean) =>
  StyleSheet.create({
    wrap: {
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.5)',
      backgroundColor: isDark ? 'rgba(17,17,20,0.85)' : 'rgba(255,255,255,0.85)',
      padding: s(2),
      gap: s(2),
      shadowColor: '#000',
      shadowOpacity: 0.05,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 8 },
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    headerText: {
      gap: s(0.5),
      flex: 1,
      paddingRight: s(1),
    },
    title: {
      fontSize: 18,
      fontWeight: '700',
      color: isDark ? '#fff' : colors.text,
    },
    subtitle: {
      fontSize: 12,
      color: isDark ? 'rgba(255,255,255,0.72)' : colors.muted,
      fontWeight: '600',
    },
    anchorChip: {
      alignSelf: 'flex-start',
      marginTop: s(0.35),
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(0.8),
      borderRadius: radius.capsule,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)',
      backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.75)',
      paddingHorizontal: s(1.5),
      paddingVertical: s(0.7),
    },
    anchorChipTxt: {
      fontSize: 11,
      color: colors.text,
      fontWeight: '700',
    },
    modelChip: {
      width: 36,
      height: 36,
      borderRadius: 18,
    },
    surface: {
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.5)',
      backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.55)',
      padding: s(1.75),
      gap: s(1.25),
    },
    sectionLabel: {
      fontSize: 12,
      textTransform: 'uppercase',
      letterSpacing: 1,
      fontWeight: '700',
      color: isDark ? 'rgba(255,255,255,0.72)' : colors.muted,
    },
    previewGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: s(1.25),
    },
    emptyState: {
      minHeight: BOX_SIZE + s(2),
      borderRadius: radius.tile,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.05)',
      backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.58)',
      paddingHorizontal: s(2),
      paddingVertical: s(2.2),
      alignItems: 'center',
      justifyContent: 'center',
      gap: s(1.2),
    },
    emptyStateIconWrap: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.9)',
      borderWidth: 1,
      borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.06)',
    },
    emptyStateText: {
      textAlign: 'center',
      color: colors.text,
      fontSize: 13,
      fontWeight: '700',
      lineHeight: 18,
      maxWidth: 260,
    },
    emptyStateAction: {
      fontSize: 12,
      fontWeight: '800',
      color: colors.textDim,
      textDecorationLine: 'underline',
    },
    slot: {
      width: BOX_SIZE,
    },
    slotLabel: { fontSize: 11, fontWeight: '700', color: colors.muted, marginBottom: s(0.5) },
    skeletonLine: {
      width: '54%',
      height: 10,
      borderRadius: 6,
      marginBottom: s(0.6),
      overflow: 'hidden',
      backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
    },
    skeletonLineShort: {
      width: '42%',
    },
    slotBox: {
      width: '100%',
      height: BOX_SIZE,
      borderRadius: radius.tile,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.05)',
      backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      padding: s(1.25),
    },
    skeletonSlotBox: {
      padding: 0,
    },
    slotAnchorBadge: {
      position: 'absolute',
      top: s(0.8),
      left: s(0.8),
      zIndex: 2,
      borderRadius: radius.capsule,
      paddingHorizontal: s(1.2),
      paddingVertical: s(0.45),
      backgroundColor: isDark ? 'rgba(0,0,0,0.62)' : 'rgba(17,17,17,0.74)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.24)',
    },
    slotAnchorBadgeTxt: {
      color: '#fff',
      fontSize: 10,
      fontWeight: '800',
      letterSpacing: 0.4,
      textTransform: 'uppercase',
    },
    squareBox: {
      height: BOX_SIZE,
    },
    slotImg: { width: '100%', height: '100%' },
    placeholder: { color: colors.muted, fontWeight: '700', fontSize: 12 },
    footerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: s(1.5),
    },
    secondaryBtn: {
      flex: 1,
      height: 40,
      borderRadius: radius.capsule,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
      backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.85)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryTxt: { color: colors.text, fontWeight: '700', fontSize: 13 },
    primaryBtn: {
      flex: 1,
      height: 40,
      borderRadius: radius.capsule,
      backgroundColor: isDark ? '#fff' : colors.text,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryTxt: { color: isDark ? colors.bg : '#fff', fontWeight: '800' },
    btnDisabled: {
      opacity: 0.45,
    },
  });
