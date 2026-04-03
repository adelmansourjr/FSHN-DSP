import AsyncStorage from '@react-native-async-storage/async-storage';
import { isCompleteTodaysPickOutfit, makeOutfitSignature, type TodaysPickResult } from './generateTodaysPick';

export type StoredTodaysPick = {
  id: string;
  createdAt: number;
  signature: string;
  outfit: TodaysPickResult['outfit'];
  anchor: TodaysPickResult['anchor'];
};

export type TodaysPickCacheState = {
  active: StoredTodaysPick | null;
  queue: StoredTodaysPick[];
};

const STORAGE_KEY_PREFIX = 'fshn.todaysPick.cache.v1';

const storageKeyForUid = (uid: string) => `${STORAGE_KEY_PREFIX}:${uid}`;

const isSlotCategory = (value: string): value is 'top' | 'bottom' | 'mono' | 'shoes' =>
  value === 'top' || value === 'bottom' || value === 'mono' || value === 'shoes';

const normalizeUri = (value?: string | null) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw;
};

const sanitizeStoredPick = (raw: any): StoredTodaysPick | null => {
  if (!raw || typeof raw !== 'object') return null;
  const outfit = raw?.outfit || {};
  const normalizedOutfit = {
    top: normalizeUri(outfit?.top),
    bottom: normalizeUri(outfit?.bottom),
    mono: normalizeUri(outfit?.mono),
    shoes: normalizeUri(outfit?.shoes),
  };
  const signature = String(raw?.signature || makeOutfitSignature(normalizedOutfit)).trim();
  if (!signature) return null;
  if (!isCompleteTodaysPickOutfit(normalizedOutfit)) return null;
  const anchorCategory = String(raw?.anchor?.category || '').trim();
  const anchorUri = normalizeUri(raw?.anchor?.uri);
  const anchor =
    isSlotCategory(anchorCategory) && anchorUri
      ? {
          id: String(raw?.anchor?.id || '').trim(),
          category: anchorCategory,
          uri: anchorUri,
        }
      : null;
  return {
    id: String(raw?.id || signature).trim() || signature,
    createdAt:
      typeof raw?.createdAt === 'number' && Number.isFinite(raw.createdAt)
        ? raw.createdAt
        : Date.now(),
    signature,
    outfit: normalizedOutfit,
    anchor,
  };
};

const sanitizeCacheState = (raw: any): TodaysPickCacheState => {
  if (!raw || typeof raw !== 'object') return { active: null, queue: [] };
  const active = sanitizeStoredPick(raw?.active);
  const queueRaw = Array.isArray(raw?.queue)
    ? raw.queue.map((item: any) => sanitizeStoredPick(item)).filter(Boolean) as StoredTodaysPick[]
    : [];
  const seen = new Set<string>();
  if (active?.signature) seen.add(active.signature);
  const queue: StoredTodaysPick[] = [];
  queueRaw.forEach((item) => {
    if (!item?.signature || seen.has(item.signature)) return;
    seen.add(item.signature);
    queue.push(item);
  });
  return { active, queue };
};

export async function loadTodaysPickCache(uid: string): Promise<TodaysPickCacheState> {
  if (!uid) return { active: null, queue: [] };
  try {
    const raw = await AsyncStorage.getItem(storageKeyForUid(uid));
    if (!raw) return { active: null, queue: [] };
    return sanitizeCacheState(JSON.parse(raw));
  } catch {
    return { active: null, queue: [] };
  }
}

export async function saveTodaysPickCache(uid: string, state: TodaysPickCacheState): Promise<void> {
  if (!uid) return;
  await AsyncStorage.setItem(storageKeyForUid(uid), JSON.stringify(sanitizeCacheState(state)));
}

export function toStoredTodaysPick(result: TodaysPickResult): StoredTodaysPick | null {
  if (!isCompleteTodaysPickOutfit(result.outfit)) return null;
  const signature = makeOutfitSignature(result.outfit);
  if (!signature) return null;
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    signature,
    outfit: {
      top: normalizeUri(result.outfit.top),
      bottom: normalizeUri(result.outfit.bottom),
      mono: normalizeUri(result.outfit.mono),
      shoes: normalizeUri(result.outfit.shoes),
    },
    anchor: result.anchor
      ? {
          id: String(result.anchor.id || '').trim(),
          category: result.anchor.category,
          uri: normalizeUri(result.anchor.uri) || '',
        }
      : null,
  };
}
