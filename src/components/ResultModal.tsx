import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { Modal, View, Text, StyleSheet, Pressable, Share, Alert, Animated, ActivityIndicator, ScrollView, Platform } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { Image as RNImage } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PinchGestureHandler, TapGestureHandler, PanGestureHandler, State } from 'react-native-gesture-handler';

import { colors, font, s, hairline } from '../theme/tokens';
import { useAuth } from '../context/AuthContext';
import { deleteLocalOutfitResult, saveLocalOutfitResult } from '../lib/localOutfits';
import { createPostFromImage } from '../lib/firebasePosts';
import type { PostGarmentInput } from '../lib/firebasePosts';
import ProductModal, { type ProductLike } from './ProductModal';

type Props = {
  visible: boolean;
  onClose: () => void;
  afterUri?: string | null; // JPEG data URI or http(s) URL
  savedOutfitId?: string | null;
  postGarments?: PostGarmentInput[];
  savedOutfitItems?: PostGarmentInput[];
  resolveUsedItemProduct?: (item: PostGarmentInput) => ProductLike | null;
  getUsedItemInitialLiked?: (product: ProductLike | null) => boolean;
  onUsedItemLikeChange?: (liked: boolean, product: ProductLike) => void;
};

const USED_ITEM_SLOT_LABEL: Record<'top' | 'bottom' | 'mono' | 'shoes', string> = {
  top: 'Top',
  bottom: 'Bottom',
  mono: 'Mono',
  shoes: 'Shoes',
};

function normalizeUsedItemSlot(value?: string | null): keyof typeof USED_ITEM_SLOT_LABEL | null {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes('top')) return 'top';
  if (raw.includes('bottom')) return 'bottom';
  if (raw.includes('mono') || raw.includes('dress') || raw.includes('gown') || raw.includes('jumpsuit') || raw.includes('romper')) {
    return 'mono';
  }
  if (
    raw.includes('shoe') ||
    raw.includes('footwear') ||
    raw.includes('sneaker') ||
    raw.includes('trainer') ||
    raw.includes('boot') ||
    raw.includes('heel') ||
    raw.includes('loafer') ||
    raw.includes('sandal')
  ) {
    return 'shoes';
  }
  return null;
}

function getUsedItemSlotLabel(item?: PostGarmentInput | null) {
  const slot =
    normalizeUsedItemSlot((item as any)?.slot) ||
    normalizeUsedItemSlot(item?.role) ||
    normalizeUsedItemSlot(item?.category);
  return slot ? USED_ITEM_SLOT_LABEL[slot] : '';
}

