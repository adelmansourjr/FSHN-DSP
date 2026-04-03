import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleProp,
  StyleSheet,
  ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../../theme/ThemeContext';

type Props = {
  visible?: boolean;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
};

export default function ShimmerPlaceholder({
  visible = true,
  borderRadius = 0,
  style,
}: Props) {
  const { isDark } = useTheme();
  const sweep = useRef(new Animated.Value(-1)).current;
  const pulse = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    if (!visible) return;
    sweep.setValue(-1);
    pulse.setValue(0.6);

    const sweepLoop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: 1150,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      })
    );

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.9,
          duration: 540,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.6,
          duration: 540,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    sweepLoop.start();
    pulseLoop.start();

    return () => {
      sweepLoop.stop();
      pulseLoop.stop();
    };
  }, [pulse, sweep, visible]);

  const shimmerTranslateX = useMemo(
    () =>
      sweep.interpolate({
        inputRange: [-1, 1],
        outputRange: [-220, 220],
      }),
    [sweep]
  );

  const baseColor = isDark
    ? 'rgba(255,255,255,0.09)'
    : 'rgba(11,11,14,0.08)';
  const shimmerColors: readonly [string, string, string] = isDark
    ? ['rgba(255,255,255,0)', 'rgba(255,255,255,0.22)', 'rgba(255,255,255,0)']
    : ['rgba(255,255,255,0)', 'rgba(255,255,255,0.82)', 'rgba(255,255,255,0)'];

  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFillObject,
        styles.base,
        {
          borderRadius,
          backgroundColor: baseColor,
          opacity: pulse,
        },
        style,
      ]}
    >
      <Animated.View
        style={[styles.sweep, { transform: [{ translateX: shimmerTranslateX }] }]}
      >
        <LinearGradient
          colors={shimmerColors}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    overflow: 'hidden',
  },
  sweep: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '52%',
  },
});
