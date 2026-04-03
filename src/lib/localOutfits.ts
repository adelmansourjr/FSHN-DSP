import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

export type LocalSavedOutfitItemInput = {
  role?: string | null;
  title?: string | null;
  listingId?: string | null;
  itemId?: string | null;
  image?: string | null;
  imagePath?: string | null;
  brand?: string | null;
  category?: string | null;
  price?: string | null;
  size?: string | null;
  condition?: string | null;
  tags?: string[] | null;
};

export type LocalSavedOutfitItem = {
  role?: string | null;
  title?: string | null;
  listingId?: string | null;
  itemId?: string | null;
  image?: string | null;
  imagePath?: string | null;
  brand?: string | null;
  category?: string | null;
  price?: string | null;
  size?: string | null;
  condition?: string | null;
  tags: string[];
};

export type LocalSavedOutfit = {
  id: string;
  uri: string;
  createdAt: number;
  items: LocalSavedOutfitItem[];
};

const STORAGE_KEY_PREFIX = 'fshn.localOutfits.v1';
const OUTFITS_DIR = `${FileSystem.documentDirectory || ''}saved-outfits/`;
const MAX_ITEMS = 300;

const listenersByOwner = new Map<string, Set<() => void>>();

const safeString = (value: unknown) => String(value || '').trim();
const firstNonEmpty = (...values: unknown[]) => {
  for (const value of values) {
    const next = safeString(value);
    if (next) return next;
  }
  return '';
};

const ownerKeyForUid = (uid: string) => {
  const cleanUid = safeString(uid);
  return cleanUid || 'guest';
};

const storageKeyForUid = (uid: string) => `${STORAGE_KEY_PREFIX}:${ownerKeyForUid(uid)}`;

