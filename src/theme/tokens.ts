// src/theme/tokens.ts
// MODA-style design tokens: minimal, glass, hairlines, responsive

import { Dimensions, Platform, StyleSheet } from 'react-native';

const { width: W } = Dimensions.get('window');

/** Responsive spacing helper (baseline ~390pt) */
export const s = (n: number) => Math.round((W / 390) * n * 4);

/** Color palette */
export const colors = {
  bg: '#f7f7f9',
  bgDark: '#0b0b0e',

  text: '#0b0b0e',
  textOnDark: '#ffffff',
  textDim: 'rgba(11,11,14,0.55)',

  borderLight: 'rgba(0,0,0,0.08)',
  borderInner: 'rgba(255,255,255,0.16)',

  glassTint: 'rgba(255,255,255,0.6)',
  glassTintDark: 'rgba(255,255,255,0.08)',

  pillBg: 'rgba(255,255,255,0.65)',
  pillBgDark: 'rgba(255,255,255,0.12)',

  muted: '#6b7280',

  accent: '#0d6efd',
  accentDim: 'rgba(13,110,253,0.7)',

  success: '#2e7d32',
  warn: '#f9a825',
  danger: '#e53935',
};

/** Hairline stroke width */
export const hairline = StyleSheet.hairlineWidth ?? Platform.select({
  ios: 0.5,
  default: 1,
});

/** Radii scale */
export const radius = {
  card: 20,
  tile: 14,
  pill: 9999,
  capsule: 18,
  sm: 8,
  lg: 28,
};

/** Typography */
export const font = {
  h1: { fontSize: 28, fontWeight: Platform.OS === 'ios' ? '800' : '900', letterSpacing: 0.3, color: colors.text },
  h2: { fontSize: 20, fontWeight: '800', letterSpacing: 0.2, color: colors.text },
  h3: { fontSize: 16, fontWeight: '700', letterSpacing: 0.15, color: colors.text },
  p:  { fontSize: 14, fontWeight: '500', letterSpacing: 0.1, color: colors.text },
  meta:{ fontSize: 12, color: colors.muted, fontWeight: '600', letterSpacing: 0.1 },
} as const;
