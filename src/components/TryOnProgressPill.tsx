import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Animated,
  Easing,
  Platform,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';

import {
  getTryOnProgress,
  subscribeTryOnProgress,
  emitTryOnProgressPress,
  TryOnProgressState,
} from '../data/tryOnProgress';

import { s, hairline } from '../theme/tokens';
import { pressFeedback } from '../theme/pressFeedback';

type Props = { goToTryOn: () => void };

/* ───────────────────── ArcChaseLoader (spinner that “chases itself”) ───────────────────── */
function ArcChaseLoader({
  active,
  size = 28,
  ring = true,
  style,
}: {
  active: boolean;
  size?: number;
  ring?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const spin = useRef(new Animated.Value(0)).current; // 0→1 rotation
  const fade = useRef(new Animated.Value(0)).current; // opacity

  const THICK = Math.max(2, Math.round(size * 0.12));

  useEffect(() => {
    let mounted = true;
    const loop = () => {
      if (!mounted) return;
      spin.setValue(0);
      Animated.timing(spin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }).start(({ finished }) => finished && mounted && loop());
    };

    if (active) {
      Animated.timing(fade, {
        toValue: 1,
        duration: 160,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      loop();
    } else {
      Animated.timing(fade, {
        toValue: 0,
        duration: 140,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }).start();
    }

    return () => {
      mounted = false;
      spin.stopAnimation();
      fade.stopAnimation();
    };
  }, [active, fade, spin]);

  const angle = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Animated.View style={[{ opacity: fade }, style]} pointerEvents="none">
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        {ring && (
          <View
            style={{
              position: 'absolute',
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: hairline,
              borderColor: 'rgba(255,255,255,0.18)',
            }}
          />
        )}

        {/* Rotating group */}
        <Animated.View
          style={{
            position: 'absolute',
            width: size,
            height: size,
            transform: [{ rotate: angle }],
          }}
        >
          {/* HEAD segment (bright) */}
          <View
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: THICK,
              borderTopColor: '#FFFFFF',
              borderRightColor: 'transparent',
              borderBottomColor: 'transparent',
              borderLeftColor: 'transparent',
            }}
          />

          {/* TAIL segment (softer), slightly behind the head */}
          <View
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: Math.max(1, THICK - 1),
              borderTopColor: 'rgba(255,255,255,0.45)',
              borderRightColor: 'transparent',
              borderBottomColor: 'transparent',
              borderLeftColor: 'transparent',
              transform: [{ rotate: '-35deg' }],
            }}
          />
        </Animated.View>
      </View>
    </Animated.View>
  );
}

