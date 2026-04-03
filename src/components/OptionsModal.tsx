import React, { useState, useEffect } from 'react';
import { Modal, View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { font, radius, s } from '../theme/tokens';
import { BlurView } from 'expo-blur';
import BlurPill from './BlurPill';
import { useTheme } from '../theme/ThemeContext';

type Props = {
  visible: boolean;
  onClose: () => void;
  onApply: (opts: { vibe: string; season: string }) => void;
  initialVibe?: string;
  initialSeason?: string;
};

const VIBES = ['Minimal', 'Street', 'Y2K', 'Smart'];
const SEASONS = ['All', 'S/S', 'A/W'];

export default function OptionsModal({
  visible,
  onClose,
  onApply,
  initialVibe = 'Minimal',
  initialSeason = 'All',
}: Props) {
  const { colors, isDark } = useTheme();
  const [vibe, setVibe] = useState(initialVibe);
  const [season, setSeason] = useState(initialSeason);
  const styles = React.useMemo(
    () =>
      StyleSheet.create({
        backdrop: {
          ...StyleSheet.absoluteFillObject,
          backgroundColor: 'rgba(0,0,0,0.35)',
        },
        centerWrap: {
          ...StyleSheet.absoluteFillObject,
          justifyContent: 'center',
          alignItems: 'center',
          padding: s(4),
        },
        panel: {
          width: '100%',
          maxWidth: 520,
          borderRadius: radius.card,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(17,17,20,0.88)' : 'rgba(255,255,255,0.7)',
          padding: s(3),
          overflow: 'hidden',
        },
        rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: s(1) },
        label: { fontSize: 12, fontWeight: '800', color: colors.textDim, marginBottom: s(1) },
        actions: {
          flexDirection: 'row',
          gap: s(2),
          marginTop: s(3),
          justifyContent: 'flex-end',
        },
        btn: {
          height: 44,
          borderRadius: radius.capsule,
          paddingHorizontal: s(4),
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
        },
        btnGhost: {
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.55)',
          borderColor: colors.borderLight,
        },
        btnPrimary: {
          backgroundColor: colors.text,
          borderColor: colors.text,
        },
        btnText: { fontSize: 14, fontWeight: '800', letterSpacing: 0.2 },
      }),
    [colors, isDark]
  );

  useEffect(() => {
    if (visible) {
      setVibe(initialVibe);
      setSeason(initialSeason);
    }
  }, [visible, initialVibe, initialSeason]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Dim/backdrop */}
      <Pressable style={styles.backdrop} onPress={onClose}>
        <BlurView intensity={20} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFillObject} />
      </Pressable>

      {/* Panel */}
      <View style={styles.centerWrap} pointerEvents="box-none">
        <View style={styles.panel}>
          <Text style={[font.h2, { marginBottom: s(2) }]}>Customize options</Text>

          <ScrollView contentContainerStyle={{ paddingBottom: s(2) }} showsVerticalScrollIndicator={false}>
            <Text style={styles.label}>Vibe</Text>
            <View style={styles.rowWrap}>
              {VIBES.map((v) => (
                <BlurPill key={v} selected={vibe === v} onPress={() => setVibe(v)}>
                  {v}
                </BlurPill>
              ))}
            </View>

            <Text style={[styles.label, { marginTop: s(3) }]}>Season</Text>
            <View style={styles.rowWrap}>
              {SEASONS.map((sz) => (
                <BlurPill key={sz} selected={season === sz} onPress={() => setSeason(sz)}>
                  {sz}
                </BlurPill>
              ))}
            </View>
          </ScrollView>

          <View style={styles.actions}>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={onClose}>
              <Text style={[styles.btnText, { color: colors.text }]}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.btn, styles.btnPrimary]}
              onPress={() => {
                onApply({ vibe, season });
                onClose();
              }}
            >
              <Text style={[styles.btnText, { color: isDark ? colors.bg : '#fff' }]}>Apply</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
