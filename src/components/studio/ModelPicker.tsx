// src/components/studio/ModelPicker.tsx
import React, { useCallback, useState } from 'react';
import { Modal, View, StyleSheet, Pressable, Text, ActivityIndicator, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { colors, s, hairline, font } from '../../theme/tokens';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (jpegUri: string) => void;
};

async function ensureCameraPerms() {
  const info = await ImagePicker.getCameraPermissionsAsync();
  if (info.granted) return true;
  const req = await ImagePicker.requestCameraPermissionsAsync();
  return req.granted;
}
async function ensurePhotosPerms() {
  const info = await ImagePicker.getMediaLibraryPermissionsAsync();
  if (info.granted) return true;
  const req = await ImagePicker.requestMediaLibraryPermissionsAsync();
  return req.granted;
}
async function toJPEG(uri: string, quality = 0.92) {
  const out = await ImageManipulator.manipulateAsync(
    uri,
    [],
    { compress: quality, format: ImageManipulator.SaveFormat.JPEG }
  );
  return out.uri;
}

export default function ModelPicker({ visible, onClose, onSelect }: Props) {
  const [busy, setBusy] = useState(false);

  const pickLibrary = useCallback(async () => {
    try {
      if (!(await ensurePhotosPerms())) return;
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: (ImagePicker as any).MediaType?.Images ?? (ImagePicker as any).MediaTypeOptions?.Images,
        allowsMultipleSelection: false,
        quality: 1,
      });
      if (res.canceled) return;
      setBusy(true);
      const asset = res.assets?.[0];
      if (!asset?.uri) return;
      const jpeg = await toJPEG(asset.uri, 0.94);
      onSelect(jpeg);
      onClose();
    } catch (e: any) {
      Alert.alert('Could not pick photo', e?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [onClose, onSelect]);

  const pickCamera = useCallback(async () => {
    try {
      if (!(await ensureCameraPerms())) return;
      const res = await ImagePicker.launchCameraAsync({
        mediaTypes: (ImagePicker as any).MediaType?.Images ?? (ImagePicker as any).MediaTypeOptions?.Images,
        quality: 1,
      });
      if (res.canceled) return;
      setBusy(true);
      const asset = res.assets?.[0];
      if (!asset?.uri) return;
      const jpeg = await toJPEG(asset.uri, 0.94);
      onSelect(jpeg);
      onClose();
    } catch (e: any) {
      Alert.alert('Could not open camera', e?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [onClose, onSelect]);

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={busy ? undefined : onClose} />
      <View style={styles.sheet}>
        <BlurView intensity={28} tint="light" style={StyleSheet.absoluteFill} />
        <View style={styles.stroke} />
        <Text style={[font.h2, { color: colors.text }]}>Choose model</Text>

        <View style={{ height: s(4) }} />
        <Pressable style={styles.action} onPress={pickLibrary} disabled={busy}>
          <Ionicons name="images-outline" size={18} color={colors.text} />
          <Text style={styles.actionTxt}>Pick from library</Text>
        </Pressable>

        <View style={{ height: s(2) }} />
        <Pressable style={styles.action} onPress={pickCamera} disabled={busy}>
          <Ionicons name="camera-outline" size={18} color={colors.text} />
          <Text style={styles.actionTxt}>Take a photo</Text>
        </Pressable>

        {busy && (
          <View style={{ alignItems: 'center', marginTop: s(4) }}>
            <ActivityIndicator />
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.25)' },
  sheet: {
    position: 'absolute',
    left: s(4), right: s(4), bottom: s(8),
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderWidth: hairline,
    borderColor: 'rgba(0,0,0,0.06)',
    padding: s(4),
  },
  stroke: { ...StyleSheet.absoluteFillObject, borderRadius: 16, borderWidth: hairline, borderColor: 'rgba(255,255,255,0.9)', opacity: 0.5 },
  action: {
    height: 48,
    borderRadius: 12,
    borderWidth: hairline,
    borderColor: 'rgba(0,0,0,0.08)',
    backgroundColor: '#fff',
    paddingHorizontal: s(3),
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  actionTxt: { color: colors.text, fontWeight: '800', letterSpacing: 0.2 },
});