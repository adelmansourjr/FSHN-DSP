import React, { useMemo } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Glass from '../components/Glass';
import MinimalHeader from '../components/MinimalHeader';
import { useTheme } from '../theme/ThemeContext';
import { font, hairline, s } from '../theme/tokens';
import { pressFeedback } from '../theme/pressFeedback';
import {
  BASIC_TERMS_POINTS,
  PRIVACY_POLICY_LAST_UPDATED,
  PRIVACY_POLICY_LINKS,
  PRIVACY_POLICY_POINTS,
} from '../lib/privacyPolicy';

const DOCK_BOTTOM_OFFSET = 28;
const DOCK_HEIGHT = 64;
const DOCK_CLEAR = DOCK_BOTTOM_OFFSET + DOCK_HEIGHT;

export type PrivacyPolicyScreenProps = {
  onClose?: () => void;
  dockAware?: boolean;
};

export default function PrivacyPolicyScreen({
  onClose,
  dockAware = false,
}: PrivacyPolicyScreenProps) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const bottomPad = insets.bottom + s(10) + (dockAware ? DOCK_CLEAR : 0);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: {
          flex: 1,
          backgroundColor: colors.bg,
        },
        content: {
          paddingHorizontal: s(3),
          paddingTop: s(2),
          paddingBottom: bottomPad,
          gap: s(3),
        },
        card: {
          padding: s(4),
          gap: s(2),
        },
        title: {
          ...font.h2,
          color: colors.text,
          marginBottom: 0,
        },
        subtitle: {
          ...font.meta,
          color: colors.textDim,
          lineHeight: 18,
        },
        sectionTitle: {
          ...font.h3,
          color: colors.text,
          fontWeight: '800',
        },
        bulletRow: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: s(1.6),
        },
        bulletDot: {
          width: 8,
          height: 8,
          borderRadius: 999,
          marginTop: 7,
          backgroundColor: colors.text,
          opacity: 0.86,
        },
        bulletCopy: {
          flex: 1,
          gap: s(0.6),
        },
        bulletTitle: {
          fontSize: 14,
          fontWeight: '800',
          color: colors.text,
        },
        bulletBody: {
          ...font.p,
          color: colors.textDim,
          lineHeight: 21,
        },
        referenceHint: {
          ...font.meta,
          color: colors.textDim,
          lineHeight: 18,
        },
        linkRow: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: s(2),
          borderRadius: 16,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.7)',
          paddingHorizontal: s(3),
          paddingVertical: s(2.2),
        },
        linkLabel: {
          flex: 1,
          fontSize: 13,
          fontWeight: '700',
          color: colors.text,
          lineHeight: 19,
        },
      }),
    [bottomPad, colors.bg, colors.borderLight, colors.text, colors.textDim, isDark]
  );

  const openLink = React.useCallback(async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      // Ignore open failures; the UI is still readable without leaving the app.
    }
  }, []);

  return (
    <View style={styles.root}>
      <MinimalHeader
        title="Privacy policy"
        onRightPress={onClose}
        rightIcon="close"
        rightA11yLabel="Close privacy policy"
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Glass style={styles.card} tint={isDark ? 'dark' : 'light'} intensity={isDark ? 32 : 22}>
          <Text style={styles.title}>Short version</Text>
          <Text style={styles.subtitle}>
            This policy is intentionally short, plain, and tied to what the app currently does.
            Last updated {PRIVACY_POLICY_LAST_UPDATED}.
          </Text>

          {PRIVACY_POLICY_POINTS.map((point) => (
            <View key={point.title} style={styles.bulletRow}>
              <View style={styles.bulletDot} />
              <View style={styles.bulletCopy}>
                <Text style={styles.bulletTitle}>{point.title}</Text>
                <Text style={styles.bulletBody}>{point.body}</Text>
              </View>
            </View>
          ))}
        </Glass>

        <Glass style={styles.card} tint={isDark ? 'dark' : 'light'} intensity={isDark ? 32 : 22}>
          <Text style={styles.sectionTitle}>Basic terms and conditions</Text>
          {BASIC_TERMS_POINTS.map((point) => (
            <View key={point.title} style={styles.bulletRow}>
              <View style={styles.bulletDot} />
              <View style={styles.bulletCopy}>
                <Text style={styles.bulletTitle}>{point.title}</Text>
                <Text style={styles.bulletBody}>{point.body}</Text>
              </View>
            </View>
          ))}
        </Glass>

        <Glass style={styles.card} tint={isDark ? 'dark' : 'light'} intensity={isDark ? 32 : 22}>
          <Text style={styles.sectionTitle}>UK references</Text>
          <Text style={styles.referenceHint}>
            These official links open in your browser and inform the policy wording above.
          </Text>
          {PRIVACY_POLICY_LINKS.map((link) => (
            <Pressable
              key={link.url}
              onPress={() => {
                void openLink(link.url);
              }}
              style={({ pressed }) => [styles.linkRow, pressFeedback(pressed, 'subtle')]}
            >
              <Text style={styles.linkLabel}>{link.label}</Text>
              <Ionicons name="open-outline" size={16} color={colors.textDim} />
            </Pressable>
          ))}
        </Glass>
      </ScrollView>
    </View>
  );
}