/* ───────────────────── Right-side status (loader ⇄ check) ───────────────────── */
function RightStatus({
  isProcessing,
  isReady,
}: {
  isProcessing: boolean;
  isReady: boolean;
}) {
  const checkOpacity = useRef(new Animated.Value(isReady ? 1 : 0)).current;
  const checkScale = useRef(new Animated.Value(isReady ? 1 : 0.85)).current;

  useEffect(() => {
    if (isReady) {
      Animated.parallel([
        Animated.timing(checkOpacity, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(checkScale, {
          toValue: 1,
          stiffness: 240,
          damping: 18,
          mass: 0.6,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(checkOpacity, {
          toValue: 0,
          duration: 120,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(checkScale, {
          toValue: 0.85,
          duration: 120,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [isReady, checkOpacity, checkScale]);

  return (
    <View style={styles.right}>
      <ArcChaseLoader active={isProcessing} size={12} />

      <Animated.View
        pointerEvents="none"
        style={[
          styles.checkWrap,
          {
            opacity: checkOpacity,
            transform: [{ scale: checkScale }],
          },
        ]}
      >
        <Ionicons name="checkmark-circle-outline" size={14} color="#fff" />
      </Animated.View>

      {!isProcessing && !isReady && (
        <Ionicons name="sync-outline" size={12} color="#fff" />
      )}
    </View>
  );
}

/* ───────────────────── Main Pill ───────────────────── */
export default function TryOnProgressPill({ goToTryOn }: Props) {
  const [progress, setProgress] = useState<TryOnProgressState>(() => {
    try {
      return getTryOnProgress();
    } catch {
      return {
        visible: false,
        status: 'idle',
        modelName: null,
        modelUri: null,
        navigateToRoute: 'TryOn',
        totalSteps: 0,
        completedSteps: 0,
      } as TryOnProgressState;
    }
  });

  useEffect(() => subscribeTryOnProgress(setProgress), []);

  // Entrance animation
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (progress.visible) {
      appear.setValue(0);
      Animated.timing(appear, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [progress.visible, appear]);

  // left logo is static three-stars; no rotation animation

  // Derived UI
  const isProcessing = progress.status === 'generating';
  const computedReady = (progress.totalSteps > 0 && progress.completedSteps >= progress.totalSteps);
  const isReady = progress.status === 'ready' || (computedReady && !isProcessing);

  const stepSuffix =
    isProcessing && progress.totalSteps > 1
      ? ` ${Math.min(progress.completedSteps, progress.totalSteps)}/${progress.totalSteps}`
      : '';

  const title = isProcessing ? `Processing${stepSuffix}` : isReady ? 'Done' : 'Ready';
  const subtitle = useMemo(() => (isReady ? 'Tap to view' : null), [isReady]);

  const onPress = () => {
    goToTryOn?.();
    emitTryOnProgressPress();
  };

  if (!progress.visible) return null;

  return (
    <Animated.View
      style={[
        styles.wrap,
        {
          marginTop: s(8),
          opacity: appear,
          transform: [
            { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [8, 2] }) },
            { scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] }) },
          ],
        },
      ]}
      pointerEvents="box-none"
    >
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.press, pressFeedback(pressed)]}
        android_ripple={{ color: 'rgba(255,255,255,0.06)', borderless: false }}
      >
        {/* Glassmorphic black card */}
        <View style={styles.card}>
          <BlurView intensity={32} tint="dark" style={StyleSheet.absoluteFillObject} />
          <LinearGradient
            colors={['rgba(30,30,32,0.75)', 'rgba(12,12,14,0.75)']}
            start={{ x: 0.1, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFillObject}
          />
          {/* Static top highlight (kept) */}
          <LinearGradient
            colors={['rgba(255,255,255,0.14)', 'rgba(255,255,255,0.02)', 'rgba(255,255,255,0)']}
            start={{ x: 0.2, y: 0 }}
            end={{ x: 0.8, y: 0.5 }}
            style={styles.highlight}
          />
          <View style={styles.stroke} />

          {/* Left: static three-star motif */}
          <View style={styles.logoRing}>
            <View style={styles.logoInner} pointerEvents="none">
              <Ionicons name="sparkles-outline" size={LOGO} color="#fff" />
            </View>
          </View>

          {/* Texts */}
          <View style={styles.texts}>
            <Text style={styles.title}>{title}</Text>
            {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
          </View>

          {/* Right: arc-chasing loader → checkmark pop → idle sync */}
          <RightStatus isProcessing={isProcessing} isReady={isReady} />
        </View>
      </Pressable>
    </Animated.View>
  );
}

const LOGO = 12;
const R = 10;

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch', paddingHorizontal: s(6) },
  press: { borderRadius: R, overflow: 'hidden' },

  card: {
    minHeight: 24,
    borderRadius: R,
    overflow: 'hidden',
    paddingHorizontal: s(10),
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(10,10,12,0.55)',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.22,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 10 },
      },
      android: { elevation: 8 },
    }),
  },

  stroke: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: R,
    borderWidth: hairline,
    borderColor: 'rgba(255,255,255,0.12)',
  },

  highlight: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 12,
    opacity: 0.32,
  },

  // Left logo chip
  logoRing: {
    width: LOGO + 6,
    height: LOGO + 6,
    borderRadius: (LOGO + 6) / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: hairline,
    borderColor: 'rgba(255,255,255,0.18)',
    marginRight: s(6),
  },

  logoInner: {
    width: LOGO,
    height: LOGO,
    borderRadius: LOGO / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: hairline,
    borderColor: 'rgba(255,255,255,0.22)',
  },

  texts: { flex: 1, paddingVertical: s(4) },
  title: { color: '#fff', fontWeight: '800', fontSize: 12, letterSpacing: 0.2 },
  subtitle: { marginTop: 2, color: 'rgba(255,255,255,0.72)', fontSize: 10 },

  // Right container (space for loader / check)
  right: { marginLeft: s(6), width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  checkWrap: {
    position: 'absolute',
    left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
