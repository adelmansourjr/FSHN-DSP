import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNav } from '../navigation/NavContext';
import Glass from './Glass';
import { radius, s } from '../theme/tokens';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';
import { pressFeedback } from '../theme/pressFeedback';

export const HEADER_HEIGHT = 44;

type Props = {
  title?: string;
  onSearch?: () => void;

  /** Optional left action (e.g., back) */
  leftIcon?: keyof typeof Ionicons.glyphMap;
  onLeftPress?: () => void;
  leftA11yLabel?: string;

  /** Back-compat: onBell still works; you can override with onRightPress/rightIcon below */
  onBell?: () => void;

  /** New: customize right action (defaults to notifications-outline) */
  rightIcon?: keyof typeof Ionicons.glyphMap;
  onRightPress?: () => void;
  rightA11yLabel?: string;
  rightBadgeCount?: number;

  /** Optional secondary right action (e.g., settings) */
  rightTertiaryIcon?: keyof typeof Ionicons.glyphMap;
  rightTertiaryLabel?: string;
  onTertiaryPress?: () => void;
  rightTertiaryA11yLabel?: string;

  rightSecondaryIcon?: keyof typeof Ionicons.glyphMap;
  rightSecondaryLabel?: string;
  onSecondaryPress?: () => void;
  rightSecondaryA11yLabel?: string;
};

export default function MinimalHeader({
  title = 'FSHN',
  onSearch,
  leftIcon,
  onLeftPress,
  leftA11yLabel,
  onBell,
  rightIcon = 'bag-outline',
  onRightPress,
  rightA11yLabel,
  rightBadgeCount = 0,
  rightTertiaryIcon,
  rightTertiaryLabel,
  onTertiaryPress,
  rightTertiaryA11yLabel,
  rightSecondaryIcon,
  rightSecondaryLabel,
  onSecondaryPress,
  rightSecondaryA11yLabel,
}: Props) {
  const insets = useSafeAreaInsets();
  const nav = useNav();
  const { colors, isDark } = useTheme();

  // Default right action: use provided handler, fallback to navigation to `Basket` via NavContext.
  const handleRight = onRightPress ?? onBell ?? (() => nav.navigate({ name: 'basket' }));

  const styles = useMemo(
    () =>
      StyleSheet.create({
        capsule: {
          height: HEADER_HEIGHT,
          borderRadius: radius.capsule,
          paddingHorizontal: s(2),
          justifyContent: 'center',
          backgroundColor: isDark ? 'rgba(17,17,20,0.7)' : undefined,
        },
        row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
        left: { flexDirection: 'row', alignItems: 'center', gap: s(1) },
        title: { fontSize: 18, fontWeight: '800', letterSpacing: 0.2, color: colors.text },
        actions: { flexDirection: 'row', gap: s(1) },
        iconWrap: {
          position: 'relative',
        },
        iconBtn: {
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.55)',
          borderWidth: 1,
          borderColor: colors.borderLight,
        },
        labeledBtn: {
          flexDirection: 'row',
          width: 'auto',
          paddingHorizontal: s(2.2),
          gap: s(0.8),
        },
        labeledBtnText: {
          fontSize: 12,
          fontWeight: '800',
          letterSpacing: 0.15,
          color: colors.text,
        },
        badge: {
          position: 'absolute',
          right: -2,
          top: -2,
          minWidth: 16,
          height: 16,
          paddingHorizontal: 4,
          borderRadius: 8,
          backgroundColor: colors.danger,
          borderWidth: 1,
          borderColor: isDark ? 'rgba(11,11,14,0.7)' : '#fff',
          alignItems: 'center',
          justifyContent: 'center',
        },
        badgeTxt: {
          fontSize: 10,
          fontWeight: '900',
          color: '#fff',
          letterSpacing: 0.1,
        },
      }),
    [colors, isDark]
  );

  return (
    <View style={{ paddingTop: insets.top + s(2), paddingHorizontal: s(3) }}>
      <Glass style={styles.capsule}>
        <View style={styles.row}>
          <View style={styles.left}>
            {!!leftIcon && (
              <Pressable
                style={({ pressed }) => [styles.iconBtn, pressFeedback(pressed, 'subtle')]}
                onPress={onLeftPress}
                accessibilityRole="button"
                accessibilityLabel={leftA11yLabel || 'Back'}
              >
                <Ionicons name={leftIcon} size={18} color={colors.text} />
              </Pressable>
            )}
            <Text style={styles.title}>{title}</Text>
          </View>
          <View style={styles.actions}>
            {!!onSearch && (
              <Pressable
                style={({ pressed }) => [styles.iconBtn, pressFeedback(pressed, 'subtle')]}
                onPress={onSearch}
                accessibilityRole="button"
                accessibilityLabel="Search"
              >
                <Ionicons name="search" size={18} color={colors.text} />
              </Pressable>
            )}

            {!!rightTertiaryIcon && (
              <Pressable
                style={({ pressed }) => [
                  styles.iconBtn,
                  !!rightTertiaryLabel && styles.labeledBtn,
                  pressFeedback(pressed, 'subtle'),
                ]}
                onPress={onTertiaryPress}
                accessibilityRole="button"
                accessibilityLabel={rightTertiaryA11yLabel || 'Additional action'}
              >
                <Ionicons name={rightTertiaryIcon} size={18} color={colors.text} />
                {!!rightTertiaryLabel && (
                  <Text style={styles.labeledBtnText}>{rightTertiaryLabel}</Text>
                )}
              </Pressable>
            )}

            {!!rightSecondaryIcon && (
              <Pressable
                style={({ pressed }) => [
                  styles.iconBtn,
                  !!rightSecondaryLabel && styles.labeledBtn,
                  pressFeedback(pressed, 'subtle'),
                ]}
                onPress={onSecondaryPress}
                accessibilityRole="button"
                accessibilityLabel={rightSecondaryA11yLabel || 'Secondary action'}
              >
                <Ionicons name={rightSecondaryIcon} size={18} color={colors.text} />
                {!!rightSecondaryLabel && (
                  <Text style={styles.labeledBtnText}>{rightSecondaryLabel}</Text>
                )}
              </Pressable>
            )}

            <View style={styles.iconWrap}>
              <Pressable
                style={({ pressed }) => [styles.iconBtn, pressFeedback(pressed, 'subtle')]}
                onPress={handleRight}
                accessibilityRole="button"
                accessibilityLabel={rightA11yLabel || 'Basket'}
              >
                <Ionicons name={rightIcon} size={18} color={colors.text} />
              </Pressable>
              {rightBadgeCount > 0 ? (
                <View style={styles.badge} pointerEvents="none">
                  <Text style={styles.badgeTxt}>{rightBadgeCount > 9 ? '9+' : rightBadgeCount}</Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      </Glass>
    </View>
  );
}
