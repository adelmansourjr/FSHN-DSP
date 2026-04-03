import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';
import { hairline, s } from '../theme/tokens';
import { useAppStatus, type AppStatusNotice } from '../context/AppStatusContext';

const toneIcon: Record<NonNullable<AppStatusNotice['tone']>, keyof typeof Ionicons.glyphMap> = {
  error: 'alert-circle',
  warning: 'cloud-offline',
  info: 'information-circle',
};

export default function AppStatusBanner() {
  const { notice, dismissNotice } = useAppStatus();
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const [renderedNotice, setRenderedNotice] = useState<AppStatusNotice | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;
  const bottomOffset = insets.bottom + s(12) + 64;

  useEffect(() => {
    if (!notice) {
      if (!renderedNotice) return;
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 180,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 14,
          duration: 200,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(() => setRenderedNotice(null));
      return;
    }

    setRenderedNotice(notice);
    opacity.setValue(0);
    translateY.setValue(20);
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [dismissNotice, notice, opacity, renderedNotice, translateY]);

  const gradientColors: readonly [string, string] = useMemo(() => {
    if (!renderedNotice) return ['rgba(11,11,14,0.65)', 'rgba(11,11,14,0.35)'];
    if (renderedNotice.tone === 'warning') {
      return ['rgba(249,168,37,0.30)', 'rgba(249,168,37,0.10)'];
    }
    if (renderedNotice.tone === 'info') {
      return ['rgba(13,110,253,0.28)', 'rgba(13,110,253,0.10)'];
    }
    return ['rgba(229,57,53,0.30)', 'rgba(229,57,53,0.10)'];
  }, [renderedNotice]);

  if (!renderedNotice) return null;

  return (
    <Modal transparent visible animationType="none" presentationStyle="overFullScreen" statusBarTranslucent onRequestClose={dismissNotice}>
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        <Animated.View
          pointerEvents="box-none"
          style={[
            styles.wrap,
            {
              bottom: bottomOffset,
              opacity,
              transform: [{ translateY }],
            },
          ]}
        >
          <Pressable onPress={dismissNotice} style={styles.cardShell}>
            <BlurView intensity={36} tint={isDark ? 'dark' : 'light'} style={styles.blur}>
              <LinearGradient
                colors={gradientColors}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={[StyleSheet.absoluteFill, styles.gradient]}
              />
              <View style={[styles.card, { borderColor: colors.borderLight }]}>
                <View style={[styles.iconWrap, { backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.7)' }]}>
                  <Ionicons name={toneIcon[renderedNotice.tone]} size={15} color={colors.text} />
                </View>
                <View style={styles.textWrap}>
                  <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
                    {renderedNotice.title}
                  </Text>
                  {!!renderedNotice.message && (
                    <Text numberOfLines={2} style={[styles.message, { color: colors.textDim }]}>
                      {renderedNotice.message}
                    </Text>
                  )}
                </View>
                <Pressable onPress={dismissNotice} hitSlop={8} style={styles.closeBtn}>
                  <Ionicons name="close" size={15} color={colors.textDim} />
                </Pressable>
              </View>
            </BlurView>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: s(3),
    right: s(3),
    zIndex: 250,
    alignItems: 'center',
  },
  cardShell: {
    borderRadius: 16,
    overflow: 'hidden',
    width: '100%',
    maxWidth: 520,
  },
  blur: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  gradient: {
    borderRadius: 16,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: s(2),
    paddingVertical: s(2),
    paddingHorizontal: s(2.3),
    borderWidth: hairline,
    borderRadius: 16,
  },
  iconWrap: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textWrap: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.15,
  },
  message: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 15,
  },
  closeBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
