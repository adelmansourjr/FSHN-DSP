import * as FileSystem from 'expo-file-system/legacy';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from './firebase';

const CACHE_DIR = `${FileSystem.cacheDirectory}uploads/`;

async function ensureCacheDir() {
  try {
    await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
  } catch {
    // no-op
  }
}

const hash36 = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
};

const guessExt = (uri: string) => {
  const lower = uri.toLowerCase();
  if (lower.startsWith('data:image/png')) return 'png';
  if (lower.startsWith('data:image/webp')) return 'webp';
  if (lower.startsWith('data:image/avif')) return 'avif';
  if (lower.startsWith('data:image/')) return 'jpg';
  if (/\.(png)(?:\?|$)/i.test(lower)) return 'png';
  if (/\.(webp)(?:\?|$)/i.test(lower)) return 'webp';
  if (/\.(avif)(?:\?|$)/i.test(lower)) return 'avif';
  if (/\.(jpg|jpeg)(?:\?|$)/i.test(lower)) return 'jpg';
  return 'jpg';
};

async function toLocalFile(uri: string): Promise<string> {
  if (!uri) throw new Error('Missing image URI');
  if (uri.startsWith('file://') || uri.startsWith('content://')) return uri;
  if (uri.startsWith('data:')) {
    await ensureCacheDir();
    const ext = guessExt(uri);
    // Data URI prefixes can be identical across different images.
    // Use head+tail+length plus a timestamp so each upload reads the exact latest image.
    const fingerprint = `${uri.length}:${uri.slice(0, 320)}:${uri.slice(-320)}`;
    const name = `data_${hash36(fingerprint)}_${Date.now()}.${ext}`;
    const dest = `${CACHE_DIR}${name}`;
    const b64 = uri.split(',')[1] || '';
    await FileSystem.writeAsStringAsync(dest, b64, { encoding: 'base64' });
    return dest;
  }
  if (/^https?:\/\//i.test(uri)) {
    await ensureCacheDir();
    const ext = guessExt(uri);
    const name = `dl_${hash36(uri)}.${ext}`;
    const dest = `${CACHE_DIR}${name}`;
    const info = await FileSystem.getInfoAsync(dest);
    if (info.exists) return info.uri;
    const res = await FileSystem.downloadAsync(uri, dest);
    return res.uri;
  }
  return uri;
}

export async function uploadImageToStorage(path: string, uri: string) {
  const localUri = await toLocalFile(uri);
  const response = await fetch(localUri);
  const blob = await response.blob();
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, blob);
  const url = await getDownloadURL(storageRef);
  return { url, path: storageRef.fullPath };
}

export const deriveImageExt = guessExt;