export default function ResultModal({
  visible,
  onClose,
  afterUri,
  savedOutfitId,
  postGarments,
  savedOutfitItems,
  resolveUsedItemProduct,
  getUsedItemInitialLiked,
  onUsedItemLikeChange,
}: Props) {
  const HIT_SLOP = { top: 36, bottom: 36, left: 36, right: 36 };
  const src = useMemo(() => (afterUri ? { uri: afterUri } : undefined), [afterUri]);
  const [fit, setFit] = useState<'contain' | 'cover'>('contain');
  const insets = useSafeAreaInsets();
  const { user, profile } = useAuth();
  const [saving, setSaving] = useState(false);
  const [unsaving, setUnsaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [uploadedOnce, setUploadedOnce] = useState(false);
  const [usedItemsVisible, setUsedItemsVisible] = useState(false);
  const [pendingUsedItem, setPendingUsedItem] = useState<PostGarmentInput | null>(null);
  const [usedItemProduct, setUsedItemProduct] = useState<ProductLike | null>(null);
  const [usedItemProductVisible, setUsedItemProductVisible] = useState(false);
  const [uiVisible, setUiVisible] = useState(true);
  const [uiActive, setUiActive] = useState(true); // controls pointerEvents for UI
  const uiOpacity = useRef(new Animated.Value(1)).current;
  const [isZoomed, setIsZoomed] = useState(false);
  const swipeX = useRef(new Animated.Value(0)).current;
  const swipeOpacity = swipeX.interpolate({
    inputRange: [0, 140],
    outputRange: [1, 0.6],
    extrapolate: 'clamp',
  });

  // layout / sizing for clamping
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [intrinsicSize, setIntrinsicSize] = useState<{ width: number; height: number } | null>(null);

  // pinch to zoom
  const baseScale = useRef(new Animated.Value(1)).current;
  const pinchScale = useRef(new Animated.Value(1)).current;
  const lastScale = useRef(1);
  const animatedScale = Animated.multiply(baseScale, pinchScale);
  const pinchRef = useRef<any>(null);
  const tapRef = useRef<any>(null);
  const panRef = useRef<any>(null);

  // pan to move image when zoomed
  const baseTranslateX = useRef(new Animated.Value(0)).current;
  const baseTranslateY = useRef(new Animated.Value(0)).current;
  const panX = useRef(new Animated.Value(0)).current;
  const panY = useRef(new Animated.Value(0)).current;
  const lastPan = useRef({ x: 0, y: 0 });
  const translateX = Animated.add(baseTranslateX, panX) as any;
  const translateY = Animated.add(baseTranslateY, panY) as any;

  const MAX_SCALE = 4;

  // clamp helper
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

  // handle pinch gesture frames, clamp scale and also clamp current pan to bounds
  const onPinchGesture = (event: any) => {
    const scaleRaw = event.nativeEvent.scale || 1;
    let curScale = lastScale.current * scaleRaw;
    curScale = clamp(curScale, 1, MAX_SCALE);

    // update pinchScale so visual = baseScale * pinchScale
    const localPinch = curScale / Math.max(0.0001, lastScale.current);
    pinchScale.setValue(localPinch);

    // while pinching, ensure translations remain within bounds for current scale
    const { maxX, maxY } = computePanBounds(curScale);
    const tentativeX = lastPan.current.x + (event.nativeEvent.translationX || 0);
    const tentativeY = lastPan.current.y + (event.nativeEvent.translationY || 0);
    const clampedX = clamp(tentativeX, -maxX, maxX);
    const clampedY = clamp(tentativeY, -maxY, maxY);
    // set panX/panY relative to lastPan (so transforms = base + pan)
    panX.setValue(clampedX - lastPan.current.x);
    panY.setValue(clampedY - lastPan.current.y);
  };

  // handle pan gesture frames, clamp translations to bounds for current scale
  const onPanGesture = (event: any) => {
    const tx = event.nativeEvent.translationX || 0;
    const ty = event.nativeEvent.translationY || 0;
    const curScale = lastScale.current;

    if (curScale <= 1.01) {
      // no panning when at default scale
      panX.setValue(0);
      panY.setValue(0);
      return;
    }

    const { maxX, maxY } = computePanBounds(curScale);
    const tentativeX = lastPan.current.x + tx;
    const tentativeY = lastPan.current.y + ty;
    const clampedX = clamp(tentativeX, -maxX, maxX);
    const clampedY = clamp(tentativeY, -maxY, maxY);
    panX.setValue(clampedX - lastPan.current.x);
    panY.setValue(clampedY - lastPan.current.y);
  };

  // measure intrinsic image size when uri changes
  React.useEffect(() => {
    if (src && (src as any).uri) {
      const uri = (src as any).uri as string;
      // try to get image size (works for http(s) and data URIs)
      RNImage.getSize(uri, (w, h) => setIntrinsicSize({ width: w, height: h }), () => setIntrinsicSize(null));
    } else {
      setIntrinsicSize(null);
    }
  }, [src]);

  React.useEffect(() => {
    if (!visible) {
      setSaving(false);
      setUnsaving(false);
      setUploading(false);
      setSavedOnce(false);
      setUploadedOnce(false);
      setUsedItemsVisible(false);
      setPendingUsedItem(null);
      setUsedItemProduct(null);
      setUsedItemProductVisible(false);
      return;
    }
    setSavedOnce(false);
    setUploadedOnce(false);
  }, [afterUri, visible]);

  useEffect(() => {
    if (usedItemsVisible || !pendingUsedItem || !resolveUsedItemProduct) return;
    const timer = setTimeout(() => {
      if (!pendingUsedItem) return;
      const resolved = resolveUsedItemProduct(pendingUsedItem);
      if (resolved) {
        setUsedItemProduct(resolved);
        setUsedItemProductVisible(true);
      }
      setPendingUsedItem(null);
    }, 260);
    return () => clearTimeout(timer);
  }, [pendingUsedItem, resolveUsedItemProduct, usedItemsVisible]);

  const isSavedOutput = useMemo(
    () => Boolean(user?.uid && savedOutfitId),
    [savedOutfitId, user?.uid]
  );
  const normalizedSavedUsedItems = useMemo<PostGarmentInput[]>(
    () => (Array.isArray(savedOutfitItems) ? savedOutfitItems.filter(Boolean) : []),
    [savedOutfitItems]
  );
  const normalizedPostUsedItems = useMemo<PostGarmentInput[]>(
    () => (Array.isArray(postGarments) ? postGarments.filter(Boolean) : []),
    [postGarments]
  );
  const visibleUsedItems = useMemo<PostGarmentInput[]>(() => {
    if (isSavedOutput && normalizedSavedUsedItems.length) return normalizedSavedUsedItems;
    if (normalizedPostUsedItems.length) return normalizedPostUsedItems;
    if (normalizedSavedUsedItems.length) return normalizedSavedUsedItems;
    return [];
  }, [isSavedOutput, normalizedPostUsedItems, normalizedSavedUsedItems]);
  const canViewUsedItems = Boolean(afterUri);
  const safeTopInset = insets.top > 0 ? insets.top : (Platform.OS === 'ios' ? 44 : 0);
  const headerTop = Math.max(safeTopInset + s(0.8), s(2.6));
  const gestureTop = headerTop + 46 + s(1.2);

  const onPinchStateChange = (event: any) => {
    if (event.nativeEvent.oldState === State.ACTIVE) {
      let newScale = lastScale.current * event.nativeEvent.scale;
      newScale = Math.max(1, Math.min(newScale, 4));

      // If zoomed out to (or below) default, snap back to default scale and center position
      if (newScale <= 1.01) {
        setIsZoomed(false);
        Animated.parallel([
          Animated.timing(baseScale, { toValue: 1, duration: 150, useNativeDriver: false }),
          Animated.timing(baseTranslateX, { toValue: 0, duration: 150, useNativeDriver: false }),
          Animated.timing(baseTranslateY, { toValue: 0, duration: 150, useNativeDriver: false }),
        ]).start(() => {
          lastScale.current = 1;
          lastPan.current = { x: 0, y: 0 };
          baseScale.setValue(1);
          baseTranslateX.setValue(0);
          baseTranslateY.setValue(0);
        });
      } else {
        setIsZoomed(true);
        lastScale.current = newScale;
        baseScale.setValue(lastScale.current);

        // ensure translations are within bounds for the new scale
        const { maxX, maxY } = computePanBounds(lastScale.current);
        const clampedX = Math.max(-maxX, Math.min(maxX, lastPan.current.x));
        const clampedY = Math.max(-maxY, Math.min(maxY, lastPan.current.y));
        lastPan.current.x = clampedX;
        lastPan.current.y = clampedY;
        baseTranslateX.setValue(clampedX);
        baseTranslateY.setValue(clampedY);
      }

      pinchScale.setValue(1);
    }
  };

  const onPanStateChange = (event: any) => {
    if (event.nativeEvent.oldState === State.ACTIVE) {
      const tentativeX = lastPan.current.x + event.nativeEvent.translationX;
      const tentativeY = lastPan.current.y + event.nativeEvent.translationY;
      const curScale = lastScale.current;

      // If scale is at (or very near) default, always snap to center (no panning allowed)
      if (curScale <= 1.01) {
        setIsZoomed(false);
        // animate back to center for a smooth UX, then disable panning
        Animated.timing(baseTranslateX, { toValue: 0, duration: 160, useNativeDriver: false }).start();
        Animated.timing(baseTranslateY, { toValue: 0, duration: 160, useNativeDriver: false }).start(() => {
          lastPan.current = { x: 0, y: 0 };
          baseTranslateX.setValue(0);
          baseTranslateY.setValue(0);
          panX.setValue(0);
          panY.setValue(0);
        });
        return;
      }

      // accumulate the pan and clamp to bounds based on current scale
      const { maxX, maxY } = computePanBounds(curScale);
      const clampedX = Math.max(-maxX, Math.min(maxX, tentativeX));
      const clampedY = Math.max(-maxY, Math.min(maxY, tentativeY));
      lastPan.current.x = clampedX;
      lastPan.current.y = clampedY;
      baseTranslateX.setValue(clampedX);
      baseTranslateY.setValue(clampedY);
      panX.setValue(0);
      panY.setValue(0);
    }
  };

  const onCloseSwipeStateChange = (event: any) => {
    if (event.nativeEvent.state === State.END || event.nativeEvent.oldState === State.ACTIVE) {
      const { translationX, translationY, velocityX, velocityY } = event.nativeEvent;
      const isHorizontal = Math.abs(translationX) > Math.abs(translationY) * 1.2;
      const passedDistance = translationX > 90;
      const passedVelocity = velocityX > 650 && Math.abs(velocityY) < 800;

      if (isHorizontal && translationX > 0 && (passedDistance || passedVelocity)) {
        const targetX = Math.max(translationX, 240);
        Animated.parallel([
          Animated.timing(swipeX, { toValue: targetX, duration: 180, useNativeDriver: true }),
          Animated.timing(uiOpacity, { toValue: 0, duration: 140, useNativeDriver: false }),
        ]).start(() => {
          swipeX.setValue(0);
          uiOpacity.setValue(1);
          onClose();
        });
      } else {
        Animated.timing(swipeX, { toValue: 0, duration: 180, useNativeDriver: true }).start();
      }
    }
  };

  const onCloseSwipeGesture = (event: any) => {
    const rawX = event.nativeEvent.translationX || 0;
    // Only allow rightward swipe to move the modal
    swipeX.setValue(Math.max(0, rawX));
  };

  const animateUI = (show: boolean) => {
    if (show) {
      // make interactive first, then fade in
      setUiActive(true);
      Animated.timing(uiOpacity, { toValue: 1, duration: 180, useNativeDriver: false }).start(() => {
        setUiVisible(true);
      });
    } else {
      // fade out, then disable interactions
      Animated.timing(uiOpacity, { toValue: 0, duration: 180, useNativeDriver: false }).start(() => {
        setUiVisible(false);
        setUiActive(false);
      });
    }
  };

  const onTapHandler = (event: any) => {
    if (event.nativeEvent.state === State.END) {
      animateUI(!uiVisible);
    }
  };

  // compute how much the image can be translated for a given scale (half-range)
  const computePanBounds = (scale: number) => {
    const cW = containerSize.width || 0;
    const cH = containerSize.height || 0;
    if (!cW || !cH) return { maxX: 0, maxY: 0 };

    // intrinsic (natural) image size
    const iW = intrinsicSize?.width || cW;
    const iH = intrinsicSize?.height || cH;

    // fit the image into container using 'contain'
    const imageAspect = iW / iH;
    const containerAspect = cW / cH;
    let displayW = cW;
    let displayH = cH;
    if (imageAspect > containerAspect) {
      // image is wider than container -> full width
      displayW = cW;
      displayH = cW / imageAspect;
    } else {
      displayH = cH;
      displayW = cH * imageAspect;
    }

    const scaledW = displayW * scale;
    const scaledH = displayH * scale;

    const maxX = Math.max(0, (scaledW - cW) / 2);
    const maxY = Math.max(0, (scaledH - cH) / 2);
    return { maxX, maxY };
  };

  const shareIt = async () => {
    try { await Share.share({ url: afterUri || '', message: 'Try-on result' }); }
    catch {}
  };

  const handleSaveOutfit = useCallback(async () => {
    if (!afterUri) return;
    if (!user) {
      Alert.alert('Sign in required', 'Please sign in to save outfits.');
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      await saveLocalOutfitResult(user.uid, afterUri, visibleUsedItems || []);
      setSavedOnce(true);
      Alert.alert('Saved', 'Outfit saved on this device.');
    } catch (err: any) {
      Alert.alert('Save failed', err?.message || 'Unable to save outfit.');
    } finally {
      setSaving(false);
    }
  }, [afterUri, saving, user, visibleUsedItems]);

  const handleUploadResult = useCallback(async () => {
    if (!afterUri) return;
    if (!user) {
      Alert.alert('Sign in required', 'Please sign in to upload a post.');
      return;
    }
    if (uploading) return;
    setUploading(true);
    try {
      await createPostFromImage({
        authorUid: user.uid,
        imageUri: afterUri,
        caption: '',
        authorUsername: profile?.username || '',
        authorPhotoURL: profile?.photoURL || '',
        garments: visibleUsedItems || [],
      });
      setUploadedOnce(true);
      Alert.alert('Uploaded', 'Result posted to your feed.');
    } catch (err: any) {
      Alert.alert('Upload failed', err?.message || 'Unable to upload result.');
    } finally {
      setUploading(false);
    }
  }, [afterUri, profile?.photoURL, profile?.username, uploading, user, visibleUsedItems]);

  const handleUnsaveOutfit = useCallback(async () => {
    if (!user) {
      Alert.alert('Sign in required', 'Please sign in to manage saved outfits.');
      return;
    }
    if (!savedOutfitId) {
      Alert.alert('Unavailable', 'This saved outfit could not be identified.');
      return;
    }
    if (unsaving) return;
    setUnsaving(true);
    try {
      await deleteLocalOutfitResult(user.uid, savedOutfitId);
      Alert.alert('Unsaved', 'Outfit removed from your saved outfits.');
      onClose();
    } catch (err: any) {
      Alert.alert('Unsave failed', err?.message || 'Unable to unsave outfit.');
    } finally {
      setUnsaving(false);
    }
  }, [onClose, savedOutfitId, unsaving, user]);

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
    >
      <PanGestureHandler
        enabled={!isZoomed}
        onGestureEvent={onCloseSwipeGesture}
        onHandlerStateChange={onCloseSwipeStateChange}
        simultaneousHandlers={[panRef, pinchRef, tapRef]}
      >
        <Animated.View style={[styles.wrap, { transform: [{ translateX: swipeX }], opacity: swipeOpacity }]}>
        {/* gesture area: positioned below header and above bottom controls so header buttons remain tappable */}
        <View onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            setContainerSize({ width, height });
          }}
          // place gesture area below header (header height = 46) to avoid intercepting header touches
          style={{ position: 'absolute', left: 0, right: 0, top: gestureTop, bottom: Math.max(insets.bottom, 12) + 8 }}>
          <TapGestureHandler ref={tapRef} onHandlerStateChange={onTapHandler} simultaneousHandlers={[pinchRef, panRef]}>
            <PanGestureHandler ref={panRef} onGestureEvent={onPanGesture} onHandlerStateChange={onPanStateChange} simultaneousHandlers={[tapRef, pinchRef]}>
              <PinchGestureHandler ref={pinchRef} onGestureEvent={onPinchGesture} onHandlerStateChange={onPinchStateChange} simultaneousHandlers={[tapRef, panRef]}>
                <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX }, { translateY }, { scale: animatedScale }] }] as any}>
                  <ExpoImage
                    source={src}
                    style={StyleSheet.absoluteFill}
                    contentFit={fit}
                    cachePolicy="memory-disk"
                    transition={200}
                  />
                </Animated.View>
              </PinchGestureHandler>
            </PanGestureHandler>
          </TapGestureHandler>
        </View>

        {/* header with explicit inset spacing to avoid notch / dynamic island overlap */}
        <View style={[styles.header as any, { top: headerTop }]}>
          <Animated.View style={[styles.glass, { opacity: uiOpacity }]} pointerEvents={uiActive ? 'auto' : 'none'}>
            <Pressable
              style={styles.btn}
              onPress={onClose}
              hitSlop={HIT_SLOP}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="chevron-back" size={18} color={colors.text} />
            </Pressable>
            <Text style={[font.h3, { position: 'absolute', left: 0, right: 0, textAlign: 'center', color: colors.text, fontWeight: '800' }]}>Result</Text>
            <View style={styles.rightIcons}>
              <Pressable style={styles.btn} onPress={() => setFit(fit === 'contain' ? 'cover' : 'contain')} hitSlop={HIT_SLOP}>
                <Ionicons name={fit === 'contain' ? 'expand-outline' : 'contract-outline'} size={18} color={colors.text} />
              </Pressable>
              <Pressable style={[styles.btn, { marginLeft: 8 }]} onPress={shareIt} hitSlop={HIT_SLOP}>
                <Ionicons name="share-outline" size={18} color={colors.text} />
              </Pressable>
            </View>
          </Animated.View>
        </View>

        {/* tap handled by TapGestureHandler above; no full-screen Pressable needed */}

        {/* Save outfit button fixed at bottom above safe area */}
        <SafeAreaView edges={["bottom"]} style={styles.bottomArea as any}>
          <Animated.View style={{ paddingBottom: Math.max(insets.bottom, 12), alignItems: 'center', opacity: uiOpacity }} pointerEvents={uiActive ? 'auto' : 'none'}>
            <Pressable
              style={({ pressed }) => [
                styles.saveBtn,
                pressed && { opacity: 0.9 },
                ((isSavedOutput ? unsaving : saving) || uploadedOnce) && { opacity: 0.7 },
              ]}
              onPress={isSavedOutput ? handleUnsaveOutfit : handleSaveOutfit}
              disabled={(isSavedOutput ? unsaving : saving) || !afterUri}
            >
              {(isSavedOutput ? unsaving : saving) ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.saveTxt}>
                  {isSavedOutput ? 'Unsave Outfit' : savedOnce ? 'Saved' : 'Save Outfit'}
                </Text>
              )}
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.uploadBtn,
                pressed && { opacity: 0.9 },
                (uploading || uploadedOnce) && { opacity: 0.7 },
              ]}
              onPress={handleUploadResult}
              disabled={uploading || !afterUri}
            >
              {uploading ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Text style={styles.uploadTxt}>{uploadedOnce ? 'Uploaded' : 'Upload Result'}</Text>
              )}
            </Pressable>

            {canViewUsedItems && (
              <Pressable
                style={({ pressed }) => [
                  styles.usedItemsBtn,
                  pressed && styles.usedItemsBtnPressed,
                ]}
                onPress={() => setUsedItemsVisible(true)}
              >
                <View style={styles.usedItemsIconBadge}>
                  <Ionicons name="shirt-outline" size={15} color={colors.text} />
                </View>
                <View style={styles.usedItemsCopy}>
                  <Text style={styles.usedItemsTxt}>View Tried Items</Text>
                  <Text style={styles.usedItemsHint}>
                    {visibleUsedItems.length
                      ? `${visibleUsedItems.length} selected for this outfit`
                      : 'No tried items found yet'}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textDim} style={styles.usedItemsChevron} />
              </Pressable>
            )}
          </Animated.View>
        </SafeAreaView>
        </Animated.View>
      </PanGestureHandler>

      <Modal
        visible={usedItemsVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setUsedItemsVisible(false)}
        presentationStyle="overFullScreen"
        statusBarTranslucent
      >
        <View style={styles.usedItemsBackdrop}>
          <Pressable style={{ flex: 1 }} onPress={() => setUsedItemsVisible(false)} />
          <View style={styles.usedItemsSheet}>
            <View style={styles.usedItemsHeader}>
              <Text style={styles.usedItemsHeaderTitle}>Tried On Items</Text>
              <Pressable style={styles.usedItemsCloseBtn} onPress={() => setUsedItemsVisible(false)}>
                <Ionicons name="close" size={18} color={colors.text} />
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.usedItemsScroll}>
              {visibleUsedItems.length === 0 && (
                <View style={styles.usedItemsEmpty}>
                  <Ionicons name="shirt-outline" size={18} color={colors.textDim} />
                  <Text style={styles.usedItemsEmptyTitle}>No tried items available</Text>
                  <Text style={styles.usedItemsEmptyBody}>
                    Save a new outfit after selecting garments to see item details here.
                  </Text>
                </View>
              )}
              {visibleUsedItems.map((item, index) => {
                const image = String(item?.image || '').trim();
                const title = String(item?.title || item?.role || 'Item').trim();
                const slotLabel = getUsedItemSlotLabel(item);
                const listingId = String(item?.listingId || '').trim();
                const itemId = String(item?.itemId || '').trim();
                return (
                  <Pressable
                    key={`${listingId || itemId || title}-${index}`}
                    style={({ pressed }) => [
                      styles.usedItemRow,
                      pressed && !!resolveUsedItemProduct && styles.usedItemRowPressed,
                    ]}
                    disabled={!resolveUsedItemProduct}
                    onPress={() => {
                      if (!resolveUsedItemProduct) return;
                      setPendingUsedItem(item);
                      setUsedItemsVisible(false);
                    }}
                  >
                    {!!image ? (
                      <ExpoImage source={{ uri: image }} style={styles.usedItemImage} contentFit="cover" transition={120} />
                    ) : (
                      <View style={[styles.usedItemImage, styles.usedItemImageFallback]}>
                        <Ionicons name="image-outline" size={16} color={colors.textDim} />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={styles.usedItemTitle}>
                        {slotLabel || ' '}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <ProductModal
        visible={usedItemProductVisible}
        onClose={() => setUsedItemProductVisible(false)}
        product={usedItemProduct}
        initialLiked={getUsedItemInitialLiked?.(usedItemProduct) || false}
        onLikeChange={onUsedItemLikeChange}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#000' },
  header: { position: 'absolute', left: s(3), right: s(3), top: s(2.2), paddingTop: 0 },
  glass: {
    height: 46, borderRadius: 18, paddingHorizontal: 12, alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.6)', borderWidth: hairline, borderColor: 'rgba(0,0,0,0.06)',
  },
  rightIcons: { flexDirection: 'row', alignItems: 'center' },
  btn: { height: 34, width: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  bottomArea: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 40 },
  saveBtn: {
    backgroundColor: colors.text,
    paddingHorizontal: 28,
    paddingVertical: 12,
    minWidth: 240,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
  },
  saveTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
  uploadBtn: {
    marginTop: s(1.6),
    backgroundColor: '#fff',
    paddingHorizontal: 28,
    paddingVertical: 11,
    minWidth: 240,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: hairline,
    borderColor: 'rgba(0,0,0,0.12)',
  },
  uploadTxt: { color: '#000', fontWeight: '800', fontSize: 14 },
  usedItemsBtn: {
    marginTop: s(1.2),
    minWidth: 244,
    borderRadius: 18,
    borderWidth: hairline,
    borderColor: 'rgba(255,255,255,0.54)',
    backgroundColor: 'rgba(255,255,255,0.94)',
    paddingHorizontal: 12,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 5 },
  },
  usedItemsBtnPressed: {
    opacity: 0.94,
  },
  usedItemsIconBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: hairline,
    borderColor: 'rgba(0,0,0,0.12)',
    backgroundColor: 'rgba(255,255,255,0.88)',
  },
  usedItemsCopy: {
    flex: 1,
    marginLeft: 10,
  },
  usedItemsTxt: { color: colors.text, fontWeight: '800', fontSize: 13.2 },
  usedItemsHint: { marginTop: 1, color: colors.textDim, fontWeight: '600', fontSize: 11.2 },
  usedItemsChevron: {
    marginLeft: 8,
  },
  usedItemsBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.42)',
    justifyContent: 'flex-end',
  },
  usedItemsSheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: hairline,
    borderColor: 'rgba(0,0,0,0.08)',
    backgroundColor: 'rgba(255,255,255,0.97)',
    maxHeight: '72%',
    paddingTop: s(1.4),
    paddingHorizontal: s(2.1),
    paddingBottom: s(2.4),
  },
  usedItemsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: s(1.1),
  },
  usedItemsHeaderTitle: { color: colors.text, fontWeight: '800', fontSize: 16 },
  usedItemsCloseBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: hairline,
    borderColor: 'rgba(0,0,0,0.12)',
    backgroundColor: 'rgba(255,255,255,0.88)',
  },
  usedItemsScroll: {
    paddingBottom: s(2.2),
    gap: s(1),
  },
  usedItemsEmpty: {
    borderRadius: 12,
    borderWidth: hairline,
    borderColor: 'rgba(0,0,0,0.1)',
    backgroundColor: '#fff',
    paddingHorizontal: s(1.5),
    paddingVertical: s(1.4),
    alignItems: 'center',
  },
  usedItemsEmptyTitle: {
    marginTop: s(0.6),
    color: colors.text,
    fontSize: 12.8,
    fontWeight: '800',
  },
  usedItemsEmptyBody: {
    marginTop: s(0.35),
    color: colors.textDim,
    fontSize: 11.2,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 16,
  },
  usedItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: s(1.2),
    borderRadius: 12,
    borderWidth: hairline,
    borderColor: 'rgba(0,0,0,0.1)',
    backgroundColor: '#fff',
    padding: s(1),
  },
  usedItemRowPressed: {
    opacity: 0.9,
  },
  usedItemImage: {
    width: 56,
    height: 56,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  usedItemImageFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  usedItemTitle: {
    color: colors.text,
    fontWeight: '800',
    fontSize: 13,
  },
  usedItemMeta: {
    marginTop: 2,
    color: colors.textDim,
    fontSize: 11.5,
    fontWeight: '600',
  },
});
