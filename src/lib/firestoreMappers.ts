import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import { app } from './firebase';
import type { Item } from '../data/mock';
import type { ProductLike } from '../components/ProductModal';
import { normalizeParcelProfile } from './shippingCo';

export type ListingItem = Item & {
  listingId: string;
  sellerUid?: string | null;
  likeCount?: number;
  source: 'listing';
  brand?: string | null;
  description?: string | null;
  category?: string | null;
  parcelProfile?: string | null;
  gender?: string | null;
  size?: string | null;
  condition?: string | null;
  images?: string[];
  colors?: string[];
  tags?: string[];
};

const toTitleCase = (value: string) =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());

const mapCategoryToRole = (value?: string | null): Item['role'] | undefined => {
  const v = String(value || '').toLowerCase();
  if (v.includes('top')) return 'top';
  if (v.includes('bottom')) return 'bottom';
  if (v.includes('dress') || v.includes('mono')) return 'dress';
  if (v.includes('outer')) return 'outer';
  if (v.includes('shoe') || v.includes('footwear') || v.includes('sneaker') || v.includes('boot') || v.includes('heel')) {
    return 'shoes';
  }
  if (v.includes('access')) return 'accessory';
  return undefined;
};

const storageBucket =
  (app as any)?.options?.storageBucket ||
  (app as any)?.options?.storage?.bucket ||
  '';

const toStorageUrl = (value: string): string | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('gs://')) {
    const without = raw.replace('gs://', '');
    const [bucket, ...pathParts] = without.split('/');
    if (!bucket || !pathParts.length) return null;
    return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(pathParts.join('/'))}?alt=media`;
  }
  if (!storageBucket) return null;
  return `https://firebasestorage.googleapis.com/v0/b/${storageBucket}/o/${encodeURIComponent(raw)}?alt=media`;
};

const extractListingImageUrl = (value: any) => {
  if (!value) return null;
  if (Array.isArray(value)) {
    const first = value[0];
    return extractListingImageUrl(first);
  }
  if (typeof value === 'string') return toStorageUrl(value);
  return (
    toStorageUrl(value?.url) ||
    toStorageUrl(value?.downloadURL) ||
    toStorageUrl(value?.downloadUrl) ||
    toStorageUrl(value?.path) ||
    toStorageUrl(value?.fullPath) ||
    null
  );
};

const extractListingImage = (data: any) => {
  const prime =
    extractListingImageUrl(data?.primeImage) ||
    extractListingImageUrl(data?.coverImage) ||
    extractListingImageUrl(data?.image) ||
    toStorageUrl(data?.imageUrl) ||
    toStorageUrl(data?.imageURL) ||
    toStorageUrl(data?.photoURL) ||
    toStorageUrl(data?.photoUrl) ||
    toStorageUrl(data?.imagePath) ||
    toStorageUrl(data?.image_path) ||
    toStorageUrl(data?.thumbnailUrl) ||
    toStorageUrl(data?.thumbnail);
  const photos = Array.isArray(data?.photos) ? data.photos : [];
  const images = Array.isArray(data?.images) ? data.images : [];
  const fallback =
    extractListingImageUrl(photos[0]) ||
    extractListingImageUrl(images[0]) ||
    (typeof data?.image === 'string' ? toStorageUrl(data.image) : null);
  return prime || fallback || null;
};

const extractListingImages = (data: any) => {
  const photos = Array.isArray(data?.photos) ? data.photos : [];
  const images = Array.isArray(data?.images) ? data.images : [];
  const imagePaths = Array.isArray(data?.imagePaths) ? data.imagePaths : [];
  const imageUrls = Array.isArray(data?.imageUrls) ? data.imageUrls : [];
  const list = [...photos, ...images, ...imagePaths, ...imageUrls]
    .map((p: any) =>
      typeof p === 'string'
        ? toStorageUrl(p)
        : toStorageUrl(p?.url) ||
          toStorageUrl(p?.downloadURL) ||
          toStorageUrl(p?.downloadUrl) ||
          toStorageUrl(p?.path) ||
          toStorageUrl(p?.fullPath)
    )
    .filter(Boolean) as string[];
  const prime =
    extractListingImageUrl(data?.primeImage) ||
    extractListingImageUrl(data?.coverImage) ||
    extractListingImageUrl(data?.image) ||
    toStorageUrl(data?.imageUrl) ||
    toStorageUrl(data?.imageURL) ||
    toStorageUrl(data?.photoURL) ||
    toStorageUrl(data?.photoUrl) ||
    toStorageUrl(data?.imagePath) ||
    toStorageUrl(data?.image_path) ||
    toStorageUrl(data?.thumbnailUrl) ||
    toStorageUrl(data?.thumbnail);
  const single = typeof data?.image === 'string' ? toStorageUrl(data.image) : null;
  if (single && !list.includes(single)) list.unshift(single);
  if (prime && !list.includes(prime)) list.unshift(prime);
  return list;
};

const formatPrice = (amount?: number | null) => {
  if (typeof amount !== 'number') return undefined;
  const pounds = Math.max(0, Math.round(amount / 100));
  return `£${pounds}`;
};

const resolveListingTitle = (data: any) => {
  const titleSource =
    data?.title ||
    data?.name ||
    data?.displayName ||
    data?.productName ||
    data?.itemName ||
    data?.listingTitle ||
    data?.brand?.name ||
    data?.brandName ||
    data?.brand ||
    'Listing';
  return String(titleSource);
};

