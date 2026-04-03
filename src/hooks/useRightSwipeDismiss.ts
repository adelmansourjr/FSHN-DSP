import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, Dimensions, Easing, PanResponder } from 'react-native';

type Params = {
  visible: boolean;
  onDismiss: () => void;
  openDuration?: number;
  closeDuration?: number;
  fadeInDuration?: number;
  fadeOutDuration?: number;
  dismissDistanceRatio?: number;
  dismissVelocityX?: number;
  gestureStartDx?: number;
};

export function useRightSwipeDismiss({
  visible,
  onDismiss,
  openDuration = 280,
  closeDuration = 170,
  fadeInDuration = 220,
  fadeOutDuration = 120,
  dismissDistanceRatio = 0.28,
  dismissVelocityX = 0.8,
  gestureStartDx = 8,
}: Params) {
  const screenWidth = Dimensions.get('window').width;
  const translateX = useRef(new Animated.Value(screenWidth)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const isDragging = useRef(false);

  const resetToHidden = useCallback(() => {
    translateX.setValue(screenWidth);
    opacity.setValue(0);
  }, [opacity, screenWidth, translateX]);

  const closeWithSwipe = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateX, {
        toValue: screenWidth,
        duration: closeDuration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: fadeOutDuration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(() => {
      onDismiss();
      resetToHidden();
    });
  }, [closeDuration, fadeOutDuration, onDismiss, opacity, resetToHidden, screenWidth, translateX]);

  useEffect(() => {
    if (!visible) {
      resetToHidden();
      return;
    }
    Animated.parallel([
      Animated.timing(translateX, { toValue: 0, duration: openDuration, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: fadeInDuration, useNativeDriver: true }),
    ]).start();
  }, [fadeInDuration, openDuration, opacity, resetToHidden, translateX, visible]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          g.dx > gestureStartDx && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderGrant: () => {
          isDragging.current = true;
        },
        onPanResponderMove: (_, g) => {
          if (g.dx > 0) translateX.setValue(g.dx);
        },
        onPanResponderRelease: (_, g) => {
          isDragging.current = false;
          const shouldClose = g.dx > screenWidth * dismissDistanceRatio || g.vx > dismissVelocityX;
          if (shouldClose) {
            closeWithSwipe();
          } else {
            Animated.spring(translateX, { toValue: 0, bounciness: 0, useNativeDriver: true }).start();
          }
        },
        onPanResponderTerminate: () => {
          isDragging.current = false;
          Animated.spring(translateX, { toValue: 0, bounciness: 0, useNativeDriver: true }).start();
        },
      }),
    [closeWithSwipe, dismissDistanceRatio, dismissVelocityX, gestureStartDx, screenWidth, translateX]
  );

  const bgOpacity = translateX.interpolate({
    inputRange: [0, screenWidth * 0.6],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return {
    translateX,
    opacity,
    bgOpacity,
    panHandlers: panResponder.panHandlers,
    isDraggingRef: isDragging,
    closeWithSwipe,
  };
}

