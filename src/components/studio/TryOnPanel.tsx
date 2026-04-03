// src/components/studio/TryOnPanel.tsx
import React, { useCallback, useState } from 'react';
import { View, Text, Modal, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { font, hairline, s } from '../../theme/tokens';
import useTryOn from '../../tryon/useTryOn';
import { useTheme } from '../../theme/ThemeContext';

export default function TryOnPanel({ visible, onClose, selfieUri, garmentUri, category }: any) {
  const { colors, isDark } = useTheme();
  const { prepareSelfie, prepareProduct, generate, busy, result, error } = useTryOn();
  const [ready, setReady] = useState(false);
  const styles = React.useMemo(
    () =>
      StyleSheet.create({
        backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
        card: { width: '85%', borderRadius: 18, padding: s(5), backgroundColor: isDark ? 'rgba(17,17,20,0.92)' : 'rgba(255,255,255,0.9)' },
        title: { textAlign: 'center', color: colors.text },
        subtitle: { textAlign: 'center', color: colors.textDim, marginVertical: s(2) },
        cta: {
          height: 46,
          backgroundColor: isDark ? '#fff' : colors.text,
          borderRadius: 999,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        },
        ctaTxt: { color: isDark ? colors.bg : '#fff', fontWeight: '900', fontSize: 15 },
        error: { marginTop: s(2), color: 'red', textAlign: 'center' },
      }),
    [colors, isDark]
  );

  const start = useCallback(async () => {
    try {
      await prepareSelfie(selfieUri);
      await prepareProduct(garmentUri);
      setReady(true);
      await generate({ selfieUri, category, garmentImageUri: garmentUri });
    } catch (e: any) {
      Alert.alert('Try-On failed', e.message || 'Error during preparation');
    }
  }, [selfieUri, garmentUri, category]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={[font.h2, styles.title]}>Virtual Try-On</Text>
          <Text style={[font.p, styles.subtitle]}>
            Converts to JPEG + PNG and sends to Google Cloud API.
          </Text>
          <Pressable
            onPress={start}
            disabled={busy}
            style={({ pressed }) => [styles.cta, pressed && { opacity: 0.8 }]}
          >
            {busy ? (
              <ActivityIndicator color={isDark ? colors.bg : '#fff'} />
            ) : (
              <>
                <Ionicons name="aperture-outline" size={18} color={isDark ? colors.bg : '#fff'} />
                <Text style={styles.ctaTxt}>Generate</Text>
              </>
            )}
          </Pressable>
          {error && <Text style={styles.error}>Error: {error}</Text>}
        </View>
      </View>
    </Modal>
  );
}
