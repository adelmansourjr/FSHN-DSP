import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

export type LocalClosetEmbedding = {
  model?: string | null;
  updatedAt: number;
  slot?: 'top' | 'bottom' | 'mono' | 'shoes' | null;
  vector: number[];
  text?: string | null;
};

export type LocalClosetItem = {
  id: string;
  uri: string;
  createdAt: number;
  category?: string | null;
  brand?: string | null;
  color?: string | null;
  tags: string[];
  embedding?: LocalClosetEmbedding | null;
};

const STORAGE_KEY_PREFIX = 'fshn.localCloset.v1';
const CLOSET_DIR = `${FileSystem.documentDirectory || ''}closet/`;

const storageKeyForUid = (uid: string) => `${STORAGE_KEY_PREFIX}:${uid}`;

const safeString = (value: unknown) => String(value || '').trim();
const safeNumberArray = (value: unknown) =>
  Array.isArray(value)
    ? value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
    : [];

const sanitizeItem = (raw: any): LocalClosetItem | null => {
  const id = safeString(raw?.id);
  const uri = safeString(raw?.uri);
  if (!id || !uri) return null;
  return {
    id,
    uri,
    createdAt:
      typeof raw?.createdAt === 'number' && Number.isFinite(raw.createdAt)
        ? raw.createdAt
        : Date.now(),
    category: safeString(raw?.category) || null,
    brand: safeString(raw?.brand) || null,
    color: safeString(raw?.color) || null,
    tags: Array.isArray(raw?.tags)
      ? raw.tags.map((t: unknown) => safeString(t)).filter(Boolean).slice(0, 40)
      : [],
    embedding:
      raw?.embedding && typeof raw.embedding === 'object'
        ? {
            model: safeString(raw.embedding.model) || null,
            updatedAt:
              typeof raw.embedding.updatedAt === 'number' && Number.isFinite(raw.embedding.updatedAt)
                ? raw.embedding.updatedAt
                : Date.now(),
            slot: ['top', 'bottom', 'mono', 'shoes'].includes(String(raw.embedding.slot || ''))
              ? raw.embedding.slot
              : null,
            vector: safeNumberArray(raw.embedding.vector),
            text: safeString(raw.embedding.text) || null,
          }
        : null,
  };
};

export async function loadLocalCloset(uid: string): Promise<LocalClosetItem[]> {
  if (!uid) return [];
  try {
    const raw = await AsyncStorage.getItem(storageKeyForUid(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => sanitizeItem(item))
      .filter(Boolean) as LocalClosetItem[];
  } catch {
    return [];
  }
}

export async function saveLocalCloset(uid: string, items: LocalClosetItem[]): Promise<void> {
  if (!uid) return;
  const payload = JSON.stringify(items.slice(0, 300));
  await AsyncStorage.setItem(storageKeyForUid(uid), payload);
}

export async function upsertLocalClosetEmbedding(
  uid: string,
  itemId: string,
  embedding: LocalClosetEmbedding | null,
): Promise<void> {
  if (!uid || !itemId || !embedding) return;
  const items = await loadLocalCloset(uid);
  const next = items.map((item) =>
    item.id === itemId
      ? { ...item, embedding }
      : item
  );
  await saveLocalCloset(uid, next);
}

function fileExtFromUri(uri: string) {
  const noQuery = uri.split('?')[0];
  const dot = noQuery.lastIndexOf('.');
  if (dot === -1) return 'jpg';
  const ext = noQuery.slice(dot + 1).toLowerCase();
  if (!ext || ext.length > 6) return 'jpg';
  return ext;
}

async function ensureClosetDir() {
  if (!CLOSET_DIR) return;
  try {
    await FileSystem.makeDirectoryAsync(CLOSET_DIR, { intermediates: true });
  } catch {
    // no-op
  }
}

export async function persistClosetImage(sourceUri: string, id: string) {
  if (!sourceUri || !id || !CLOSET_DIR) return sourceUri;
  await ensureClosetDir();
  const ext = fileExtFromUri(sourceUri);
  const destination = `${CLOSET_DIR}${id}.${ext}`;
  try {
    await FileSystem.copyAsync({ from: sourceUri, to: destination });
    return destination;
  } catch {
    return sourceUri;
  }
}

export async function deleteLocalClosetImage(uri: string) {
  const path = safeString(uri);
  if (!path) return;
  if (CLOSET_DIR && path.startsWith(CLOSET_DIR)) {
    try {
      await FileSystem.deleteAsync(path, { idempotent: true });
    } catch {
      // no-op
    }
  }
}
