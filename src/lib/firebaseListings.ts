import { collection, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import * as ImageManipulator from 'expo-image-manipulator';
import { auth } from './firebase';
import { RECOMMENDER_BASE_URL } from '../config/recommender';
import { db, storage } from './firebase';
import { normalizeParcelProfile, type ParcelProfile } from './shippingCo';

export type ListingPhoto = {
  uri: string;
  storagePath?: string | null;
};

export type CreateListingInput = {
  sellerUid: string;
  title: string;
  description: string;
  price: number; // pounds, stored as cents-equivalent integer
  brand?: string;
  category?: string;
  parcelProfile?: ParcelProfile;
  size?: string;
  condition?: string;
  gender?: string;
  colors?: string[];
  tags: string[];
  photos: ListingPhoto[];
};

export type UpdateListingInput = Omit<CreateListingInput, 'sellerUid'> & {
  listingId: string;
};

const normalizeListingGender = (value?: string | null) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (/\bunisex\b/.test(raw) || /\bgender[\s-]?neutral\b/.test(raw) || /\ball genders?\b/.test(raw)) return 'unisex';
  if (/\bwomen'?s?\b/.test(raw) || /\bfemale\b/.test(raw) || /\blad(?:y|ies)\b/.test(raw) || /\bgirls?\b/.test(raw)) return 'women';
  if (/\bmen'?s?\b/.test(raw) || /\bmale\b/.test(raw) || /\bboys?\b/.test(raw)) return 'men';
  return '';
};

async function requestListingReindex(listingId: string) {
  const baseUrl = String(RECOMMENDER_BASE_URL || '').trim().replace(/\/+$/, '');
  const currentUser = auth.currentUser;
  const idToken = currentUser ? await currentUser.getIdToken() : '';
  if (!baseUrl || !idToken) return;
  const res = await fetch(`${baseUrl}/reindex-my-listing`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ listingId }),
  });
  if (!res.ok) {
    const message = await res.text().catch(() => '');
    throw new Error(message || `Failed to reindex listing (${res.status})`);
  }
}

async function uploadListingPhotos(listingId: string, photos: ListingPhoto[]) {
  const uploads = photos.map(async (photo, index) => {
    const existingUrl = String(photo?.uri || '').trim();
    const existingPath = String(photo?.storagePath || '').trim();
    if (/^https?:\/\//i.test(existingUrl)) {
      return {
        url: existingUrl,
        path: existingPath || '',
      };
    }

    const normalized = await ImageManipulator.manipulateAsync(existingUrl, [], {
      compress: 0.92,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    const originalName = existingUrl.split('/').pop() || `photo_${Date.now()}_${index}`;
    const stem = originalName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_') || `photo_${Date.now()}_${index}`;
    const filename = `${stem}.jpg`;
    const storageRef = ref(storage, `listings/${listingId}/${filename}`);
    const response = await fetch(normalized.uri);
    const blob = await response.blob();
    await uploadBytes(storageRef, blob);
    const url = await getDownloadURL(storageRef);
    return { url, path: storageRef.fullPath };
  });
  return Promise.all(uploads);
}

const buildListingPayload = async (
  listingId: string,
  input: Omit<CreateListingInput, 'sellerUid'> & { sellerUid?: string }
) => {
  const uploaded = await uploadListingPhotos(listingId, input.photos);
  const prime = uploaded[0];
  const amountInCents = Math.max(0, Math.round(input.price * 100));
  const parcelProfile = normalizeParcelProfile(input.parcelProfile);

  const normalizedTags = (input.tags || []).map((tag) => String(tag).trim()).filter(Boolean);
  const tags = normalizedTags.length
    ? normalizedTags
    : input.category
      ? [String(input.category).toLowerCase()]
      : ['item'];

  return {
    ...(input.sellerUid ? { sellerUid: input.sellerUid } : {}),
    updatedAt: serverTimestamp(),
    title: input.title.trim(),
    description: input.description.trim(),
    price: {
      amount: amountInCents,
      currency: 'GBP',
    },
    primeImage: prime
      ? {
          url: prime.url,
          path: prime.path,
        }
      : null,
    photos: uploaded,
    brand: input.brand?.trim() || '',
    category: input.category || '',
    parcelProfile: parcelProfile || '',
    size: input.size || '',
    condition: input.condition || '',
    colors: input.colors || [],
    tags,
    gender: normalizeListingGender(input.gender),
  };
};

export async function createListing(input: CreateListingInput) {
  const listingRef = doc(collection(db, 'listings'));
  const listingId = listingRef.id;
  const basePayload = await buildListingPayload(listingId, input);

  const listingDoc = {
    createdAt: serverTimestamp(),
    status: 'active',
    ...basePayload,
    role: '',
    vibes: [],
    pattern: '',
    season: '',
    material: '',
    fit: '',
    measurements: {},
    sku: '',
    source: 'app',
    state: 'ok',
    removedAt: null,
    removedReason: null,
    likeCount: 0,
    viewCount: 0,
  };

  await setDoc(listingRef, listingDoc);
  try {
    await requestListingReindex(listingId);
  } catch (error) {
    console.warn('[firebaseListings] create reindex failed', { listingId, error });
  }
  return listingId;
}

export async function updateListing(input: UpdateListingInput) {
  const listingRef = doc(db, 'listings', input.listingId);
  const payload = await buildListingPayload(input.listingId, input);
  await updateDoc(listingRef, payload);
  try {
    await requestListingReindex(input.listingId);
  } catch (error) {
    console.warn('[firebaseListings] update reindex failed', { listingId: input.listingId, error });
  }
  return {
    listingId: input.listingId,
    photos: payload.photos,
  };
}

export async function removeListing(listingId: string) {
  const listingRef = doc(db, 'listings', listingId);
  await updateDoc(listingRef, {
    status: 'archived',
    updatedAt: serverTimestamp(),
  });
}
