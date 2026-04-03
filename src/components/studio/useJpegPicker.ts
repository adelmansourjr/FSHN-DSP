// src/components/studio/useJpegPicker.ts
import { useCallback } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Alert, Linking, Platform } from 'react-native';

type PickedJpeg = { uri: string; base64: string; width: number; height: number };

async function ask(title: string, message: string) {
  return new Promise<boolean>((resolve) => {
    Alert.alert(title, message, [
      { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Allow', onPress: () => resolve(true) },
    ]);
  });
}

async function ensurePhotos(): Promise<boolean> {
  const info = await ImagePicker.getMediaLibraryPermissionsAsync();
  if (info.granted) return true;
  if (info.canAskAgain) {
    const ok = await ask('Allow Photos', 'FSHN needs access to your photos to add pictures.');
    if (!ok) return false;
    const req = await ImagePicker.requestMediaLibraryPermissionsAsync();
    return !!req.granted;
  }
  Alert.alert('Photos access is off', 'Enable Photos for FSHN in Settings.', [
    { text: 'Not now', style: 'cancel' },
    { text: 'Open Settings', onPress: () => Linking.openSettings() },
  ]);
  return false;
}

async function ensureCamera(): Promise<boolean> {
  const info = await ImagePicker.getCameraPermissionsAsync();
  if (info.granted) return true;
  if (info.canAskAgain) {
    const ok = await ask('Allow Camera', 'FSHN needs access to your camera to take a photo.');
    if (!ok) return false;
    const req = await ImagePicker.requestCameraPermissionsAsync();
    return !!req.granted;
  }
  Alert.alert('Camera access is off', 'Enable Camera for FSHN in Settings.', [
    { text: 'Not now', style: 'cancel' },
    { text: 'Open Settings', onPress: () => Linking.openSettings() },
  ]);
  return false;
}

/** Ensure the picked image is rotated correctly and encoded as JPEG with base64. */
async function toJpeg(asset: { uri: string }): Promise<PickedJpeg> {
  const out = await ImageManipulator.manipulateAsync(
    asset.uri,
    [], // rotation handled automatically by manipulator
    { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG, base64: true }
  );
  if (!out.base64) throw new Error('Could not read image.');
  return {
    uri: out.uri,
    base64: out.base64,
    width: out.width!,
    height: out.height!,
  };
}

export function useJpegPicker() {
  const pickFromLibrary = useCallback(async (): Promise<PickedJpeg | null> => {
    if (!(await ensurePhotos())) return null;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: false,
      quality: 1,
    });
    if (res.canceled || !res.assets?.[0]) return null;
    return toJpeg(res.assets[0]);
  }, []);

  const openCamera = useCallback(async (): Promise<PickedJpeg | null> => {
    if (!(await ensureCamera())) return null;
    if (Platform.OS === 'ios') await new Promise((r) => setTimeout(r, 120));
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
    });
    if (res.canceled || !res.assets?.[0]) return null;
    return toJpeg(res.assets[0]);
  }, []);

  return { pickFromLibrary, openCamera };
}