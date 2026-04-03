import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import {
  cloneListingEditorState,
  type ListingEditorPhoto,
  type ListingEditorState,
} from './listingEditor';

export type LocalListingDraft = {
  id: string;
  createdAt: number;
  updatedAt: number;
  listing: ListingEditorState;
};

const STORAGE_KEY_PREFIX = 'fshn.listingDrafts.v1';
const DRAFTS_DIR = `${FileSystem.documentDirectory || ''}listing-drafts/`;
const MAX_ITEMS = 150;

const listenersByOwner = new Map<string, Set<() => void>>();

const safeString = (value: unknown) => String(value || '').trim();

const ownerKeyForUid = (uid: string) => safeString(uid) || 'guest';

const storageKeyForUid = (uid: string) => `${STORAGE_KEY_PREFIX}:${ownerKeyForUid(uid)}`;

const draftDirForId = (draftId: string) => `${DRAFTS_DIR}${draftId}/`;

const makeDraftId = () =>
  `listing-draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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

const ensureDraftsRoot = async () => {
  if (!DRAFTS_DIR) return;
  try {
    await FileSystem.makeDirectoryAsync(DRAFTS_DIR, { intermediates: true });
  } catch {
    // no-op
  }
};

const ensureDraftDir = async (draftId: string) => {
  const dir = draftDirForId(draftId);
  if (!dir) return;
  await ensureDraftsRoot();
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // no-op
  }
};

const sanitizeDraft = (raw: any): LocalListingDraft | null => {
  const id = safeString(raw?.id);
  if (!id) return null;
  return {
    id,
    createdAt:
      typeof raw?.createdAt === 'number' && Number.isFinite(raw.createdAt)
        ? raw.createdAt
        : Date.now(),
    updatedAt:
      typeof raw?.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : typeof raw?.createdAt === 'number' && Number.isFinite(raw.createdAt)
          ? raw.createdAt
          : Date.now(),
    listing: cloneListingEditorState(raw?.listing),
  };
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

const saveListForUid = async (uid: string, drafts: LocalListingDraft[]) => {
  const payload = JSON.stringify(
    drafts
      .slice(0, MAX_ITEMS)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  );
  await AsyncStorage.setItem(storageKeyForUid(uid), payload);
};

async function persistPhotoToDraft(
  source: ListingEditorPhoto,
  draftId: string,
  index: number
): Promise<ListingEditorPhoto | null> {
  const uri = safeString(source?.uri);
  if (!uri) return null;
  const dir = draftDirForId(draftId);
  await ensureDraftDir(draftId);
  const ext = fileExtFromUri(uri);
  const destination = `${dir}${index}.${ext}`;
  try {
    const dataUri = parseDataUri(uri);
    if (uri === destination) {
      return {
        uri,
        storagePath: safeString(source?.storagePath) || null,
      };
    }
    if (dataUri) {
      await FileSystem.writeAsStringAsync(destination, dataUri.base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return {
        uri: destination,
        storagePath: safeString(source?.storagePath) || null,
      };
    }
    if (/^https?:\/\//i.test(uri)) {
      const download = await FileSystem.downloadAsync(uri, destination);
      return {
        uri: safeString(download?.uri) || destination,
        storagePath: safeString(source?.storagePath) || null,
      };
    }
    await FileSystem.copyAsync({ from: uri, to: destination });
    return {
      uri: destination,
      storagePath: safeString(source?.storagePath) || null,
    };
  } catch {
    return {
      uri,
      storagePath: safeString(source?.storagePath) || null,
    };
  }
}

async function cleanupDraftDir(draftId: string, keepUris: string[]) {
  const dir = draftDirForId(draftId);
  if (!dir) return;
  try {
    const existing = await FileSystem.readDirectoryAsync(dir);
    const keepSet = new Set(keepUris);
    await Promise.all(
      existing.map(async (entry) => {
        const uri = `${dir}${entry}`;
        if (keepSet.has(uri)) return;
        try {
          await FileSystem.deleteAsync(uri, { idempotent: true });
        } catch {
          // no-op
        }
      })
    );
  } catch {
    // no-op
  }
}

export async function loadLocalListingDrafts(uid: string): Promise<LocalListingDraft[]> {
  if (!safeString(uid)) return [];
  try {
    const raw = await AsyncStorage.getItem(storageKeyForUid(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => sanitizeDraft(entry))
      .filter((entry): entry is LocalListingDraft => Boolean(entry))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function getLocalListingDraftById(
  uid: string,
  draftId: string
): Promise<LocalListingDraft | null> {
  const cleanId = safeString(draftId);
  if (!safeString(uid) || !cleanId) return null;
  const drafts = await loadLocalListingDrafts(uid);
  return drafts.find((draft) => draft.id === cleanId) || null;
}

export async function saveLocalListingDraft(
  uid: string,
  listingInput: ListingEditorState,
  draftId?: string | null
): Promise<LocalListingDraft> {
  const cleanUid = safeString(uid);
  if (!cleanUid) {
    throw new Error('missing-user');
  }

  const nextId = safeString(draftId) || makeDraftId();
  const sanitizedListing = cloneListingEditorState(listingInput);
  const existing = cleanUid ? await getLocalListingDraftById(cleanUid, nextId) : null;
  const persistedPhotos = (
    await Promise.all(
      sanitizedListing.photos.map((photo, index) => persistPhotoToDraft(photo, nextId, index))
    )
  ).filter(Boolean) as ListingEditorPhoto[];

  await cleanupDraftDir(
    nextId,
    persistedPhotos.map((photo) => photo.uri)
  );

  const nextDraft: LocalListingDraft = {
    id: nextId,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
    listing: {
      ...sanitizedListing,
      photos: persistedPhotos,
    },
  };

  const existingDrafts = await loadLocalListingDrafts(cleanUid);
  const nextDrafts = [nextDraft, ...existingDrafts.filter((entry) => entry.id !== nextId)].slice(0, MAX_ITEMS);
  await saveListForUid(cleanUid, nextDrafts);
  notifyOwner(ownerKeyForUid(cleanUid));
  return nextDraft;
}

export async function deleteLocalListingDraft(uid: string, draftId: string): Promise<void> {
  const cleanUid = safeString(uid);
  const cleanDraftId = safeString(draftId);
  if (!cleanUid || !cleanDraftId) return;
  const existing = await loadLocalListingDrafts(cleanUid);
  const next = existing.filter((entry) => entry.id !== cleanDraftId);
  await saveListForUid(cleanUid, next);
  const dir = draftDirForId(cleanDraftId);
  if (dir) {
    try {
      await FileSystem.deleteAsync(dir, { idempotent: true });
    } catch {
      // no-op
    }
  }
  notifyOwner(ownerKeyForUid(cleanUid));
}

export function subscribeLocalListingDrafts(uid: string, listener: () => void) {
  const owner = ownerKeyForUid(uid);
  const current = listenersByOwner.get(owner) || new Set<() => void>();
  current.add(listener);
  listenersByOwner.set(owner, current);
  return () => {
    const next = listenersByOwner.get(owner);
    if (!next) return;
    next.delete(listener);
    if (!next.size) listenersByOwner.delete(owner);
  };
}
