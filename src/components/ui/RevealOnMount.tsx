import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleProp,
  ViewStyle,
} from 'react-native';

type Props = {
  children?: React.ReactNode;
  delay?: number;
  duration?: number;
  distance?: number;
  active?: boolean;
  style?: StyleProp<ViewStyle>;
};

export default function RevealOnMount({
  children,
  delay = 0,
  duration = 420,
  distance = 14,
  active = true,
  style,
}: Props) {
  const opacity = useRef(new Animated.Value(active ? 0 : 1)).current;
  const translateY = useRef(new Animated.Value(active ? distance : 0)).current;

  useEffect(() => {
    if (!active) return;
    opacity.setValue(0);
    translateY.setValue(distance);
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: duration + 50,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [active, delay, distance, duration, opacity, translateY]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity,
          transform: [{ translateY }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