const resolveListingAmount = (data: any) =>
  typeof data?.price?.amount === 'number'
    ? data.price.amount
    : typeof data?.price === 'number'
      ? data.price * (data.price > 999 ? 1 : 100)
      : typeof data?.priceCents === 'number'
        ? data.priceCents
        : typeof data?.price_cents === 'number'
          ? data.price_cents
          : undefined;

const resolveListingColors = (data: any) =>
  Array.isArray(data?.colors)
    ? data.colors.map(String)
    : data?.color
      ? [String(data.color)]
      : data?.colorName
        ? [String(data.colorName)]
        : [];

const resolveListingTags = (data: any) =>
  Array.from(
    new Set(
      [
        ...(Array.isArray(data?.tags) ? data.tags : []),
        ...(Array.isArray(data?.keywords) ? data.keywords : []),
        ...(Array.isArray(data?.labels) ? data.labels : []),
        ...(Array.isArray(data?.vibes) ? data.vibes : []),
        ...(Array.isArray(data?.entities) ? data.entities : []),
        ...(Array.isArray(data?.analysis?.entities) ? data.analysis.entities : []),
        ...(Array.isArray(data?.analysis?.tags) ? data.analysis.tags : []),
      ]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );

export function listingDataToProductLike(listingId: string, data: any): ProductLike | null {
  const cleanListingId = String(listingId || '').trim();
  if (!cleanListingId || !data) return null;

  const image = extractListingImage(data);
  const images = extractListingImages(data);
  const colors = resolveListingColors(data);
  const tags = resolveListingTags(data);
  const categoryValue = data?.category?.name || data?.categoryName || data?.category;
  const brandValue = data?.brand?.name || data?.brandName || data?.brand;
  const roleFromField = mapCategoryToRole(data?.role);
  const roleFromCategory = mapCategoryToRole(categoryValue);

  return {
    id: `listing:${cleanListingId}`,
    listingId: cleanListingId,
    sellerUid: typeof data?.sellerUid === 'string' ? data.sellerUid : null,
    likeCount:
      typeof data?.likeCount === 'number'
        ? Math.max(0, Math.round(data.likeCount))
        : typeof data?.likes === 'number'
          ? Math.max(0, Math.round(data.likes))
          : 0,
    title: toTitleCase(resolveListingTitle(data)),
    brand: brandValue ?? null,
    price: formatPrice(resolveListingAmount(data)) ?? null,
    images: images.length ? images : image ? [image] : null,
    image: image || images[0] || null,
    colorName: colors[0] ? toTitleCase(colors[0]) : null,
    colorHex: null,
    description: data?.description ?? null,
    category: categoryValue ?? (roleFromField || roleFromCategory ? toTitleCase(roleFromField || roleFromCategory || '') : null),
    parcelProfile: normalizeParcelProfile(data?.parcelProfile),
    size: data?.size ?? null,
    condition: data?.condition ?? null,
    tags: tags.length ? tags : colors.length ? colors : null,
  };
}

export function listingDocToItem(doc: QueryDocumentSnapshot<DocumentData>): ListingItem | null {
  const data = doc.data();
  const status = String(data?.status || '').toLowerCase();
  if (['sold', 'archived', 'removed', 'disabled', 'banned'].includes(status)) return null;
  const image = extractListingImage(data);
  if (!image) return null;
  const title = resolveListingTitle(data);
  const amount = resolveListingAmount(data);
  const colors = resolveListingColors(data);
  const tags = resolveListingTags(data);
  const categoryValue = data?.category?.name || data?.categoryName || data?.category;
  const brandValue = data?.brand?.name || data?.brandName || data?.brand;
  const roleFromField = mapCategoryToRole(data?.role);
  const roleFromCategory = mapCategoryToRole(data?.category);
  return {
    id: `listing:${doc.id}`,
    listingId: doc.id,
    sellerUid: typeof data?.sellerUid === 'string' ? data.sellerUid : null,
    likeCount: typeof data?.likeCount === 'number'
      ? Math.max(0, Math.round(data.likeCount))
      : typeof data?.likes === 'number'
        ? Math.max(0, Math.round(data.likes))
        : 0,
    source: 'listing',
    title: toTitleCase(title),
    image,
    price: formatPrice(amount),
    role: roleFromField || mapCategoryToRole(categoryValue) || roleFromCategory,
    colorName: colors[0] ? toTitleCase(colors[0]) : null,
    colorHex: null,
    brand: brandValue ?? null,
    description: data?.description ?? null,
    category: categoryValue ?? null,
    parcelProfile: normalizeParcelProfile(data?.parcelProfile),
    gender:
      typeof data?.gender === 'string'
        ? data.gender
        : typeof data?.analysis?.gender === 'string'
          ? data.analysis.gender
          : null,
    size: data?.size ?? null,
    condition: data?.condition ?? null,
    images: extractListingImages(data),
    colors,
    tags,
  };
}

export function listingItemToProduct(item: ListingItem): ProductLike {
  return {
    id: item.id,
    listingId: item.listingId,
    sellerUid: item.sellerUid ?? null,
    likeCount: typeof item.likeCount === 'number' ? item.likeCount : undefined,
    title: item.title,
    brand: item.brand ?? null,
    price: item.price ?? null,
    images: item.images?.length ? item.images : [item.image],
    image: item.image,
    colorName: item.colorName ?? null,
    colorHex: item.colorHex ?? null,
    description: item.description ?? null,
    category: item.category ?? (item.role ? toTitleCase(item.role) : null),
    parcelProfile: item.parcelProfile ?? null,
    size: item.size ?? null,
    condition: item.condition ?? null,
    tags: item.tags?.length ? item.tags : item.colors ?? null,
  };
}
