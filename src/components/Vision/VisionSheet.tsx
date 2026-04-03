import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Linking,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CameraView, type CameraType, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { hairline, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import {
  findVisionMatches,
  type VisionAppMatch,
  type VisionLookupResult,
  type VisionPoolItem,
  type VisionSlot,
  type VisionWebMatch,
} from './visionEngine';

const { width: W, height: H } = Dimensions.get('window');
const SNAP_FULL = Math.max(H * 0.12, 92);
const SNAP_HALF = Math.max(H * 0.44, SNAP_FULL + 72);
const SNAP_CLOSED = H;

type TabKey = 'app' | 'web';

type Props = {
  visible: boolean;
  onClose: () => void;
  pool: VisionPoolItem[];
  genderPref: 'any' | 'men' | 'women';
  onApplyItem?: (item: VisionPoolItem, slot: VisionSlot) => void;
};

function extractItemImage(item: VisionPoolItem) {
  const direct = String(item?.image || '').trim();
  if (direct) return direct;
  const images = Array.isArray((item as any)?.images) ? ((item as any).images as string[]) : [];
  return String(images[0] || '').trim();
}

export default function VisionSheet({
  visible,
  onClose,
  pool,
  genderPref,
  onApplyItem,
}: Props) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);
  const cameraRef = useRef<CameraView | null>(null);
  const translateY = useRef(new Animated.Value(SNAP_CLOSED)).current;
  const selectedImageOpacity = useRef(new Animated.Value(0)).current;
  const selectedImageScale = useRef(new Animated.Value(0.96)).current;
  const loadingOverlayOpacity = useRef(new Animated.Value(0)).current;
  const lastSnapRef = useRef<number>(SNAP_CLOSED);
  const dragStartRef = useRef<number>(SNAP_CLOSED);
  const openedAtRef = useRef<number>(0);
  const lastProcessedImageRef = useRef<string>('');

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VisionLookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('web');
  const [sheetVisible, setSheetVisible] = useState(false);

  const canUseCamera = cameraPermission?.granted === true;
  const hasImage = Boolean(imageUri);
  const isPreparingResults = busy && !sheetVisible;

  useEffect(() => {
    if (!visible) {
      translateY.setValue(SNAP_CLOSED);
      selectedImageOpacity.setValue(0);
      selectedImageScale.setValue(0.96);
      loadingOverlayOpacity.setValue(0);
      lastSnapRef.current = SNAP_CLOSED;
      setSheetVisible(false);
      setImageUri(null);
      setBusy(false);
      setResult(null);
      setError(null);
      setTab('web');
      lastProcessedImageRef.current = '';
      return;
    }
    openedAtRef.current = Date.now();
    if (!cameraPermission?.granted && cameraPermission?.canAskAgain !== false) {
      void requestCameraPermission();
    }
  }, [
    cameraPermission?.canAskAgain,
    cameraPermission?.granted,
    loadingOverlayOpacity,
    requestCameraPermission,
    selectedImageOpacity,
    selectedImageScale,
    translateY,
    visible,
  ]);

  useEffect(() => {
    if (!hasImage) {
      selectedImageOpacity.setValue(0);
      selectedImageScale.setValue(0.96);
      return;
    }
    selectedImageOpacity.setValue(0);
    selectedImageScale.setValue(0.96);
    Animated.parallel([
      Animated.timing(selectedImageOpacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.spring(selectedImageScale, {
        toValue: 1,
        damping: 18,
        stiffness: 240,
        mass: 1,
        useNativeDriver: true,
      }),
    ]).start();
  }, [hasImage, selectedImageOpacity, selectedImageScale]);

  useEffect(() => {
    loadingOverlayOpacity.stopAnimation();
    Animated.timing(loadingOverlayOpacity, {
      toValue: isPreparingResults ? 1 : 0,
      duration: isPreparingResults ? 140 : 200,
      useNativeDriver: true,
    }).start();
  }, [isPreparingResults, loadingOverlayOpacity]);

  const runVision = useCallback(
    async (uri: string) => {
      const normalized = String(uri || '').trim();
      if (!normalized) {
        Alert.alert('Add image first', 'Capture a photo or choose one from your library.');
        return false;
      }
      setBusy(true);
      setError(null);
      try {
        const next = await findVisionMatches({
          imageUri: normalized,
          pool,
          genderPref,
          includeWeb: true,
        });
        setResult(next);
        lastProcessedImageRef.current = normalized;
        if (next.appMatches.length && !next.webMatches.length) setTab('app');
        if (!next.appMatches.length && next.webMatches.length) setTab('web');
        return true;
      } catch (err: any) {
        setResult(null);
        setError(err?.message || 'Vision search failed.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [genderPref, pool]
  );

  const openSheet = useCallback(async () => {
    if (!hasImage || !imageUri) {
      Alert.alert('No image selected', 'Use the camera or Add Photo first.');
      return;
    }
    if (busy) return;
    if (lastProcessedImageRef.current !== imageUri || !result) {
      const ok = await runVision(imageUri);
      if (!ok) return;
    }
    setSheetVisible(true);
  }, [busy, hasImage, imageUri, result, runVision]);

  const snapTo = useCallback(
    (point: number, velocity = 0) => {
      lastSnapRef.current = point;
      translateY.stopAnimation();
      Animated.spring(translateY, {
        toValue: point,
        velocity,
        damping: 22,
        stiffness: 260,
        mass: 1,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished) return;
        if (point === SNAP_CLOSED) {
          setSheetVisible(false);
        }
      });
    },
    [translateY]
  );

  useEffect(() => {
    if (!sheetVisible) {
      translateY.setValue(SNAP_CLOSED);
      lastSnapRef.current = SNAP_CLOSED;
      return;
    }
    translateY.setValue(SNAP_CLOSED);
    requestAnimationFrame(() => snapTo(SNAP_HALF));
  }, [sheetVisible, snapTo, translateY]);

  const closeSheet = useCallback(() => {
    snapTo(SNAP_CLOSED);
  }, [snapTo]);

  const closeVision = useCallback(() => {
    if (sheetVisible) {
      closeSheet();
      setTimeout(onClose, 120);
      return;
    }
    onClose();
  }, [closeSheet, onClose, sheetVisible]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponderCapture: (_evt, gesture) => Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onMoveShouldSetPanResponder: (_evt, gesture) => Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderGrant: () => {
        dragStartRef.current = lastSnapRef.current;
      },
      onPanResponderMove: (_evt, gesture) => {
        const next = Math.max(SNAP_FULL, Math.min(SNAP_CLOSED, dragStartRef.current + gesture.dy));
        translateY.setValue(next);
      },
      onPanResponderRelease: (_evt, gesture) => {
        const next = Math.max(SNAP_FULL, Math.min(SNAP_CLOSED, dragStartRef.current + gesture.dy));
        if (gesture.vy > 1.2) {
          snapTo(SNAP_CLOSED, gesture.vy);
          return;
        }
        if (gesture.vy < -1.2) {
          snapTo(SNAP_FULL, gesture.vy);
          return;
        }
        const midToFull = (SNAP_HALF + SNAP_FULL) / 2;
        const midToClosed = (SNAP_HALF + SNAP_CLOSED) / 2;
        if (next < midToFull) snapTo(SNAP_FULL);
        else if (next < midToClosed) snapTo(SNAP_HALF);
        else snapTo(SNAP_CLOSED);
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderTerminate: () => undefined,
    })
  ).current;

  const overlayOpacity = translateY.interpolate({
    inputRange: [SNAP_FULL, SNAP_CLOSED],
    outputRange: [0.5, 0],
    extrapolate: 'clamp',
  });

  const pickFromLibrary = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photos required', 'Enable photos access to choose a garment image.');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.92,
      allowsEditing: false,
    });
    if (picked.canceled || !picked.assets?.[0]?.uri) return;
    setImageUri(picked.assets[0].uri);
    setError(null);
  }, []);

  const capture = useCallback(async () => {
    if (!canUseCamera) {
      Alert.alert('Camera unavailable', 'Allow camera access or use Add Photo.');
      return;
    }
    if (busy) return;
    try {
      const snap = await cameraRef.current?.takePictureAsync({
        quality: 0.92,
        skipProcessing: false,
      });
      const uri = snap?.uri ? String(snap.uri).trim() : '';
      if (!uri) return;
      setImageUri(uri);
      setError(null);
    } catch (err: any) {
      Alert.alert('Capture failed', err?.message || 'Could not capture photo.');
    }
  }, [busy, canUseCamera]);

  const openWebUrl = useCallback(async (url: string) => {
    try {
      const ok = await Linking.canOpenURL(url);
      if (!ok) throw new Error('Cannot open URL');
      await Linking.openURL(url);
    } catch {
      Alert.alert('Unable to open', 'This web result could not be opened.');
    }
  }, []);

  const onPressAppMatch = useCallback(
    (match: VisionAppMatch) => {
      if (!onApplyItem) return;
      onApplyItem(match.item, match.slot);
    },
    [onApplyItem]
  );

  const webResults = result?.webMatches || [];
  const appResults = result?.appMatches || [];
  const activeResults = tab === 'app' ? appResults : webResults;

  const renderGridCard = useCallback(
    (entry: VisionAppMatch | VisionWebMatch, index: number) => {
      const isApp = tab === 'app';
      const key = isApp
        ? `${(entry as VisionAppMatch).item.id}-${index}`
        : `${(entry as VisionWebMatch).pageUrl}-${index}`;
      const image = isApp
        ? extractItemImage((entry as VisionAppMatch).item)
        : String((entry as VisionWebMatch).thumbnailUrl || (entry as VisionWebMatch).imageUrl || '').trim();
      const title = isApp
        ? (entry as VisionAppMatch).item.title
        : (entry as VisionWebMatch).title;
      const subtitle = isApp
        ? ((entry as VisionAppMatch).slot !== 'unknown'
          ? `${(entry as VisionAppMatch).slot} • ${(entry as VisionAppMatch).score.toFixed(1)}`
          : `score ${(entry as VisionAppMatch).score.toFixed(1)}`)
        : (entry as VisionWebMatch).source;

      return (
        <Pressable
          key={key}
          style={({ pressed }) => [styles.gridCard, pressed && styles.gridCardPressed]}
          onPress={() => {
            if (isApp) onPressAppMatch(entry as VisionAppMatch);
            else void openWebUrl((entry as VisionWebMatch).pageUrl);
          }}
        >
          {!!image ? (
            <ExpoImage source={{ uri: image }} style={styles.gridImage} contentFit="cover" transition={120} />
          ) : (
            <View style={[styles.gridImage, styles.gridImageEmpty]}>
              <Ionicons name="image-outline" size={18} color={colors.muted} />
            </View>
          )}
          <View style={styles.gridMeta}>
            <Text numberOfLines={1} style={styles.gridTitle}>{title}</Text>
            <Text numberOfLines={1} style={styles.gridSubtitle}>{subtitle}</Text>
          </View>
        </Pressable>
      );
    },
    [colors.muted, onPressAppMatch, openWebUrl, styles.gridCard, styles.gridCardPressed, styles.gridImage, styles.gridImageEmpty, styles.gridMeta, styles.gridSubtitle, styles.gridTitle, tab]
  );

  const noResultsText = tab === 'app'
    ? 'No app matches yet. Try another photo angle.'
    : 'No web matches yet. Try a clearer garment shot.';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={closeVision}
      presentationStyle="fullScreen"
      statusBarTranslucent
    >
      <View style={styles.root}>
        <View style={StyleSheet.absoluteFill}>
          {canUseCamera ? (
            <CameraView
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              facing={facing}
            />
          ) : (
            <View style={styles.cameraFallback}>
              <Ionicons name="camera-outline" size={38} color={colors.muted} />
              <Text style={styles.cameraFallbackTitle}>Camera access is off</Text>
              <Text style={styles.cameraFallbackBody}>
                Allow camera to capture a garment, or tap Add Photo.
              </Text>
            </View>
          )}
        </View>

        <View pointerEvents="none" style={styles.topFade} />
        <View pointerEvents="none" style={styles.bottomFade} />

        <View style={[styles.topBar, { paddingTop: insets.top + s(1.2) }]}>
          <Pressable onPress={closeVision} style={styles.topButton}>
            <Ionicons name="close" size={20} color="#fff" />
          </Pressable>
          <View style={styles.topTitleWrap}>
            <Text style={styles.topTitle}>Vision Finder</Text>
          </View>
          <Pressable
            onPress={() => setFacing((prev) => (prev === 'back' ? 'front' : 'back'))}
            style={styles.topButton}
          >
            <Ionicons name="camera-reverse-outline" size={19} color="#fff" />
          </Pressable>
        </View>

        {!!imageUri && (
          <View
            pointerEvents="box-none"
            style={[
              styles.centerPreviewStage,
              {
                paddingTop: insets.top + s(10),
                paddingBottom: insets.bottom + s(18),
              },
            ]}
          >
            <Animated.View
              style={[
                styles.centerPreviewCard,
                {
                  opacity: selectedImageOpacity,
                  transform: [{ scale: selectedImageScale }],
                },
              ]}
            >
              <ExpoImage source={{ uri: imageUri }} style={styles.centerPreviewImage} contentFit="cover" transition={150} />
              <View style={styles.centerPreviewMeta}>
                <Text style={styles.centerPreviewLabel}>Selected image</Text>
                <View style={styles.centerPreviewActionsRow}>
                  <Pressable
                    onPress={capture}
                    disabled={busy}
                    style={({ pressed }) => [
                      styles.centerPreviewAction,
                      busy && styles.centerPreviewActionDisabled,
                      pressed && !busy && styles.centerPreviewActionPressed,
                    ]}
                  >
                    <Ionicons name="camera-outline" size={14} color="#fff" />
                    <Text style={styles.centerPreviewActionText}>Retake</Text>
                  </Pressable>
                  <Pressable
                    onPress={pickFromLibrary}
                    disabled={busy}
                    style={({ pressed }) => [
                      styles.centerPreviewAction,
                      busy && styles.centerPreviewActionDisabled,
                      pressed && !busy && styles.centerPreviewActionPressed,
                    ]}
                  >
                    <Ionicons name="images-outline" size={14} color="#fff" />
                    <Text style={styles.centerPreviewActionText}>Choose Another</Text>
                  </Pressable>
                </View>
              </View>
              {busy && (
                <View style={styles.centerPreviewBusy}>
                  <ActivityIndicator size="small" color="#fff" />
                </View>
              )}
            </Animated.View>
          </View>
        )}

        <Animated.View
          pointerEvents={isPreparingResults ? 'auto' : 'none'}
          style={[styles.loadingOverlay, { opacity: loadingOverlayOpacity }]}
        >
          <View style={styles.loadingCard}>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={styles.loadingTitle}>Finding similar items</Text>
            <Text style={styles.loadingBody}>Opening results when everything is ready.</Text>
          </View>
        </Animated.View>

        <View style={[styles.cameraControls, { paddingBottom: insets.bottom + s(2.8) }]}>
          <Pressable onPress={pickFromLibrary} style={styles.sideAction}>
            <Ionicons name="images-outline" size={16} color="#fff" />
            <Text style={styles.sideActionText}>Add Photo</Text>
          </Pressable>

          <Pressable
            onPress={capture}
            disabled={busy}
            style={({ pressed }) => [styles.shutterBtn, busy && styles.shutterBtnDisabled, pressed && { transform: [{ scale: 0.96 }] }]}
          >
            <View style={styles.shutterInner} />
          </Pressable>

          <Pressable
            onPress={() => {
              void openSheet();
            }}
            disabled={!hasImage || busy}
            style={({ pressed }) => [
              styles.sideAction,
              (!hasImage || busy) && styles.sideActionDisabled,
              pressed && hasImage && !busy && { transform: [{ scale: 0.98 }] },
            ]}
          >
            {busy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="sparkles-outline" size={16} color="#fff" />}
            <Text style={styles.sideActionText}>{busy ? 'Loading...' : 'Results'}</Text>
          </Pressable>
        </View>

        {!!sheetVisible && (
          <>
            <Animated.View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(8,8,10,0.72)', opacity: overlayOpacity }]}
            />
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => {
                if (Date.now() - openedAtRef.current < 250) return;
                closeSheet();
              }}
            />

            <Animated.View
              style={[styles.sheet, { transform: [{ translateY }] }]}
            >
              <View style={styles.sheetChrome}>
                <View style={styles.handleZone} {...panResponder.panHandlers}>
                  <View style={styles.handleBar} />
                </View>

                <View style={styles.sheetHeader}>
                  <Text style={styles.sheetTitle}>Vision Results</Text>
                  <Text style={styles.sheetCount}>{activeResults.length}</Text>
                </View>

                <View style={styles.tabsRow}>
                  <Pressable
                    onPress={() => setTab('web')}
                    style={[styles.tabBtn, tab === 'web' && styles.tabBtnActive]}
                  >
                    <Text style={[styles.tabBtnTxt, tab === 'web' && styles.tabBtnTxtActive]}>Web</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setTab('app')}
                    style={[styles.tabBtn, tab === 'app' && styles.tabBtnActive]}
                  >
                    <Text style={[styles.tabBtnTxt, tab === 'app' && styles.tabBtnTxtActive]}>App</Text>
                  </Pressable>
                </View>

                {!!error && <Text style={styles.errorText}>{error}</Text>}

                <ScrollView
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.sheetScrollContent}
                >
                  <View style={styles.grid}>
                    {activeResults.map((entry, index) => renderGridCard(entry as any, index))}
                  </View>

                  {!busy && activeResults.length === 0 && (
                    <View style={styles.emptyState}>
                      <Text style={styles.emptyTitle}>No results</Text>
                      <Text style={styles.emptyBody}>{noResultsText}</Text>
                    </View>
                  )}

                  {!!result?.warnings?.length && (
                    <Text style={styles.warnText}>{result.warnings.join('\n')}</Text>
                  )}
                </ScrollView>
              </View>
            </Animated.View>
          </>
        )}
      </View>
    </Modal>
  );
}

