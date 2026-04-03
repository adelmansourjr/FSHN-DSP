import { Asset } from 'expo-asset';
import type { ImageSourcePropType } from 'react-native';
import { IMAGE_MODULE_MAP } from './imageMap';

const uriCache = new Map<string, string>();
const REMOTE_RE = /^(?:https?:)?\/\//i;

export function getImageSource(imagePath: string): ImageSourcePropType | undefined {
  if (REMOTE_RE.test(String(imagePath || '').trim())) {
    return { uri: imagePath };
  }
  return IMAGE_MODULE_MAP[imagePath];
}

export async function ensureAssetUri(imagePath: string): Promise<string | null> {
  const cached = uriCache.get(imagePath);
  if (cached) return cached;

  if (REMOTE_RE.test(String(imagePath || '').trim())) {
    uriCache.set(imagePath, imagePath);
    return imagePath;
  }

  const moduleId = IMAGE_MODULE_MAP[imagePath];
  if (!moduleId) return null;

  const asset = Asset.fromModule(moduleId);
  if (!asset.localUri) {
    try {
      await asset.downloadAsync();
    } catch (err) {
      console.warn('Failed to download asset', imagePath, err);
      return null;
    }
  }
  const uri = asset.localUri ?? asset.uri ?? null;
  if (uri) uriCache.set(imagePath, uri);
  return uri;
}