const makeOutfitId = () =>
  `outfit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const parseDataUri = (uri: string): { ext: string; base64: string } | null => {
  const raw = safeString(uri);
  if (!raw.startsWith('data:')) return null;
  const commaIndex = raw.indexOf(',');
  if (commaIndex <= 0) return null;
  const meta = raw.slice(0, commaIndex).toLowerCase();
  const payload = raw.slice(commaIndex + 1);
  if (!meta.includes(';base64') || !payload) return null;
  let ext = 'jpg';
  if (meta.includes('image/png')) ext = 'png';
  else if (meta.includes('image/webp')) ext = 'webp';
  return { ext, base64: payload };
};

const fileExtFromUri = (uri: string) => {
  const dataUri = parseDataUri(uri);
  if (dataUri?.ext) return dataUri.ext;
  const noQuery = safeString(uri).split('?')[0];
  const dot = noQuery.lastIndexOf('.');
  if (dot === -1) return 'jpg';
  const ext = noQuery.slice(dot + 1).toLowerCase();
  if (!ext || ext.length > 6) return 'jpg';
  return ext;
};

const sanitizeOutfitItem = (raw: any): LocalSavedOutfitItem | null => {
  if (!raw || typeof raw !== 'object') return null;
  const role = firstNonEmpty(raw?.role, raw?.slot, raw?.type, raw?.part);
  const title = firstNonEmpty(raw?.title, raw?.name, raw?.label, raw?.productName, raw?.itemTitle) || role;
  const listingId = firstNonEmpty(raw?.listingId, raw?.listing_id, raw?.listingDocId);
  const itemId = firstNonEmpty(raw?.itemId, raw?.id, raw?.productId, raw?.item_id, raw?.sku);
  const image = firstNonEmpty(
    raw?.image,
    raw?.imageUrl,
    raw?.imageURL,
    raw?.photoURL,
    raw?.thumbnail,
    raw?.thumbnailUrl,
    raw?.uri,
    raw?.url,
    raw?.sourceUri,
    raw?.localUri
  );
  const imagePath = firstNonEmpty(raw?.imagePath, raw?.image_path, raw?.path, raw?.storagePath);
  const brand = firstNonEmpty(raw?.brand, raw?.vendor);
  const category = firstNonEmpty(raw?.category, raw?.categoryName, raw?.type);
  const price = firstNonEmpty(raw?.price, raw?.amount);
  const size = safeString(raw?.size);
  const condition = safeString(raw?.condition);
  const tagSource = Array.isArray(raw?.tags)
    ? raw.tags
    : Array.isArray(raw?.keywords)
      ? raw.keywords
      : Array.isArray(raw?.labels)
        ? raw.labels
        : [];
  const tags = Array.isArray(tagSource)
    ? tagSource.map((entry: unknown) => safeString(entry)).filter(Boolean).slice(0, 16)
    : [];
  if (!title && !role && !image && !listingId && !itemId) return null;
  return {
    role: role || null,
    title: title || null,
    listingId: listingId || null,
    itemId: itemId || null,
    image: image || null,
    imagePath: imagePath || null,
    brand: brand || null,
    category: category || null,
    price: price || null,
    size: size || null,
    condition: condition || null,
    tags,
  };
};

const sanitizeOutfitItems = (items?: LocalSavedOutfitItemInput[] | null): LocalSavedOutfitItem[] => {
  if (!Array.isArray(items)) return [];
  return items
    .map((entry) => sanitizeOutfitItem(entry))
    .filter(Boolean)
    .slice(0, 24) as LocalSavedOutfitItem[];
};

const sanitizeOutfit = (raw: any): LocalSavedOutfit | null => {
  const id = firstNonEmpty(raw?.id, raw?.outfitId, raw?.resultId, raw?.key);
  const uri = firstNonEmpty(raw?.uri, raw?.imageUri, raw?.resultUri, raw?.afterUri, raw?.image);
  if (!id || !uri) return null;
  const rawItems = Array.isArray(raw?.items)
    ? raw.items
    : Array.isArray(raw?.usedItems)
      ? raw.usedItems
      : Array.isArray(raw?.triedItems)
        ? raw.triedItems
        : Array.isArray(raw?.garments)
          ? raw.garments
          : Array.isArray(raw?.outfitItems)
            ? raw.outfitItems
            : Array.isArray(raw?.selectedItems)
              ? raw.selectedItems
              : Array.isArray(raw?.products)
                ? raw.products
                : [];
  return {
    id,
    uri,
    createdAt:
      typeof raw?.createdAt === 'number' && Number.isFinite(raw.createdAt)
        ? raw.createdAt
        : Date.now(),
    items: Array.isArray(rawItems)
      ? (rawItems.map((entry: any) => sanitizeOutfitItem(entry)).filter(Boolean) as LocalSavedOutfitItem[])
      : [],
  };
};

const ensureOutfitsDir = async () => {
  if (!OUTFITS_DIR) return;
  try {
    await FileSystem.makeDirectoryAsync(OUTFITS_DIR, { intermediates: true });
  } catch {
    // no-op
  }
};

const persistOutfitImage = async (sourceUri: string, id: string) => {
  const uri = safeString(sourceUri);
  if (!uri || !OUTFITS_DIR) return uri;
  await ensureOutfitsDir();

  const ext = fileExtFromUri(uri);
  const destination = `${OUTFITS_DIR}${id}.${ext}`;
  try {
    const dataUri = parseDataUri(uri);
    if (dataUri) {
      await FileSystem.writeAsStringAsync(destination, dataUri.base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return destination;
    }
    if (/^https?:\/\//i.test(uri)) {
      const download = await FileSystem.downloadAsync(uri, destination);
      return safeString(download?.uri) || destination;
    }
    await FileSystem.copyAsync({ from: uri, to: destination });
    return destination;
  } catch {
    return uri;
  }
};

const deleteOutfitImageIfLocal = async (uri: string) => {
  const path = safeString(uri);
  if (!path || !OUTFITS_DIR) return;
  if (!path.startsWith(OUTFITS_DIR)) return;
  try {
    await FileSystem.deleteAsync(path, { idempotent: true });
  } catch {
    // no-op
  }
};

const notifyOwner = (owner: string) => {
  const listeners = listenersByOwner.get(owner);
  if (!listeners?.size) return;
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // no-op
    }
  });
};

const saveListForUid = async (uid: string, items: LocalSavedOutfit[]) => {
  const payload = JSON.stringify(items.slice(0, MAX_ITEMS));
  await AsyncStorage.setItem(storageKeyForUid(uid), payload);
};

export async function loadLocalOutfits(uid: string): Promise<LocalSavedOutfit[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKeyForUid(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => sanitizeOutfit(entry))
      .filter((entry): entry is LocalSavedOutfit => Boolean(entry))
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function saveLocalOutfitResult(
  uid: string,
  imageUri: string,
  usedItems?: LocalSavedOutfitItemInput[]
): Promise<LocalSavedOutfit> {
  const id = makeOutfitId();
  const persistedUri = await persistOutfitImage(imageUri, id);
  const nextOutfit: LocalSavedOutfit = {
    id,
    uri: persistedUri || imageUri,
    createdAt: Date.now(),
    items: sanitizeOutfitItems(usedItems),
  };
  const existing = await loadLocalOutfits(uid);
  const next = [nextOutfit, ...existing.filter((item) => item.id !== id)].slice(0, MAX_ITEMS);
  await saveListForUid(uid, next);
  notifyOwner(ownerKeyForUid(uid));
  return nextOutfit;
}

export async function getLocalOutfitById(uid: string, outfitId: string): Promise<LocalSavedOutfit | null> {
  const targetId = safeString(outfitId);
  if (!targetId) return null;
  const all = await loadLocalOutfits(uid);
  return all.find((item) => item.id === targetId) || null;
}

export async function deleteLocalOutfitResult(uid: string, outfitId: string): Promise<void> {
  const targetId = safeString(outfitId);
  if (!targetId) return;
  const existing = await loadLocalOutfits(uid);
  const match = existing.find((item) => item.id === targetId) || null;
  const next = existing.filter((item) => item.id !== targetId);
  await saveListForUid(uid, next);
  if (match) await deleteOutfitImageIfLocal(match.uri);
  notifyOwner(ownerKeyForUid(uid));
}

export function subscribeLocalOutfits(uid: string, listener: () => void) {
  const owner = ownerKeyForUid(uid);
  const current = listenersByOwner.get(owner) || new Set<() => void>();
  current.add(listener);
  listenersByOwner.set(owner, current);
  return () => {
    const set = listenersByOwner.get(owner);
    if (!set) return;
    set.delete(listener);
    if (!set.size) listenersByOwner.delete(owner);
  };
}