const makeStyles = (colors: any, isDark: boolean) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: '#090909',
    },
    cameraFallback: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: s(9),
      backgroundColor: '#151618',
    },
    cameraFallbackTitle: {
      marginTop: s(1.4),
      color: '#fff',
      fontSize: 16,
      fontWeight: '800',
      letterSpacing: 0.2,
    },
    cameraFallbackBody: {
      marginTop: s(0.8),
      color: 'rgba(255,255,255,0.78)',
      textAlign: 'center',
      fontSize: 13,
      lineHeight: 18,
    },
    topFade: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 180,
      backgroundColor: 'rgba(0,0,0,0.36)',
    },
    bottomFade: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: 220,
      backgroundColor: 'rgba(0,0,0,0.46)',
    },
    topBar: {
      position: 'absolute',
      left: 0,
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: s(2.6),
      zIndex: 10,
    },
    topButton: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.34)',
      borderWidth: hairline,
      borderColor: 'rgba(255,255,255,0.25)',
    },
    topTitleWrap: {
      paddingHorizontal: s(2),
      paddingVertical: s(0.9),
      borderRadius: 999,
      backgroundColor: 'rgba(0,0,0,0.34)',
      borderWidth: hairline,
      borderColor: 'rgba(255,255,255,0.25)',
    },
    topTitle: {
      fontSize: 13,
      fontWeight: '800',
      color: '#fff',
      letterSpacing: 0.25,
    },
    centerPreviewStage: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: s(3),
      zIndex: 9,
    },
    centerPreviewCard: {
      width: Math.min(W * 0.62, 280),
      borderRadius: s(3),
      overflow: 'hidden',
      borderWidth: hairline,
      borderColor: 'rgba(255,255,255,0.36)',
      backgroundColor: 'rgba(0,0,0,0.45)',
      shadowColor: '#000',
      shadowOpacity: 0.26,
      shadowOffset: { width: 0, height: 8 },
      shadowRadius: 18,
      elevation: 8,
    },
    centerPreviewImage: {
      width: '100%',
      aspectRatio: 1,
      backgroundColor: 'rgba(255,255,255,0.08)',
    },
    centerPreviewMeta: {
      paddingHorizontal: s(1.4),
      paddingTop: s(1.1),
      paddingBottom: s(1.3),
      gap: s(1),
    },
    centerPreviewLabel: {
      color: '#fff',
      fontSize: 12.4,
      fontWeight: '800',
      letterSpacing: 0.2,
      textAlign: 'center',
    },
    centerPreviewActionsRow: {
      flexDirection: 'row',
      gap: s(0.8),
    },
    centerPreviewAction: {
      flex: 1,
      height: 34,
      borderRadius: 999,
      borderWidth: hairline,
      borderColor: 'rgba(255,255,255,0.36)',
      backgroundColor: 'rgba(255,255,255,0.1)',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: s(0.55),
    },
    centerPreviewActionPressed: {
      opacity: 0.9,
    },
    centerPreviewActionDisabled: {
      opacity: 0.55,
    },
    centerPreviewActionText: {
      color: '#fff',
      fontSize: 11.2,
      fontWeight: '700',
      letterSpacing: 0.1,
    },
    centerPreviewBusy: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.36)',
    },
    loadingOverlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(2,3,5,0.5)',
      zIndex: 20,
    },
    loadingCard: {
      minWidth: 220,
      borderRadius: s(2.6),
      borderWidth: hairline,
      borderColor: 'rgba(255,255,255,0.28)',
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: s(2.1),
      paddingVertical: s(1.7),
    },
    loadingTitle: {
      marginTop: s(0.8),
      color: '#fff',
      fontSize: 13,
      fontWeight: '800',
      letterSpacing: 0.15,
    },
    loadingBody: {
      marginTop: s(0.55),
      color: 'rgba(255,255,255,0.84)',
      fontSize: 11.4,
      textAlign: 'center',
      lineHeight: 16,
    },
    cameraControls: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: s(2.6),
      zIndex: 11,
    },
    sideAction: {
      height: 44,
      minWidth: 102,
      paddingHorizontal: s(1.8),
      borderRadius: 999,
      borderWidth: hairline,
      borderColor: 'rgba(255,255,255,0.35)',
      backgroundColor: 'rgba(0,0,0,0.42)',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: s(0.8),
    },
    sideActionDisabled: {
      opacity: 0.45,
    },
    sideActionText: {
      color: '#fff',
      fontWeight: '700',
      fontSize: 12.3,
      letterSpacing: 0.15,
    },
    shutterBtn: {
      width: 78,
      height: 78,
      borderRadius: 999,
      borderWidth: 3,
      borderColor: '#fff',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.09)',
    },
    shutterBtnDisabled: {
      opacity: 0.55,
    },
    shutterInner: {
      width: 61,
      height: 61,
      borderRadius: 999,
      backgroundColor: '#fff',
    },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: H,
      zIndex: 30,
    },
    sheetChrome: {
      flex: 1,
      borderTopLeftRadius: s(6),
      borderTopRightRadius: s(6),
      borderWidth: hairline,
      borderColor: colors.borderLight,
      overflow: 'hidden',
      backgroundColor: isDark ? 'rgba(15,15,18,0.94)' : 'rgba(255,255,255,0.94)',
    },
    handleZone: {
      alignItems: 'center',
      paddingTop: s(2),
      paddingBottom: s(1.2),
    },
    handleBar: {
      width: 46,
      height: 5,
      borderRadius: 999,
      backgroundColor: isDark ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.18)',
    },
    sheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: s(3),
      marginBottom: s(1.2),
    },
    sheetTitle: {
      fontSize: 17,
      fontWeight: '800',
      color: colors.text,
      letterSpacing: 0.2,
    },
    sheetCount: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.muted,
    },
    tabsRow: {
      flexDirection: 'row',
      gap: s(1),
      paddingHorizontal: s(3),
      marginBottom: s(1.8),
    },
    tabBtn: {
      borderRadius: 999,
      borderWidth: hairline,
      borderColor: colors.borderLight,
      backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.75)',
      paddingVertical: s(0.9),
      paddingHorizontal: s(2.2),
    },
    tabBtnActive: {
      backgroundColor: colors.text,
      borderColor: colors.text,
    },
    tabBtnTxt: {
      color: colors.text,
      fontWeight: '700',
      fontSize: 12.2,
      letterSpacing: 0.15,
    },
    tabBtnTxtActive: {
      color: isDark ? '#111' : '#fff',
    },
    errorText: {
      marginHorizontal: s(3),
      marginBottom: s(1.2),
      color: '#ef4444',
      fontSize: 12,
    },
    sheetScrollContent: {
      paddingHorizontal: s(3),
      paddingBottom: s(8),
    },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      rowGap: s(1.2),
      columnGap: s(1.2),
    },
    gridCard: {
      width: '48.4%',
      borderRadius: s(2.6),
      overflow: 'hidden',
      borderWidth: hairline,
      borderColor: colors.borderLight,
      backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.75)',
    },
    gridCardPressed: {
      opacity: 0.86,
    },
    gridImage: {
      width: '100%',
      aspectRatio: 1,
      backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)',
    },
    gridImageEmpty: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    gridMeta: {
      paddingHorizontal: s(1.2),
      paddingVertical: s(1),
    },
    gridTitle: {
      color: colors.text,
      fontSize: 12.1,
      fontWeight: '700',
    },
    gridSubtitle: {
      marginTop: 2,
      color: colors.muted,
      fontSize: 11,
      fontWeight: '600',
    },
    emptyState: {
      marginTop: s(2),
      borderRadius: s(2.6),
      borderWidth: hairline,
      borderColor: colors.borderLight,
      backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.75)',
      paddingHorizontal: s(2),
      paddingVertical: s(1.6),
    },
    emptyTitle: {
      color: colors.text,
      fontSize: 12.4,
      fontWeight: '700',
      marginBottom: s(0.4),
    },
    emptyBody: {
      color: colors.muted,
      fontSize: 11.4,
      lineHeight: 17,
    },
    warnText: {
      marginTop: s(1.8),
      color: '#b45309',
      fontSize: 11.5,
      lineHeight: 16,
    },
  });
