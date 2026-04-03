// src/screens/ProfileScreen.tsx
import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  Text,
  Pressable,
  Modal,
  TextInput,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Linking,
  Animated,
  Easing,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  collection,
  query,
  where,
  limit,
  onSnapshot,
  getDocs,
  documentId,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { useNav, type ProfileScreenRequest } from '../navigation/NavContext';
import MinimalHeader from '../components/MinimalHeader';
import { font, s } from '../theme/tokens';
import ProfileHeader from '../components/profile/ProfileHeader';
import FollowListModal from '../components/profile/FollowListModal';
import ClosetSection from '../components/profile/ClosetSection';
import ClosetEditorModal from '../components/profile/ClosetEditorModal';
import RevealOnMount from '../components/ui/RevealOnMount';
import CachedImage from '../components/ui/CachedImage';
import ShimmerPlaceholder from '../components/ui/ShimmerPlaceholder';
import SegmentedTabs from '../components/ui/SegmentedTabs';
import ProfileGrid, { GridItem } from '../components/profile/ProfileGrid';
import SegmentedChips from '../components/ui/SegmentedChips';
import ProductModal, { type ProductLike } from '../components/ProductModal';
import ResultModal from '../components/ResultModal';
import PostCommentsScreen, { type CommentScreenPostPreview } from '../components/feed/PostCommentsScreen';
import { useTheme } from '../theme/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { toGBPPriceLabel } from '../lib/currency';
import { removeListing } from '../lib/firebaseListings';
import {
  cancelOrder,
  createShippingCoSandboxShipment,
  describeOrderStatus,
  advanceShippingCoSandboxShipment,
  formatOrderNumber,
  formatOrderStatusLabel,
  getOrderCancellationAction,
  normalizeOrderStatus,
  reconcileShippingCoSandboxShipments,
} from '../lib/firebaseOrders';
import { useListingLikes } from '../lib/listingLikes';
import { subscribePostLikes } from '../lib/postLikes';
import { listingDocToItem, listingItemToProduct, type ListingItem } from '../lib/firestoreMappers';
import UserAvatar from '../components/UserAvatar';
import {
  deleteLocalClosetImage,
  loadLocalCloset,
  persistClosetImage,
  saveLocalCloset,
  upsertLocalClosetEmbedding,
  type LocalClosetItem,
} from '../lib/localCloset';
import { embedLocalClosetItem } from '../lib/localClosetEmbeddings';
import {
  getLocalOutfitById,
  loadLocalOutfits,
  subscribeLocalOutfits,
  type LocalSavedOutfit,
} from '../lib/localOutfits';
import {
  deleteLocalListingDraft,
  loadLocalListingDrafts,
  subscribeLocalListingDrafts,
  type LocalListingDraft,
} from '../lib/localListingDrafts';
import { mock } from '../data/mock';
import { normalizeUsername, USERNAME_RE } from '../lib/firebaseUsers';
import type { PostGarmentInput } from '../lib/firebasePosts';
import type { SearchUser } from '../components/HeaderSearchOverlay';
import { classifyUploadPhoto } from '../components/classifier/clientClassifier';
import { CLASSIFIER_ENDPOINT } from '../config/classifier';
import { classifyPhoto } from '../utils/localClassifier';
import {
  createEmptyListingEditorState,
  type ListingEditorPhoto,
  type ListingEditorState,
} from '../lib/listingEditor';
import {
  formatShippingAddressMultiline,
  isShippingAddressComplete,
  sanitizeShippingAddress,
} from '../lib/shippingAddress';
import { backfillNotifications, subscribeUnreadNotificationCount } from '../lib/notifications';
import {
  formatParcelProfileLabel,
  normalizeParcelProfile,
} from '../lib/shippingCo';

// leave extra room for Dock (bottom: 28, height: 64)
const DOCK_BOTTOM_OFFSET = 28;
const DOCK_HEIGHT = 64;
const DOCK_CLEAR = DOCK_BOTTOM_OFFSET + DOCK_HEIGHT;

type MainTab = 'listings' | 'closet' | 'outfits' | 'posts' | 'likes' | 'orders';
type ListingsTab = 'active' | 'drafts';
type OrdersTab = 'selling' | 'buying';
type LikesTab = 'liked_listings' | 'liked_posts';
type FollowMode = 'followers' | 'following';

type OrderManagerItem = {
  id: string;
  orderId: string | null;
  orderNumber: string;
  mode: OrdersTab;
  canCancel: boolean;
  sortMs: number;
  status: string;
  statusLabel: string;
  statusDescription: string;
  title: string;
  imageUri: string | null;
  priceLabel: string | null;
  purchasedAtLabel: string | null;
  shippingName: string | null;
  shippingAddressLabel: string | null;
  shippingPaidLabel: string | null;
  shippingQuoteLabel: string | null;
  parcelProfileLabel: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  trackingPhaseLabel: string | null;
  hasSandboxShipment: boolean;
  canAdvanceSandbox: boolean;
  product: ProductLike;
};

const LISTING_PREFIX = 'listing:';
const REAL_LISTING_PREFIX = 'real-listing-';
const LIKED_LISTING_PREFIX = 'liked-listing:';

const isFirestoreDocId = (value: string) => /^[A-Za-z0-9_-]{20,}$/.test(value);

const parseListingLikeDocId = (rawId: string): string | null => {
  const value = String(rawId || '').trim();
  if (!value) return null;
  if (value.startsWith(LISTING_PREFIX)) return value.slice(LISTING_PREFIX.length);
  if (value.startsWith(REAL_LISTING_PREFIX)) return value.slice(REAL_LISTING_PREFIX.length);
  if (value.startsWith(LIKED_LISTING_PREFIX)) return value.slice(LIKED_LISTING_PREFIX.length);
  if (isFirestoreDocId(value)) return value;
  return null;
};

const CLOSET_CATEGORIES = ['Top', 'Bottom', 'Mono', 'Shoes'] as const;

const normalizeClosetCategory = (value?: string | null) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('top')) return 'Top';
  if (raw.includes('bottom')) return 'Bottom';
  if (raw.includes('mono') || raw.includes('dress')) return 'Mono';
  if (
    raw.includes('shoe') ||
    raw.includes('footwear') ||
    raw.includes('sneaker') ||
    raw.includes('boot') ||
    raw.includes('heel')
  ) {
    return 'Shoes';
  }
  return '';
};

const makeLocalClosetId = () =>
  `closet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const toTitleCase = (value: string) =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());

const parseClosetTagDraft = (value: string) =>
  Array.from(
    new Set(
      String(value || '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  ).slice(0, 40);

type ClosetAutoTag = {
  category?: string | null;
  brand?: string | null;
  color?: string | null;
  tags: string[];
};

const autoTagClosetPhoto = async (uri: string): Promise<ClosetAutoTag> => {
  let remoteResult:
    | {
        category?: string | null;
        brand?: string | null;
        color?: string | null;
        tags?: string[];
      }
    | null = null;
  let localResult: ReturnType<typeof classifyUploadPhoto> | null = null;

  if (CLASSIFIER_ENDPOINT) {
    try {
      remoteResult = await classifyPhoto(uri);
    } catch (error) {
      console.warn('[ProfileScreen] closet remote classifier failed', error);
    }
  } else {
    localResult = classifyUploadPhoto(uri);
  }
  const rawCategory = String(remoteResult?.category || localResult?.category || '').trim();
  const rawBrand = String(remoteResult?.brand || localResult?.brand || '').trim();
  const rawColor = String(remoteResult?.color || localResult?.color || '').trim();
  const mergedTags = Array.from(
    new Set(
      [
        ...(Array.isArray(remoteResult?.tags) ? remoteResult.tags : []),
        ...(Array.isArray(localResult?.tags) ? localResult.tags : []),
      ]
        .map((tag) => String(tag || '').trim())
        .filter(Boolean)
    )
  ).slice(0, 40);

  return {
    category: normalizeClosetCategory(rawCategory) || null,
    brand: rawBrand ? toTitleCase(rawBrand) : null,
    color: rawColor ? rawColor : null,
    tags: mergedTags,
  };
};

const chunk = <T,>(items: T[], size: number) => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const priceFromAmount = (amount: unknown) =>
  typeof amount === 'number' ? Math.round(amount / 100) : undefined;

const dedupeListingEditorPhotos = (photos: ListingEditorPhoto[]) => {
  const seen = new Set<string>();
  const next: ListingEditorPhoto[] = [];
  photos.forEach((photo) => {
    const uri = String(photo?.uri || '').trim();
    if (!uri || seen.has(uri)) return;
    seen.add(uri);
    next.push({
      uri,
      storagePath: String(photo?.storagePath || '').trim() || null,
    });
  });
  return next.slice(0, 24);
};

const extractListingEditorPhotosFromData = (data: any): ListingEditorPhoto[] => {
  const photos: ListingEditorPhoto[] = [];
  const pushPhoto = (entry: any) => {
    if (!entry) return;
    if (typeof entry === 'string') {
      const uri = String(entry || '').trim();
      if (!uri) return;
      photos.push({ uri, storagePath: null });
      return;
    }
    const uri = String(
      entry?.url ||
        entry?.downloadURL ||
        entry?.downloadUrl ||
        entry?.imageUrl ||
        entry?.imageURL ||
        entry?.thumbnailUrl ||
        entry?.thumbnail ||
        ''
    ).trim();
    const storagePath = String(entry?.path || entry?.fullPath || '').trim() || null;
    if (!uri) return;
    photos.push({ uri, storagePath });
  };

  pushPhoto(data?.primeImage);
  pushPhoto(data?.coverImage);
  pushPhoto(data?.image);
  (Array.isArray(data?.photos) ? data.photos : []).forEach(pushPhoto);
  (Array.isArray(data?.images) ? data.images : []).forEach(pushPhoto);

  const fallbackImage = extractListingImageFromData(data);
  if (fallbackImage) {
    pushPhoto({ url: fallbackImage });
  }

  return dedupeListingEditorPhotos(photos);
};

const formatEditorPrice = (amount: number | undefined) => {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
  const pounds = Math.max(0, amount / 100);
  return Number.isInteger(pounds) ? String(pounds) : pounds.toFixed(2);
};

const mapListingDataToEditorState = (data: any): ListingEditorState => {
  const amount =
    typeof data?.price?.amount === 'number'
      ? data.price.amount
      : typeof data?.price === 'number'
        ? data.price * (data.price > 999 ? 1 : 100)
        : typeof data?.priceCents === 'number'
          ? data.priceCents
          : typeof data?.price_cents === 'number'
            ? data.price_cents
            : undefined;
  const colors = Array.isArray(data?.colors)
    ? data.colors
    : data?.color
      ? [data.color]
      : data?.colorName
        ? [data.colorName]
        : [];
  const tags = Array.from(
    new Set(
      [
        ...(Array.isArray(data?.tags) ? data.tags : []),
        ...(Array.isArray(data?.keywords) ? data.keywords : []),
        ...(Array.isArray(data?.labels) ? data.labels : []),
      ]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  ).slice(0, 40);
  return {
    ...createEmptyListingEditorState(),
    photos: extractListingEditorPhotosFromData(data),
    title: String(data?.title || data?.name || '').trim(),
    description: String(data?.description || '').trim(),
    category: String(data?.category?.name || data?.categoryName || data?.category || '').trim() || null,
    parcelProfile: normalizeParcelProfile(data?.parcelProfile),
    gender: String(data?.gender || '').trim() || null,
    size: String(data?.size || '').trim() || null,
    condition: String(data?.condition || '').trim() || null,
    brand: String(data?.brand?.name || data?.brandName || data?.brand || '').trim(),
    color: colors.map((entry: any) => String(entry || '').trim()).filter(Boolean).join(', '),
    price: formatEditorPrice(amount),
    tags,
  };
};

const firstNonEmpty = (...values: any[]) => {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return undefined;
};

const toOrderDateLabel = (value: any) => {
  let ms: number | null = null;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) ms = date.getTime();
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value;
  } else if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) ms = parsed;
  }
  if (!ms) return null;
  return new Date(ms).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

const toOrderSortMs = (data: any) => {
  const candidates = [data?.updatedAt, data?.paidAt, data?.createdAt];
  for (const value of candidates) {
    if (typeof value?.toDate === 'function') {
      const date = value.toDate();
      if (date instanceof Date && !Number.isNaN(date.getTime())) return date.getTime();
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 0;
};

const extractOrderShippingAddress = (data: any) => {
  const shipping = data?.shipping || data?.shippingAddress || data?.shipping_details || data?.delivery || {};
  const shippingAddress =
    shipping?.address || shipping?.shippingAddress || data?.address || data?.shipping_address || {};

  return sanitizeShippingAddress({
    name: firstNonEmpty(
      shipping?.name,
      shipping?.fullName,
      shipping?.recipientName,
      data?.shippingName,
      data?.recipientName,
      data?.buyerName,
      data?.customerName
    ),
    line1: firstNonEmpty(
      shippingAddress?.line1,
      shippingAddress?.address1,
      shippingAddress?.addressLine1,
      shipping?.line1,
      shipping?.address1,
      shipping?.addressLine1,
      data?.addressLine1
    ),
    line2: firstNonEmpty(
      shippingAddress?.line2,
      shippingAddress?.address2,
      shippingAddress?.addressLine2,
      shipping?.line2,
      shipping?.address2,
      shipping?.addressLine2,
      data?.addressLine2
    ),
    city: firstNonEmpty(
      shippingAddress?.city,
      shipping?.city,
      data?.city
    ),
    region: firstNonEmpty(
      shippingAddress?.state,
      shippingAddress?.region,
      shipping?.state,
      shipping?.region,
      data?.state,
      data?.region
    ),
    postalCode: firstNonEmpty(
      shippingAddress?.postal_code,
      shippingAddress?.postalCode,
      shipping?.postal_code,
      shipping?.postalCode,
      data?.postalCode
    ),
    country: firstNonEmpty(
      shippingAddress?.country,
      shipping?.country,
      data?.country
    ),
  });
};

const extractOrderDetails = (orderId: string, data: any) => {
  const shippingAddress = extractOrderShippingAddress(data);
  return {
    orderId,
    orderStatus: firstNonEmpty(data?.status, data?.orderStatus),
    shippingName: shippingAddress.name || null,
    shippingAddressLine1: shippingAddress.line1 || null,
    shippingAddressLine2: shippingAddress.line2 || null,
    shippingCity: shippingAddress.city || null,
    shippingRegion: shippingAddress.region || null,
    shippingPostalCode: shippingAddress.postalCode || null,
    shippingCountry: shippingAddress.country || null,
    shippingToUid: firstNonEmpty(data?.buyerUid, data?.soldToUid),
    purchasedAtLabel: toOrderDateLabel(data?.paidAt) || toOrderDateLabel(data?.createdAt),
  };
};

const buildOrderProduct = (orderId: string, data: any): ProductLike => {
  const listingId = String(
    data?.listingId || data?.listing?.id || data?.items?.[0]?.listingId || ''
  ).trim();
  const amount = data?.total?.amount ?? data?.amount ?? data?.price?.amount;
  const shippingTotalAmount = data?.shippingTotal?.amount ?? data?.shipping?.quote?.amount;
  const parcelProfile =
    normalizeParcelProfile(
      data?.shipping?.parcelProfile || data?.listing?.parcelProfile || data?.items?.[0]?.parcelProfile
    ) || null;
  const sandbox = data?.shipping?.sandbox || {};
  const trackingPhase = firstNonEmpty(
    sandbox?.trackingPhase,
    data?.shipping?.trackingPhase
  );
  const trackingPhaseLabel = firstNonEmpty(
    sandbox?.trackingPhaseLabel,
    data?.shipping?.trackingPhaseLabel
  );
  const price =
    typeof amount === 'number' && Number.isFinite(amount)
      ? `£${Math.max(0, Math.round(amount / 100))}`
      : null;
  const image =
    data?.listing?.primeImage?.url ||
    data?.listingImage?.url ||
    data?.listingImageUrl ||
    data?.imageUrl ||
    data?.photoURL ||
    data?.thumbnailUrl ||
    data?.items?.[0]?.image ||
    data?.items?.[0]?.imageUrl ||
    null;
  const details = extractOrderDetails(orderId, data);
  return {
    id: listingId ? `${LISTING_PREFIX}${listingId}` : `order:${orderId}`,
    listingId: listingId || null,
    sellerUid: firstNonEmpty(data?.sellerUid, data?.listing?.sellerUid),
    title: String(data?.listing?.title || data?.items?.[0]?.title || 'Order item'),
    price,
    images: image ? [String(image)] : [],
    image: image ? String(image) : null,
    description: firstNonEmpty(data?.listing?.description, data?.description),
    category: firstNonEmpty(data?.listing?.category, data?.items?.[0]?.category),
    brand: firstNonEmpty(data?.listing?.brand, data?.items?.[0]?.brand),
    size: firstNonEmpty(data?.listing?.size, data?.items?.[0]?.size),
    condition: firstNonEmpty(data?.listing?.condition, data?.items?.[0]?.condition),
    shippingPaidLabel:
      typeof shippingTotalAmount === 'number' && Number.isFinite(shippingTotalAmount)
        ? toGBPPriceLabel((Math.max(0, shippingTotalAmount) / 100).toFixed(2))
        : null,
    shippingQuoteLabel:
      firstNonEmpty(
        data?.shipping?.quote?.carrier,
        data?.shipping?.carrierName
      ) || null,
    parcelProfile,
    trackingCode: firstNonEmpty(sandbox?.trackingCode, data?.shipping?.trackingCode) || null,
    trackingUrl: firstNonEmpty(sandbox?.trackingUrl, data?.shipping?.trackingUrl) || null,
    trackingPhase: trackingPhase || null,
    trackingPhaseLabel: trackingPhaseLabel || null,
    ...details,
  };
};

const buildOrderManagerItem = (orderId: string, data: any, mode: OrdersTab): OrderManagerItem | null => {
  const product = buildOrderProduct(orderId, data);
  const title = String(product.title || '').trim();
  const status = normalizeOrderStatus(product.orderStatus);
  const shippingAddressLabel = formatShippingAddressMultiline({
    name: product.shippingName || undefined,
    line1: product.shippingAddressLine1 || undefined,
    line2: product.shippingAddressLine2 || undefined,
    city: product.shippingCity || undefined,
    region: product.shippingRegion || undefined,
    postalCode: product.shippingPostalCode || undefined,
    country: product.shippingCountry || undefined,
  });
  if (!title && !product.image) return null;
  return {
    id: `${mode}-order-${orderId}`,
    orderId,
    orderNumber: formatOrderNumber(orderId),
    mode,
    canCancel: Boolean(getOrderCancellationAction(status, mode === 'selling' ? 'seller' : 'buyer', data)),
    sortMs: toOrderSortMs(data),
    status,
    statusLabel: formatOrderStatusLabel(status),
    statusDescription: describeOrderStatus(status),
    title: title || 'Order item',
    imageUri: product.image || null,
    priceLabel: product.price || null,
    purchasedAtLabel: product.purchasedAtLabel || null,
    shippingName: product.shippingName || null,
    shippingAddressLabel: shippingAddressLabel || null,
    shippingPaidLabel: product.shippingPaidLabel || null,
    shippingQuoteLabel: product.shippingQuoteLabel || null,
    parcelProfileLabel: formatParcelProfileLabel(product.parcelProfile) || null,
    trackingCode: product.trackingCode || null,
    trackingUrl: product.trackingUrl || null,
    trackingPhaseLabel: product.trackingPhaseLabel || null,
    hasSandboxShipment: Boolean(product.trackingCode || product.trackingUrl || product.trackingPhase),
    canAdvanceSandbox:
      product.trackingPhase === 'label_created' ||
      product.trackingPhase === 'in_transit' ||
      product.trackingPhase === 'out_for_delivery',
    product,
  };
};

const buildFallbackOrderManagerItemFromListing = (
  docSnap: QueryDocumentSnapshot<DocumentData>,
  data: any,
  mode: OrdersTab
): OrderManagerItem | null => {
  const image = extractListingImageFromData(data);
  const productBase = listingDocToProductLike(docSnap, data, image);
  const status = normalizeOrderStatus(
    firstNonEmpty(data?.orderStatus, data?.order?.status, data?.status === 'sold' ? 'pending_delivery' : null)
  );
  const purchasedAtLabel =
    toOrderDateLabel(data?.soldAt) || toOrderDateLabel(data?.updatedAt) || toOrderDateLabel(data?.createdAt);
  const product: ProductLike = {
    ...productBase,
    orderId: null,
    orderStatus: status,
    shippingToUid: firstNonEmpty(data?.soldToUid),
    purchasedAtLabel,
  };
  const title = String(product.title || '').trim() || 'Order item';
  return {
    id: `${mode}-listing-fallback-${docSnap.id}`,
    orderId: null,
    orderNumber: `Ref ${formatOrderNumber(docSnap.id)}`,
    mode,
    canCancel: false,
    sortMs: toOrderSortMs({
      updatedAt: data?.soldAt || data?.updatedAt,
      paidAt: data?.soldAt,
      createdAt: data?.createdAt,
    }),
    status,
    statusLabel: formatOrderStatusLabel(status),
    statusDescription:
      mode === 'selling'
        ? 'This sold listing was recovered from your listing history.'
        : 'This purchase was recovered from your listing history.',
    title,
    imageUri: product.image || null,
    priceLabel: product.price || null,
    purchasedAtLabel: purchasedAtLabel || null,
    shippingName: null,
    shippingAddressLabel: null,
    shippingPaidLabel: null,
    shippingQuoteLabel: null,
    parcelProfileLabel: formatParcelProfileLabel(product.parcelProfile) || null,
    trackingCode: null,
    trackingUrl: null,
    trackingPhaseLabel: null,
    hasSandboxShipment: false,
    canAdvanceSandbox: false,
    product,
  };
};

const orderMergeKey = (item: OrderManagerItem) =>
  String(item.product?.listingId || item.orderId || item.id).trim();

const mergeOrderManagerItems = (primary: OrderManagerItem[], fallback: OrderManagerItem[]) => {
  const seen = new Set<string>();
  const merged: OrderManagerItem[] = [];
  [primary, fallback].forEach((source) => {
    source.forEach((item) => {
      const key = orderMergeKey(item);
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push(item);
    });
  });
  merged.sort((left, right) => right.sortMs - left.sortMs);
  return merged;
};

const extractPostGarments = (data: any): ProductLike[] => {
  const rawItems = Array.isArray(data?.garments)
    ? data.garments
    : Array.isArray(data?.triedItems)
      ? data.triedItems
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.products)
          ? data.products
          : Array.isArray(data?.outfitItems)
            ? data.outfitItems
            : Array.isArray(data?.selectedItems)
              ? data.selectedItems
              : [];
  return rawItems
    .map((raw: any, idx: number) => {
      const obj = typeof raw === 'object' && raw ? raw : {};
      const listingId = String(obj?.listingId || obj?.itemId || '').trim() || null;
      const image =
        (typeof raw === 'string' ? raw : null) ||
        obj?.image ||
        obj?.imageUrl ||
        obj?.imageURL ||
        obj?.photoURL ||
        obj?.thumbnail ||
        obj?.primeImage?.url ||
        obj?.coverImage?.url ||
        null;
      const title = obj?.title || obj?.name || obj?.role || 'Item';
      if (!image && !title) return null;
      return {
        id: String(obj?.id || obj?.itemId || `${idx}`),
        listingId,
        title: String(title),
        brand: obj?.brand || null,
        price: obj?.price || null,
        images: image ? [image] : [],
        image: image || null,
        category: obj?.category || obj?.role || null,
        size: obj?.size || null,
        condition: obj?.condition || null,
        tags: Array.isArray(obj?.tags) ? obj.tags.map(String) : null,
      } as ProductLike;
    })
    .filter(Boolean) as ProductLike[];
};

const extractListingImageFromData = (data: any): string | null => {
  return (
    data?.primeImage?.url ||
    data?.coverImage?.url ||
    data?.image?.url ||
    data?.imageUrl ||
    data?.thumbnailUrl ||
    data?.thumbnail ||
    data?.photos?.[0]?.url ||
    data?.photos?.[0] ||
    data?.images?.[0]?.url ||
    data?.images?.[0] ||
    (typeof data?.image === 'string' ? data.image : null) ||
    null
  );
};

const listingDocToProductLike = (
  docSnap: QueryDocumentSnapshot<DocumentData>,
  data: any,
  fallbackImage: string | null
): ProductLike => {
  const image = fallbackImage || extractListingImageFromData(data);
  const title = String(data?.title || data?.name || data?.productName || data?.itemName || 'Listing');
  const amount =
    typeof data?.price?.amount === 'number'
      ? data.price.amount
      : typeof data?.priceCents === 'number'
        ? data.priceCents
        : typeof data?.price === 'number'
          ? data.price * (data.price > 999 ? 1 : 100)
          : undefined;
  const price = typeof amount === 'number' ? `£${Math.max(0, Math.round(amount / 100))}` : null;
  const photos = Array.isArray(data?.photos) ? data.photos : [];
  const images = Array.isArray(data?.images) ? data.images : [];
  const mergedImages = [image, ...photos, ...images]
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      return entry?.url || entry?.downloadURL || entry?.downloadUrl || null;
    })
    .filter(Boolean) as string[];
  const uniqueImages = Array.from(new Set(mergedImages));
  const category = data?.category?.name || data?.categoryName || data?.category || null;
  const brand = data?.brand?.name || data?.brandName || data?.brand || null;
  return {
    id: `${LISTING_PREFIX}${docSnap.id}`,
    listingId: docSnap.id,
    sellerUid: typeof data?.sellerUid === 'string' ? data.sellerUid : null,
    likeCount:
      typeof data?.likeCount === 'number'
        ? Math.max(0, Math.round(data.likeCount))
        : typeof data?.likes === 'number'
          ? Math.max(0, Math.round(data.likes))
          : 0,
    title,
    description: data?.description || null,
    brand,
    price,
    images: uniqueImages,
    image: image || uniqueImages[0] || null,
    category,
    size: data?.size || null,
    condition: data?.condition || null,
    tags: Array.isArray(data?.tags) ? data.tags.map(String) : null,
  };
};

const mapListingDoc = (doc: QueryDocumentSnapshot<DocumentData>, soldOverride?: boolean): GridItem | null => {
  const data = doc.data();
  const uri = extractListingImageFromData(data);
  if (!uri) return null;
  const status = String(data?.status || '').toLowerCase();
  return {
    id: `real-listing-${doc.id}`,
    listingId: doc.id,
    uri,
    price: priceFromAmount(data?.price?.amount),
    title: String(data?.title || data?.name || 'Listing'),
    sold: soldOverride || status === 'sold',
  };
};

const extractPostImage = (data: any) => {
  const images = Array.isArray(data?.images) ? data.images : [];
  const first = images[0];
  const fromImages = typeof first === 'string' ? first : first?.url;
  return (
    fromImages ||
    (typeof data?.image === 'string' ? data.image : null) ||
    data?.image?.url ||
    data?.imageUrl ||
    data?.imageURL ||
    data?.photoURL ||
    data?.thumbnailUrl ||
    data?.thumbnail ||
    null
  );
};

const mapOrderDoc = (doc: QueryDocumentSnapshot<DocumentData>): GridItem | null => {
  const data = doc.data();
  const uri =
    data?.listing?.primeImage?.url ||
    data?.listingImage?.url ||
    data?.listingImageUrl ||
    data?.imageUrl ||
    data?.photoURL ||
    data?.thumbnailUrl ||
    data?.items?.[0]?.image ||
    data?.items?.[0]?.imageUrl;
  if (!uri) return null;
  const amount = data?.total?.amount ?? data?.amount ?? data?.price?.amount;
  const listingId = String(data?.listingId || data?.listing?.id || data?.items?.[0]?.listingId || '').trim() || undefined;
  return {
    id: `real-order-${doc.id}`,
    uri,
    price: priceFromAmount(amount),
    listingId,
    title: String(data?.listing?.title || data?.items?.[0]?.title || 'Purchased item'),
    meta: 'Purchased',
  };
};

const mapLocalOutfitItem = (item: LocalSavedOutfit): GridItem | null => {
  const id = String(item?.id || '').trim();
  const uri = String(item?.uri || '').trim();
  if (!id || !uri) return null;
  return {
    id: `local-outfit-${id}`,
    uri,
    meta: 'Saved outfit',
  };
};

const mergeItems = (primary: GridItem[], fallback: GridItem[]) => {
  const seen = new Set<string>();
  const out: GridItem[] = [];
  for (const it of primary) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  for (const it of fallback) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
};

const PROFILE_GRID_SKELETON_COUNT = 6;
const PROFILE_LISTING_SKELETON_COUNT = 4;
const PROFILE_ORDER_SKELETON_COUNT = 3;
const PROFILE_SECTION_OPEN_DURATION = 420;
const PROFILE_SHEET_OPEN_DURATION = 360;
const PROFILE_SHEET_CLOSE_DURATION = 280;
const PROFILE_SMOOTH_OUT = Easing.bezier(0.22, 1, 0.36, 1);
const PROFILE_SMOOTH_IN = Easing.bezier(0.4, 0, 0.2, 1);

type Props = {
  request?: ProfileScreenRequest | null;
};

export default function ProfileScreen({ request = null }: Props) {
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { user, profile, updateProfile, uploadProfileImage } = useAuth();
  const { likedIds, isLiked: isListingLiked, setLiked: setListingLiked } = useListingLikes(user?.uid);
  const followers = profile?.followersCount ?? 0;
  const following = profile?.followingCount ?? 0;

  // ─────────── Mock data (replace with real data) ───────────
  const outfits: GridItem[] = useMemo(
    () =>
      Array.from({ length: 6 }).map((_, i) => ({
        id: `fit-${i}`,
        uri: `https://picsum.photos/seed/fit-${i}/900/1100`,
        meta: 'Saved outfit',
      })),
    []
  );

  // NEW: your own posts
  const posts: GridItem[] = useMemo(
    () =>
      Array.from({ length: 9 }).map((_, i) => ({
        id: `post-${i}`,
        uri: `https://picsum.photos/seed/post-${i}/900/900`,
        meta: 'Post',
      })),
    []
  );

  const likedListings: GridItem[] = useMemo(
    () =>
      Array.from({ length: 7 }).map((_, i) => ({
        id: `liked-list-${i}`,
        uri: `https://picsum.photos/seed/liked-list-${i}/700/900`,
        price: 54 + i * 3,
      })),
    []
  );
  const likedPosts: GridItem[] = useMemo(
    () =>
      Array.from({ length: 9 }).map((_, i) => ({
        id: `liked-post-${i}`,
        uri: `https://picsum.photos/seed/liked-post-${i}/900/900`,
        meta: 'Post',
      })),
    []
  );
  // ─────────── State ───────────
  const [tab, setTab] = useState<MainTab>('listings');
  const [listingsTab, setListingsTab] = useState<ListingsTab>('active');
  const [ordersTab, setOrdersTab] = useState<OrdersTab>('selling');
  const [likesTab, setLikesTab] = useState<LikesTab>('liked_listings');
  const [realListings, setRealListings] = useState<GridItem[]>([]);
  const [realSold, setRealSold] = useState<GridItem[]>([]);
  const [realPosts, setRealPosts] = useState<GridItem[]>([]);
  const [realLikedListings, setRealLikedListings] = useState<GridItem[]>([]);
  const [realLikedPosts, setRealLikedPosts] = useState<GridItem[]>([]);
  const [realBought, setRealBought] = useState<GridItem[]>([]);
  const [realOutfits, setRealOutfits] = useState<GridItem[]>([]);
  const [savedOutfitItemsById, setSavedOutfitItemsById] = useState<Record<string, PostGarmentInput[]>>({});
  const [localClosetItems, setLocalClosetItems] = useState<LocalClosetItem[]>([]);
  const [closetHydrated, setClosetHydrated] = useState(false);
  const [addingClosetItem, setAddingClosetItem] = useState(false);
  const [closetTagModalOpen, setClosetTagModalOpen] = useState(false);
  const [editingClosetItemId, setEditingClosetItemId] = useState<string | null>(null);
  const [closetCategoryDraft, setClosetCategoryDraft] = useState('');
  const [closetBrandDraft, setClosetBrandDraft] = useState('');
  const [closetColorDraft, setClosetColorDraft] = useState('');
  const [closetTagDraft, setClosetTagDraft] = useState('');
  const [savingClosetEdit, setSavingClosetEdit] = useState(false);
  const [allListingItems, setAllListingItems] = useState<ListingItem[]>([]);
  const [localListingDrafts, setLocalListingDrafts] = useState<LocalListingDraft[]>([]);
  const [myActiveListingItems, setMyActiveListingItems] = useState<Record<string, ListingItem>>({});
  const [editableListingFormsById, setEditableListingFormsById] = useState<Record<string, ListingEditorState>>({});
  const [sellingOrders, setSellingOrders] = useState<OrderManagerItem[]>([]);
  const [buyingOrders, setBuyingOrders] = useState<OrderManagerItem[]>([]);
  const [sellingFallbackOrders, setSellingFallbackOrders] = useState<OrderManagerItem[]>([]);
  const [buyingFallbackOrders, setBuyingFallbackOrders] = useState<OrderManagerItem[]>([]);
  const [listingProductsByGridId, setListingProductsByGridId] = useState<Record<string, ProductLike>>({});
  const [likedListingProductsByGridId, setLikedListingProductsByGridId] = useState<Record<string, ProductLike>>({});
  const [boughtProductsByGridId, setBoughtProductsByGridId] = useState<Record<string, ProductLike>>({});
  const [postPreviewByGridId, setPostPreviewByGridId] = useState<Record<string, CommentScreenPostPreview>>({});
  const [likedPostPreviewByGridId, setLikedPostPreviewByGridId] = useState<Record<string, CommentScreenPostPreview>>({});
  const [viewerLikedPostIds, setViewerLikedPostIds] = useState<Set<string>>(new Set());
  const [followMode, setFollowMode] = useState<FollowMode | null>(null);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [activeProduct, setActiveProduct] = useState<ProductLike | null>(null);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [activeCommentsPost, setActiveCommentsPost] = useState<CommentScreenPostPreview | null>(null);
  const [activeOutfitUri, setActiveOutfitUri] = useState<string | null>(null);
  const [activeOutfitId, setActiveOutfitId] = useState<string | null>(null);
  const [activeOutfitItems, setActiveOutfitItems] = useState<PostGarmentInput[]>([]);
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [removingListingId, setRemovingListingId] = useState<string | null>(null);
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null);
  const [editProfileModalOpen, setEditProfileModalOpen] = useState(false);
  const [profileUsernameDraft, setProfileUsernameDraft] = useState('');
  const [profileDisplayNameDraft, setProfileDisplayNameDraft] = useState('');
  const [profileBioDraft, setProfileBioDraft] = useState('');
  const [profilePhotoDraftUri, setProfilePhotoDraftUri] = useState<string | null>(null);
  const [savingProfileEdit, setSavingProfileEdit] = useState(false);
  const [listingsHydrated, setListingsHydrated] = useState(false);
  const [postsHydrated, setPostsHydrated] = useState(false);
  const [outfitsHydrated, setOutfitsHydrated] = useState(false);
  const [draftsHydrated, setDraftsHydrated] = useState(false);
  const [likedListingsHydrated, setLikedListingsHydrated] = useState(false);
  const [likedPostsHydrated, setLikedPostsHydrated] = useState(false);
  const [sellingOrdersHydrated, setSellingOrdersHydrated] = useState(false);
  const [buyingOrdersHydrated, setBuyingOrdersHydrated] = useState(false);
  const [buyingFallbackHydrated, setBuyingFallbackHydrated] = useState(false);
  const sectionAnim = useRef(new Animated.Value(0)).current;
  const editProfileAnim = useRef(new Animated.Value(0)).current;
  const editProfileClosingRef = useRef(false);
  const outfitLookupSeqRef = useRef(0);
  const lastHandledRequestIdRef = useRef<string | null>(null);

  const openFollowers = useCallback(() => {
    if (!user?.uid) return;
    setFollowMode('followers');
  }, [user?.uid]);

  const openFollowing = useCallback(() => {
    if (!user?.uid) return;
    setFollowMode('following');
  }, [user?.uid]);

  const closeFollowModal = useCallback(() => setFollowMode(null), []);

  useEffect(() => {
    if (editProfileModalOpen) return;
    setProfileUsernameDraft(profile?.username || '');
    setProfileDisplayNameDraft(profile?.displayName || '');
    setProfileBioDraft(profile?.bio || '');
    setProfilePhotoDraftUri(null);
  }, [
    editProfileModalOpen,
    profile?.bio,
    profile?.displayName,
    profile?.photoURL,
    profile?.username,
  ]);

  const openEditProfileModal = useCallback(() => {
    if (!profile) return;
    setProfileUsernameDraft(profile.username || '');
    setProfileDisplayNameDraft(profile.displayName || '');
    setProfileBioDraft(profile.bio || '');
    setProfilePhotoDraftUri(null);
    setEditProfileModalOpen(true);
  }, [profile]);

  const finishEditProfileModalClose = useCallback((afterClose?: () => void) => {
    if (!editProfileModalOpen || editProfileClosingRef.current) return;
    editProfileClosingRef.current = true;
    editProfileAnim.stopAnimation(() => {
      Animated.timing(editProfileAnim, {
        toValue: 0,
        duration: PROFILE_SHEET_CLOSE_DURATION,
        easing: PROFILE_SMOOTH_IN,
        useNativeDriver: true,
      }).start(({ finished }) => {
        editProfileClosingRef.current = false;
        if (!finished) return;
        setEditProfileModalOpen(false);
        afterClose?.();
      });
    });
  }, [editProfileAnim, editProfileModalOpen]);

  const closeEditProfileModal = useCallback(() => {
    if (savingProfileEdit) return;
    finishEditProfileModalClose();
  }, [finishEditProfileModalClose, savingProfileEdit]);

  const pickProfilePhoto = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photos access needed', 'Please enable Photos to update your profile picture.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (!res.canceled && res.assets?.[0]?.uri) {
      setProfilePhotoDraftUri(res.assets[0].uri);
    }
  }, []);

  const saveProfileEdit = useCallback(async () => {
    if (!profile || savingProfileEdit) return;

    const normalizedUsername = normalizeUsername(profileUsernameDraft);
    const displayName = profileDisplayNameDraft.trim();
    const bio = profileBioDraft.trim();

    if (!USERNAME_RE.test(normalizedUsername)) {
      Alert.alert('Invalid username', 'Username must be 3-20 chars and use letters, numbers, . or _.');
      return;
    }
    if (!displayName) {
      Alert.alert('Display name required', 'Please enter a display name.');
      return;
    }
    if (bio.length > 200) {
      Alert.alert('Bio too long', 'Bio must be 200 characters or less.');
      return;
    }

    setSavingProfileEdit(true);
    try {
      let photoURL: string | undefined = undefined;
      if (profilePhotoDraftUri) {
        photoURL = await uploadProfileImage(profilePhotoDraftUri);
      }
      await updateProfile({
        username: normalizedUsername,
        displayName,
        bio,
        ...(photoURL ? { photoURL } : {}),
      });
      finishEditProfileModalClose(() => setProfilePhotoDraftUri(null));
    } catch (error: any) {
      const code = String(error?.code || error?.message || '').toUpperCase();
      if (code.includes('USERNAME_TAKEN')) {
        Alert.alert('Username unavailable', 'That username is already taken.');
      } else if (code.includes('INVALID_USERNAME')) {
        Alert.alert('Invalid username', 'Username must be 3-20 chars and use letters, numbers, . or _.');
      } else {
        Alert.alert('Save failed', error?.message || 'Could not update your profile.');
      }
    } finally {
      setSavingProfileEdit(false);
    }
  }, [
    profile,
    profileBioDraft,
    profileDisplayNameDraft,
    profilePhotoDraftUri,
    profileUsernameDraft,
    savingProfileEdit,
    finishEditProfileModalClose,
    updateProfile,
    uploadProfileImage,
  ]);

  const handleSelectUser = useCallback(
    (selected: SearchUser) => {
      nav.navigate({
        name: 'user',
        params: {
          user: {
            id: selected.id,
            username: selected.username,
            avatarUri: selected.avatarUri || '',
            bio: selected.bio || undefined,
            source: 'real',
          },
        },
      });
      setFollowMode(null);
    },
    [nav]
  );

  const ensurePhotoPermission = useCallback(async () => {
    const current = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (current.granted) return true;
    const next = await ImagePicker.requestMediaLibraryPermissionsAsync({ accessPrivileges: 'all' } as any);
    if (next.granted) return true;
    Alert.alert('Photos access needed', 'Enable Photos access to add closet items.');
    return false;
  }, []);

  const ensureCameraPermission = useCallback(async () => {
    const current = await ImagePicker.getCameraPermissionsAsync();
    if (current.granted) return true;
    const next = await ImagePicker.requestCameraPermissionsAsync();
    if (next.granted) return true;
    Alert.alert('Camera access needed', 'Enable Camera access to capture closet items.');
    return false;
  }, []);

  const addClosetItemFromUri = useCallback(
    async (sourceUri: string) => {
      if (!user?.uid || !sourceUri || addingClosetItem) return;
      setAddingClosetItem(true);
      try {
        const id = makeLocalClosetId();
        const persistedUri = await persistClosetImage(sourceUri, id);
        const tagged = await autoTagClosetPhoto(persistedUri);
        const next: LocalClosetItem = {
          id,
          uri: persistedUri,
          createdAt: Date.now(),
          category: tagged.category || null,
          brand: tagged.brand || null,
          color: tagged.color || null,
          tags: tagged.tags,
          embedding: null,
        };
        try {
          next.embedding = await embedLocalClosetItem(next);
        } catch (error) {
          console.warn('[ProfileScreen] closet embedding failed', error);
        }
        setLocalClosetItems((prev) => [...prev, next]);
      } catch (error: any) {
        Alert.alert('Add failed', error?.message || 'Could not add this item.');
      } finally {
        setAddingClosetItem(false);
      }
    },
    [addingClosetItem, user?.uid]
  );

  const pickClosetFromLibrary = useCallback(async () => {
    if (!(await ensurePhotoPermission())) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: false,
      quality: 0.92,
    });
    if (result.canceled) return;
    const uri = result.assets?.[0]?.uri;
    if (!uri) return;
    await addClosetItemFromUri(uri);
  }, [addClosetItemFromUri, ensurePhotoPermission]);

  const captureClosetWithCamera = useCallback(async () => {
    if (!(await ensureCameraPermission())) return;
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: false,
      quality: 0.92,
    });
    if (result.canceled) return;
    const uri = result.assets?.[0]?.uri;
    if (!uri) return;
    await addClosetItemFromUri(uri);
  }, [addClosetItemFromUri, ensureCameraPermission]);

  const openAddClosetSheet = useCallback(() => {
    if (!user?.uid) return;
    Alert.alert('Add closet item', 'Choose how to add your garment photo.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Use Camera', onPress: () => void captureClosetWithCamera() },
      { text: 'Choose Photo', onPress: () => void pickClosetFromLibrary() },
    ]);
  }, [captureClosetWithCamera, pickClosetFromLibrary, user?.uid]);

  useEffect(() => {
    const requestId = String(request?.requestId || '').trim();
    if (!requestId || lastHandledRequestIdRef.current === requestId) return;
    lastHandledRequestIdRef.current = requestId;

    if (request?.tab) {
      setTab(request.tab);
    }

    if (request?.tab === 'closet' && request?.openAddCloset) {
      setTimeout(() => {
        openAddClosetSheet();
      }, 120);
    }
  }, [openAddClosetSheet, request]);

  const editingClosetItem = useMemo(
    () => localClosetItems.find((item) => item.id === editingClosetItemId) || null,
    [editingClosetItemId, localClosetItems]
  );

  const closetSuggestedTags = useMemo(() => {
    const item = editingClosetItem;
    if (!item) return [] as string[];
    return Array.from(
      new Set(
        [
          item.brand || '',
          item.color || '',
          item.category || '',
          ...(item.tags || []),
        ]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .map((value) => toTitleCase(value))
      )
    ).slice(0, 8);
  }, [editingClosetItem]);

  const draftClosetTags = useMemo(
    () => parseClosetTagDraft(closetTagDraft),
    [closetTagDraft]
  );

  const openEditClosetTags = useCallback((item: LocalClosetItem) => {
    setEditingClosetItemId(item.id);
    setClosetCategoryDraft(normalizeClosetCategory(item.category));
    setClosetBrandDraft(item.brand || '');
    setClosetColorDraft(item.color || '');
    setClosetTagDraft((item.tags || []).join(', '));
    setClosetTagModalOpen(true);
  }, []);

  const closeClosetTagModal = useCallback(() => {
    setClosetTagModalOpen(false);
    setEditingClosetItemId(null);
    setClosetCategoryDraft('');
    setClosetBrandDraft('');
    setClosetColorDraft('');
    setClosetTagDraft('');
    setSavingClosetEdit(false);
  }, []);

  const toggleClosetSuggestedTag = useCallback((tag: string) => {
    const normalized = String(tag || '').trim();
    if (!normalized) return;
    setClosetTagDraft((current) => {
      const nextTags = parseClosetTagDraft(current);
      const existingIndex = nextTags.findIndex((entry) => entry.toLowerCase() === normalized.toLowerCase());
      if (existingIndex >= 0) {
        nextTags.splice(existingIndex, 1);
      } else if (nextTags.length < 40) {
        nextTags.push(normalized);
      }
      return nextTags.join(', ');
    });
  }, []);

  const clearClosetDraftTags = useCallback(() => {
    setClosetTagDraft('');
  }, []);

  const submitClosetTagUpdate = useCallback(async () => {
    if (!editingClosetItemId) return;
    setSavingClosetEdit(true);
    try {
      const category = normalizeClosetCategory(closetCategoryDraft);
      const tags = parseClosetTagDraft(closetTagDraft);
      const brand = String(closetBrandDraft || '').trim();
      const color = String(closetColorDraft || '').trim();
      const nextEmbeddingTarget = localClosetItems.find((item) => item.id === editingClosetItemId) || null;
      let nextEmbedding = nextEmbeddingTarget?.embedding || null;
      if (nextEmbeddingTarget) {
        try {
          nextEmbedding = await embedLocalClosetItem({
            ...nextEmbeddingTarget,
            category: category || nextEmbeddingTarget.category || null,
            brand: brand || nextEmbeddingTarget.brand || null,
            color: color || nextEmbeddingTarget.color || null,
            tags,
          });
        } catch (error) {
          console.warn('[ProfileScreen] closet embedding refresh failed', error);
        }
      }
      setLocalClosetItems((prev) =>
        prev.map((item) =>
          item.id === editingClosetItemId
            ? {
                ...item,
                category: category || item.category || null,
                brand: brand || null,
                color: color || null,
                tags,
                embedding: nextEmbedding,
              }
            : item
        )
      );
      closeClosetTagModal();
      if (user?.uid && nextEmbedding) {
        void upsertLocalClosetEmbedding(user.uid, editingClosetItemId, nextEmbedding).catch((error) => {
          console.warn('[ProfileScreen] failed to persist closet embedding', error);
        });
      }
    } finally {
      setSavingClosetEdit(false);
    }
  }, [
    closeClosetTagModal,
    closetBrandDraft,
    closetCategoryDraft,
    closetColorDraft,
    closetTagDraft,
    editingClosetItemId,
    localClosetItems,
    user?.uid,
  ]);

  const removeClosetItem = useCallback((item: LocalClosetItem) => {
    Alert.alert('Remove item', 'Remove this item from your on-device closet?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          setLocalClosetItems((prev) => prev.filter((candidate) => candidate.id !== item.id));
          void deleteLocalClosetImage(item.uri);
        },
      },
    ]);
  }, []);

  const openClosetItemMenu = useCallback((item: LocalClosetItem) => {
    Alert.alert('Closet item', 'Choose an action.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Edit item', onPress: () => openEditClosetTags(item) },
      { text: 'Remove item', style: 'destructive', onPress: () => removeClosetItem(item) },
    ]);
  }, [openEditClosetTags, removeClosetItem]);

  const handleTabChange = (k: string) => {
    console.log('[ProfileScreen] SegmentedTabs onChange', { pressedKey: k, activeKey: tab });
    setTab((prev) => {
      console.log('[ProfileScreen] setTab', { prev, next: k });
      return k as MainTab;
    });
  };

  const handleLikesTabChange = (k: string) => {
    console.log('[ProfileScreen] SegmentedChips onChange', { pressedKey: k, activeKey: likesTab });
    setLikesTab((prev) => {
      console.log('[ProfileScreen] setLikesTab', { prev, next: k });
      return k as LikesTab;
    });
  };

  const handleListingsTabChange = (k: string) => {
    setListingsTab(k as ListingsTab);
  };

  const handleOrdersTabChange = (k: string) => {
    setOrdersTab(k as OrdersTab);
  };

  const openProductForGridItem = useCallback(
    (item: GridItem) => {
      const listingId =
        item.listingId ||
        (item.id.startsWith('real-listing-')
          ? item.id.slice('real-listing-'.length)
          : item.id.startsWith('liked-listing:')
            ? item.id.slice('liked-listing:'.length)
            : item.id.startsWith('liked-listing-')
              ? item.id.slice('liked-listing-'.length)
              : item.id.startsWith('real-order-')
                ? item.listingId || null
                : null);
      const canonicalProductId = listingId ? `listing:${listingId}` : item.id;
      const fromListing = listingProductsByGridId[item.id];
      const fromLiked = likedListingProductsByGridId[item.id];
      const fromBought = boughtProductsByGridId[item.id];
      const listing = listingId ? myActiveListingItems[listingId] : null;
      const fallback: ProductLike = listing
        ? listingItemToProduct(listing)
        : {
            id: canonicalProductId,
            listingId,
            title: item.title || 'Listing',
            price: typeof item.price === 'number' ? `£${item.price}` : null,
            images: item.uri ? [item.uri] : [],
            image: item.uri,
          };
      const base = fromListing || fromLiked || fromBought || fallback;
      setActiveProduct(base);
      setActiveProductId(base.id || null);
      setProductModalOpen(true);
    },
    [
      boughtProductsByGridId,
      likedListingProductsByGridId,
      listingProductsByGridId,
      myActiveListingItems,
    ]
  );

  const openPostItem = useCallback(
    (item: GridItem) => {
      const preview = postPreviewByGridId[item.id] || likedPostPreviewByGridId[item.id];
      if (preview) {
        setActiveCommentsPost(preview);
        return;
      }
      const fallback: CommentScreenPostPreview = {
        id: String(item.id || ''),
        user: {
          id: user?.uid || 'viewer',
          username: profile?.username || 'user',
          avatarUri: profile?.photoURL || '',
          bio: profile?.bio || '',
        },
        modelUri: item.uri,
        caption: item.title || null,
        likes: 0,
        commentCount: 0,
        garments: [],
      };
      setActiveCommentsPost(fallback);
    },
    [
      likedPostPreviewByGridId,
      postPreviewByGridId,
      profile?.bio,
      profile?.photoURL,
      profile?.username,
      user?.uid,
    ]
  );

  const buildSavedOutfitItems = useCallback(
    (rawItems: any[]): PostGarmentInput[] => {
      const listingById = new Map<string, ListingItem>();
      allListingItems.forEach((listing) => {
        if (!listing?.listingId) return;
        listingById.set(String(listing.listingId), listing);
      });
      return rawItems
        .map((raw) => {
          const pick = (...values: unknown[]) => {
            for (const value of values) {
              const next = String(value || '').trim();
              if (next) return next;
            }
            return '';
          };
          const listingIdRaw = pick(raw?.listingId, raw?.listingDocId, raw?.listing_id);
          const itemIdRaw = pick(raw?.itemId, raw?.id, raw?.productId, raw?.item_id);
          const parsedListingId =
            parseListingLikeDocId(listingIdRaw) ||
            parseListingLikeDocId(itemIdRaw) ||
            listingIdRaw ||
            null;
          const listing = parsedListingId ? listingById.get(parsedListingId) || null : null;
          const title = pick(listing?.title, raw?.title, raw?.name, raw?.label, raw?.role);
          const image = pick(
            listing?.image,
            raw?.image,
            raw?.imageUrl,
            raw?.imageURL,
            raw?.photoURL,
            raw?.thumbnail,
            raw?.thumbnailUrl,
            raw?.uri,
            raw?.url
          );
          const next: PostGarmentInput = {
            role: pick(raw?.role, raw?.slot, raw?.type) || null,
            title: title || null,
            listingId: parsedListingId || null,
            itemId: itemIdRaw || (parsedListingId ? `listing:${parsedListingId}` : null),
            image: image || null,
            imagePath: pick(raw?.imagePath, raw?.image_path, raw?.path, raw?.storagePath) || null,
            brand: pick(listing?.brand, raw?.brand, raw?.vendor) || null,
            category: pick(listing?.category, raw?.category, raw?.categoryName, raw?.type) || null,
            price: pick(listing?.price, raw?.price, raw?.amount) || null,
            size: pick(listing?.size, raw?.size) || null,
            condition: String(listing?.condition || raw?.condition || '').trim() || null,
            tags: Array.isArray(raw?.tags)
              ? raw.tags.map(String).filter(Boolean).slice(0, 16)
              : Array.isArray(raw?.keywords)
                ? raw.keywords.map(String).filter(Boolean).slice(0, 16)
                : [],
          };
          if (!next.title && !next.image && !next.listingId && !next.itemId) return null;
          return next;
        })
        .filter(Boolean) as PostGarmentInput[];
    },
    [allListingItems]
  );

  const openOutfitItem = useCallback((item: GridItem) => {
    if (!item.uri) return;
    const savedOutfitId = item.id.startsWith('local-outfit-')
      ? item.id.slice('local-outfit-'.length)
      : item.id.startsWith('real-outfit-')
        ? item.id.slice('real-outfit-'.length)
        : null;
    setActiveOutfitId(savedOutfitId);
    setActiveOutfitUri(item.uri);
    setActiveOutfitItems(savedOutfitId ? savedOutfitItemsById[savedOutfitId] || [] : []);
  }, [savedOutfitItemsById]);

  useEffect(() => {
    if (!activeOutfitId) return;
    const fromMap = savedOutfitItemsById[activeOutfitId];
    if (Array.isArray(fromMap) && fromMap.length) {
      setActiveOutfitItems(fromMap);
      return;
    }
    if (!user?.uid) return;
    let cancelled = false;
    const lookupSeq = ++outfitLookupSeqRef.current;
    void getLocalOutfitById(user.uid, activeOutfitId)
      .then((saved) => {
        if (cancelled || lookupSeq !== outfitLookupSeqRef.current) return;
        const rawItems = Array.isArray(saved?.items) ? saved.items : [];
        setActiveOutfitItems(buildSavedOutfitItems(rawItems));
      })
      .catch(() => {
        if (cancelled || lookupSeq !== outfitLookupSeqRef.current) return;
        setActiveOutfitItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeOutfitId, buildSavedOutfitItems, savedOutfitItemsById, user?.uid]);

  const resolveUsedOutfitItemProduct = useCallback(
    (item: PostGarmentInput) => {
      const listingId =
        parseListingLikeDocId(String(item?.listingId || '')) ||
        parseListingLikeDocId(String(item?.itemId || '')) ||
        null;
      const listing =
        (listingId ? allListingItems.find((entry) => String(entry.listingId || '') === listingId) : null) ||
        (listingId ? myActiveListingItems[listingId] || null : null);
      const rawPrice = String(item?.price || '').trim();
      const normalizedPrice = rawPrice
        ? (rawPrice.startsWith('£') ? rawPrice : `£${rawPrice}`)
        : null;
      const image = String(item?.image || '').trim();

      const product: ProductLike = listing
        ? listingItemToProduct(listing)
        : {
            id: listingId ? `listing:${listingId}` : `used-item:${String(item?.itemId || Date.now())}`,
            listingId: listingId || null,
            title: String(item?.title || item?.role || 'Item').trim() || 'Item',
            price: normalizedPrice,
            images: image ? [image] : [],
            image: image || null,
            brand: String(item?.brand || '').trim() || null,
            category: String(item?.category || '').trim() || null,
            size: String(item?.size || '').trim() || null,
            condition: String(item?.condition || '').trim() || null,
            tags: Array.isArray(item?.tags) ? item.tags.map(String).filter(Boolean) : null,
          };

      return product;
    },
    [allListingItems, myActiveListingItems]
  );

  const knownUsers = useMemo(
    () => ({
      [user?.uid || 'viewer']: {
        id: user?.uid || 'viewer',
        username: profile?.username || 'user',
        avatarUri: profile?.photoURL || '',
        bio: profile?.bio || '',
      },
    }),
    [profile?.bio, profile?.photoURL, profile?.username, user?.uid]
  );

  const handleCommentsCountChange = useCallback((count: number) => {
    setActiveCommentsPost((prev) => {
      if (!prev) return prev;
      if ((prev.commentCount ?? 0) === count) return prev;
      return { ...prev, commentCount: count };
    });
  }, []);

  const handleOpenUserFromComments = useCallback(
    (selected: { id: string; username: string; avatarUri?: string | null; bio?: string }) => {
      if (!selected?.id || selected.id === user?.uid) return;
      nav.navigate({
        name: 'user',
        params: {
          user: {
            id: selected.id,
            username: selected.username,
            avatarUri: selected.avatarUri || '',
            bio: selected.bio || undefined,
            source: 'real',
          },
        },
      });
      setActiveCommentsPost(null);
    },
    [nav, user?.uid]
  );

  const openCreateListing = useCallback(() => {
    nav.openUploadEditor?.({
      mode: { kind: 'create' },
      form: createEmptyListingEditorState(),
    });
  }, [nav]);

  const resolveManagedListingId = useCallback((item: GridItem) => {
    return String(item.listingId || item.id).replace(/^real-listing-/, '').trim() || null;
  }, []);

  const startEditListing = useCallback(
    (item: GridItem) => {
      const listingId = resolveManagedListingId(item);
      const listingForm = listingId ? editableListingFormsById[listingId] : null;
      if (!listingId || !listingForm) {
        Alert.alert('Unavailable', 'This listing cannot be edited.');
        return;
      }
      nav.openUploadEditor?.({
        mode: { kind: 'listing', listingId },
        form: listingForm,
      });
    },
    [editableListingFormsById, nav, resolveManagedListingId]
  );

  const confirmRemoveListing = useCallback(
    (item: GridItem) => {
      const listingId = resolveManagedListingId(item);
      if (!listingId || removingListingId === listingId) return;
      Alert.alert('Remove listing?', 'This will hide the listing from the app.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            setRemovingListingId(listingId);
            void removeListing(listingId)
              .catch(() => {
                Alert.alert('Remove failed', 'Could not remove this listing right now.');
              })
              .finally(() => {
                setRemovingListingId((current) => (current === listingId ? null : current));
              });
          },
        },
      ]);
    },
    [removingListingId, resolveManagedListingId]
  );

  const openListingActions = useCallback(
    (item: GridItem) => {
      if (removingListingId) return;
      Alert.alert('Listing actions', 'Choose an action.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Edit listing', onPress: () => startEditListing(item) },
        { text: 'Remove listing', style: 'destructive', onPress: () => confirmRemoveListing(item) },
      ]);
    },
    [confirmRemoveListing, removingListingId, startEditListing]
  );

  const openOrderProduct = useCallback((order: OrderManagerItem) => {
    setActiveProduct(order.product);
    setActiveProductId(order.product.id || null);
    setProductModalOpen(true);
  }, []);

  const openOrderTracking = useCallback(async (order: OrderManagerItem) => {
    if (!order.trackingUrl) return;
    try {
      await Linking.openURL(order.trackingUrl);
    } catch (error: any) {
      Alert.alert('Tracking unavailable', error?.message || 'Could not open the tracking page.');
    }
  }, []);

  const createSellingOrderSandbox = useCallback(async (order: OrderManagerItem) => {
    if (!order.orderId || updatingOrderId === order.orderId) return;
    setUpdatingOrderId(order.orderId);
    try {
      await createShippingCoSandboxShipment(order.orderId);
    } catch (error: any) {
      Alert.alert(
        'Shipment setup failed',
        error?.message || 'Could not create the ShippingCo sandbox shipment right now.'
      );
    } finally {
      setUpdatingOrderId((current) => (current === order.orderId ? null : current));
    }
  }, [updatingOrderId]);

  const advanceSellingOrder = useCallback(async (order: OrderManagerItem) => {
    if (!order.orderId || !order.hasSandboxShipment || !order.canAdvanceSandbox || updatingOrderId === order.orderId) {
      return;
    }
    setUpdatingOrderId(order.orderId);
    try {
      await advanceShippingCoSandboxShipment(order.orderId);
    } catch (error: any) {
      Alert.alert(
        'Shipment update failed',
        error?.message || 'Could not advance this ShippingCo sandbox shipment right now.'
      );
    } finally {
      setUpdatingOrderId((current) => (current === order.orderId ? null : current));
    }
  }, [updatingOrderId]);

  const confirmCancelOrder = useCallback(
    (order: OrderManagerItem, role: 'buyer' | 'seller') => {
      const cancelAction = order.canCancel ? getOrderCancellationAction(order.status, role) : null;
      if (!order.orderId || !cancelAction || !user?.uid || updatingOrderId === order.orderId) return;

      Alert.alert(cancelAction.confirmTitle, cancelAction.confirmMessage, [
        { text: 'Keep order', style: 'cancel' },
        {
          text: cancelAction.label,
          style: 'destructive',
          onPress: () => {
            setUpdatingOrderId(order.orderId!);
            void cancelOrder({
              orderId: order.orderId!,
              actorUid: user.uid,
              role,
            })
              .catch((error: any) => {
                Alert.alert(
                  'Cancel failed',
                  error?.message || 'Could not cancel this order right now.'
                );
              })
              .finally(() => {
                setUpdatingOrderId((current) => (current === order.orderId ? null : current));
              });
          },
        },
      ]);
    },
    [updatingOrderId, user?.uid]
  );

  const resumeDraftListing = useCallback(
    (draft: LocalListingDraft) => {
      nav.openUploadEditor?.({
        mode: { kind: 'draft', draftId: draft.id },
        form: draft.listing,
      });
    },
    [nav]
  );

  const removeDraftListing = useCallback(
    (draft: LocalListingDraft) => {
      if (!user?.uid) return;
      Alert.alert('Delete draft?', 'This removes the draft from this device.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void deleteLocalListingDraft(user.uid, draft.id).catch(() => {
              Alert.alert('Delete failed', 'Could not remove this draft right now.');
            });
          },
        },
      ]);
    },
    [user?.uid]
  );

  // ─────────── Derived ───────────
  const bottomPad = insets.bottom + DOCK_CLEAR + s(12);

  const mainTabs = useMemo(
    () => [
      { key: 'listings', label: 'Listings' },
      { key: 'closet', label: 'Closet' },
      { key: 'outfits', label: 'Outfits' },
      { key: 'posts', label: 'Posts' },
      { key: 'likes', label: 'Likes' },
      { key: 'orders', label: 'Orders' },
    ],
    []
  );

  const visibleSellingOrders = useMemo(
    () => mergeOrderManagerItems(sellingOrders, sellingFallbackOrders),
    [sellingFallbackOrders, sellingOrders]
  );
  const visibleBuyingOrders = useMemo(
    () => mergeOrderManagerItems(buyingOrders, buyingFallbackOrders),
    [buyingFallbackOrders, buyingOrders]
  );

  const likeChips = useMemo(
    () => [
      { key: 'liked_listings', label: 'Listings' },
      { key: 'liked_posts', label: 'Posts' },
    ],
    []
  );

  const listingChips = useMemo(
    () => [
      { key: 'active', label: `Active ${realListings.length}` },
      { key: 'drafts', label: `Drafts ${localListingDrafts.length}` },
    ],
    [localListingDrafts.length, realListings.length]
  );
  const orderChips = useMemo(
    () => [
      { key: 'selling', label: `Sold ${visibleSellingOrders.length}` },
      { key: 'buying', label: `Bought ${visibleBuyingOrders.length}` },
    ],
    [visibleBuyingOrders.length, visibleSellingOrders.length]
  );
  const combinedOutfits = useMemo(() => {
    if (user?.uid) return realOutfits;
    return outfits;
  }, [outfits, realOutfits, user?.uid]);
  const combinedPosts = useMemo(() => mergeItems(realPosts, posts), [realPosts, posts]);
  const combinedLikedListings = useMemo(() => {
    const parsePrice = (value?: string | null) => {
      if (!value) return undefined;
      const numeric = Number(String(value).replace(/[^0-9.]/g, ''));
      return Number.isFinite(numeric) ? Math.round(numeric) : undefined;
    };
    const mergedSource: ListingItem[] = [
      ...allListingItems,
      ...((mock.allItems || []) as ListingItem[]),
    ];
    const likedFromStore: GridItem[] = mergedSource
      .filter((item) => likedIds.has(item.id))
      .map((item) => ({
        id: `liked-${item.id}`,
        listingId: String(item.id).startsWith('listing:') ? String(item.id).slice('listing:'.length) : undefined,
        title: item.title || undefined,
        uri: item.image,
        price: parsePrice(item.price as any),
      }));
    const filteredRealLikedListings = realLikedListings.filter((item) =>
      item.listingId ? likedIds.has(`listing:${item.listingId}`) : false
    );
    return user?.uid
      ? mergeItems(filteredRealLikedListings, likedFromStore)
      : mergeItems(likedFromStore, likedListings);
  }, [allListingItems, likedIds, likedListings, mergeItems, realLikedListings, user?.uid]);
  const combinedLikedPosts = useMemo(
    () => (user?.uid ? realLikedPosts : mergeItems(realLikedPosts, likedPosts)),
    [likedPosts, mergeItems, realLikedPosts, user?.uid]
  );
  const activeOrders = ordersTab === 'selling' ? visibleSellingOrders : visibleBuyingOrders;
  const pendingSandboxOrderIds = useMemo(
    () =>
      activeOrders
        .filter((order) => order.orderId && order.hasSandboxShipment && order.canAdvanceSandbox)
        .map((order) => order.orderId as string),
    [activeOrders]
  );
  const sellerAddressComplete = useMemo(
    () => isShippingAddressComplete(profile?.shippingAddress || {}),
    [profile?.shippingAddress]
  );
  const listingsLoading = Boolean(user?.uid) && (listingsTab === 'active' ? !listingsHydrated : !draftsHydrated);
  const outfitsLoading = Boolean(user?.uid) && !outfitsHydrated;
  const postsLoading = Boolean(user?.uid) && !postsHydrated;
  const likesLoading =
    Boolean(user?.uid) && (likesTab === 'liked_listings' ? !likedListingsHydrated : !likedPostsHydrated);
  const ordersLoading =
    Boolean(user?.uid) &&
    (ordersTab === 'selling'
      ? !visibleSellingOrders.length && (!listingsHydrated || !sellingOrdersHydrated)
      : !visibleBuyingOrders.length && (!buyingOrdersHydrated || !buyingFallbackHydrated));
  const closetLoading = Boolean(user?.uid) && !closetHydrated;
  const sectionMotionKey = `${tab}:${listingsTab}:${likesTab}:${ordersTab}`;
  const sectionOpacity = useMemo(
    () =>
      sectionAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0.78, 1],
      }),
    [sectionAnim]
  );
  const sectionTranslateY = useMemo(
    () =>
      sectionAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [8, 0],
      }),
    [sectionAnim]
  );
  const sectionScale = useMemo(
    () =>
      sectionAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0.992, 1],
      }),
    [sectionAnim]
  );
  const editSheetTranslateY = useMemo(
    () =>
      editProfileAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [26, 0],
      }),
    [editProfileAnim]
  );
  const activeListingManagerItems = useMemo(
    () =>
      realListings.map((item) => {
        const listingId = String(item.listingId || item.id).replace(/^real-listing-/, '');
        const listing = listingId ? myActiveListingItems[listingId] : null;
        const editorState = listingId ? editableListingFormsById[listingId] : null;
        const chips = [
          String(listing?.category || editorState?.category || '').trim(),
          String(listing?.size || editorState?.size || '').trim(),
          String(listing?.condition || editorState?.condition || '').trim(),
        ].filter(Boolean);
        const subtitle =
          String(listing?.description || editorState?.description || '').trim() ||
          (chips.length ? chips.join(' • ') : null);
        return {
          id: item.id,
          gridItem: item,
          imageUri: item.uri,
          title: String(listing?.title || item.title || 'Listing').trim() || 'Listing',
          subtitle,
          meta: editorState?.photos?.length ? `${editorState.photos.length} photos` : null,
          priceLabel:
            String(listing?.price || '').trim() ||
            (typeof item.price === 'number' ? `£${item.price}` : null),
        };
      }),
    [editableListingFormsById, myActiveListingItems, realListings]
  );
  const draftListingManagerItems = useMemo(
    () =>
      localListingDrafts.map((draft) => {
        return {
          id: draft.id,
          draft,
          imageUri: draft.listing.photos[0]?.uri || null,
        };
      }),
    [localListingDrafts]
  );

  useEffect(() => {
    if (tab !== 'orders' || !user?.uid || !pendingSandboxOrderIds.length) return;

    let cancelled = false;
    const run = () => {
      void reconcileShippingCoSandboxShipments(pendingSandboxOrderIds).catch((error) => {
        if (!cancelled) {
          console.warn('[ProfileScreen] reconcile sandbox shipments failed', error);
        }
      });
    };

    run();
    const timer = setInterval(run, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingSandboxOrderIds, tab, user?.uid]);

  useEffect(() => {
    if (tab !== 'orders') return;
    if (ordersTab === 'selling' && !visibleSellingOrders.length && visibleBuyingOrders.length) {
      setOrdersTab('buying');
      return;
    }
    if (ordersTab === 'buying' && !visibleBuyingOrders.length && visibleSellingOrders.length) {
      setOrdersTab('selling');
    }
  }, [ordersTab, tab, visibleBuyingOrders.length, visibleSellingOrders.length]);

  useEffect(() => {
    sectionAnim.stopAnimation(() => {
      sectionAnim.setValue(0);
      Animated.timing(sectionAnim, {
        toValue: 1,
        duration: PROFILE_SECTION_OPEN_DURATION,
        easing: PROFILE_SMOOTH_OUT,
        useNativeDriver: true,
      }).start();
    });
  }, [sectionAnim, sectionMotionKey]);

  useEffect(() => {
    if (!editProfileModalOpen) {
      editProfileAnim.setValue(0);
      editProfileClosingRef.current = false;
      return;
    }
    editProfileClosingRef.current = false;
    editProfileAnim.setValue(0);
    Animated.timing(editProfileAnim, {
      toValue: 1,
      duration: PROFILE_SHEET_OPEN_DURATION,
      easing: PROFILE_SMOOTH_OUT,
      useNativeDriver: true,
    }).start();
  }, [editProfileAnim, editProfileModalOpen]);

  const normalizedProfileUsernameDraft = normalizeUsername(profileUsernameDraft);
  const canSaveProfileEdit = useMemo(() => {
    if (!profile || savingProfileEdit) return false;
    const nextDisplayName = profileDisplayNameDraft.trim();
    const nextBio = profileBioDraft.trim();
    const currentUsername = normalizeUsername(profile.username || '');
    const currentDisplayName = String(profile.displayName || '').trim();
    const currentBio = String(profile.bio || '').trim();
    if (!USERNAME_RE.test(normalizedProfileUsernameDraft)) return false;
    if (!nextDisplayName) return false;
    if (nextBio.length > 200) return false;
    return (
      normalizedProfileUsernameDraft !== currentUsername ||
      nextDisplayName !== currentDisplayName ||
      nextBio !== currentBio ||
      !!profilePhotoDraftUri
    );
  }, [
    normalizedProfileUsernameDraft,
    profile,
    profileBioDraft,
    profileDisplayNameDraft,
    profilePhotoDraftUri,
    savingProfileEdit,
  ]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: colors.bg },
        h2: { ...font.h2, color: colors.text, marginBottom: s(2) },
        modalBackdrop: {
          flex: 1,
          justifyContent: 'flex-end',
        },
        editSheet: {
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          backgroundColor: colors.bg,
          borderTopWidth: 1,
          borderTopColor: colors.borderLight,
          paddingHorizontal: s(3),
          paddingTop: s(2),
          paddingBottom: s(3),
          gap: s(2),
          maxHeight: '84%',
        },
        editHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        editTitle: { ...font.h2, color: colors.text },
        editCloseBtn: {
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.6)',
        },
        fieldWrap: { gap: 6 },
        fieldLabel: { ...font.meta, color: colors.textDim, fontWeight: '700' },
        input: {
          minHeight: 42,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.8)',
          paddingHorizontal: s(2),
          paddingVertical: s(1.2),
          color: colors.text,
        },
        inputMultiline: {
          minHeight: 90,
          textAlignVertical: 'top',
        },
        row: {
          flexDirection: 'row',
          gap: s(1.5),
        },
        rowItem: { flex: 1, gap: 6 },
        actionsRow: {
          flexDirection: 'row',
          gap: s(1.5),
          marginTop: s(1),
        },
        actionBtn: {
          flex: 1,
          minHeight: 42,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.84)',
        },
        actionPrimary: {
          backgroundColor: colors.text,
          borderColor: colors.text,
        },
        actionTxt: { ...font.meta, color: colors.text, fontWeight: '800' },
        actionPrimaryTxt: { ...font.meta, color: isDark ? colors.bg : '#fff', fontWeight: '800' },
        profilePhotoRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(1.6),
        },
        profilePhotoShell: {
          width: s(10),
          height: s(10),
          borderRadius: s(5),
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.82)',
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
        },
        profilePhotoImage: {
          width: '100%',
          height: '100%',
        },
        profilePhotoAction: {
          minHeight: 38,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.84)',
          paddingHorizontal: s(2),
          alignItems: 'center',
          justifyContent: 'center',
        },
        profilePhotoActionTxt: {
          ...font.meta,
          color: colors.text,
          fontWeight: '800',
        },
        profileHelpTxt: {
          ...font.meta,
          color: colors.textDim,
          fontSize: 11,
          marginTop: s(-0.6),
        },
        profileBioMeta: {
          ...font.meta,
          color: colors.textDim,
          alignSelf: 'flex-end',
          fontSize: 11,
        },
        listingsHeaderRow: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: s(1.5),
          marginBottom: s(1.5),
        },
        listingsIntro: {
          ...font.meta,
          color: colors.textDim,
          marginBottom: s(2.2),
          lineHeight: 18,
        },
        outfitsIntro: {
          ...font.meta,
          color: colors.textDim,
          marginTop: s(-0.5),
          marginBottom: s(2.2),
          lineHeight: 18,
        },
        listingsNewBtn: {
          minHeight: 36,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.84)',
          paddingHorizontal: s(2),
          alignItems: 'center',
          justifyContent: 'center',
        },
        listingsNewBtnTxt: {
          ...font.meta,
          color: colors.text,
          fontWeight: '800',
        },
        listingsStack: {
          gap: s(2),
          marginTop: s(2.5),
        },
        listingTilesGrid: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          rowGap: s(2),
        },
        listingTile: {
          width: '48%',
          aspectRatio: 0.8,
          borderRadius: 18,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
        },
        listingTileImage: {
          width: '100%',
          height: '100%',
          backgroundColor: 'rgba(0,0,0,0.04)',
        },
        listingTileFallback: {
          alignItems: 'center',
          justifyContent: 'center',
        },
        listingTileOptionBtn: {
          position: 'absolute',
          right: s(1.3),
          top: s(1.3),
          width: 28,
          height: 28,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(11,11,14,0.72)' : 'rgba(255,255,255,0.92)',
          alignItems: 'center',
          justifyContent: 'center',
        },
        listingTileSkeletonBtn: {
          overflow: 'hidden',
        },
        listingTileSkeletonFooter: {
          position: 'absolute',
          left: s(1.4),
          right: s(1.4),
          bottom: s(1.4),
          height: 22,
          borderRadius: 10,
          overflow: 'hidden',
        },
        listingsEmptyCard: {
          borderRadius: 22,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.82)',
          paddingHorizontal: s(2.5),
          paddingVertical: s(2.6),
        },
        listingsEmptyTitle: {
          ...font.meta,
          color: colors.text,
          fontWeight: '900',
          marginBottom: s(0.8),
        },
        listingsEmptyBody: {
          ...font.meta,
          color: colors.textDim,
          lineHeight: 18,
        },
        ordersIntro: {
          ...font.meta,
          color: colors.textDim,
          marginTop: s(-0.5),
          marginBottom: s(2.2),
          lineHeight: 18,
        },
        ordersStack: {
          gap: s(1.5),
          marginTop: s(2.5),
        },
        orderCard: {
          borderRadius: 22,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.86)',
          overflow: 'hidden',
        },
        orderCardInner: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: s(1.6),
          padding: s(1.6),
        },
        orderThumbWrap: {
          width: 94,
          aspectRatio: 0.82,
          alignSelf: 'flex-start',
          flexShrink: 0,
          borderRadius: 16,
          overflow: 'hidden',
          backgroundColor: 'rgba(0,0,0,0.04)',
        },
        orderThumb: {
          width: '100%',
          height: '100%',
          backgroundColor: 'rgba(0,0,0,0.04)',
        },
        orderThumbFallback: {
          alignItems: 'center',
          justifyContent: 'center',
        },
        orderContent: {
          flex: 1,
          gap: s(1),
          minHeight: 0,
        },
        orderTopRow: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: s(1),
        },
        orderTitleWrap: {
          flex: 1,
          gap: 4,
          minHeight: 0,
        },
        orderTitle: {
          ...font.h2,
          color: colors.text,
          fontSize: 17,
          lineHeight: 21,
          marginBottom: 0,
        },
        orderNumber: {
          ...font.meta,
          color: colors.textDim,
          fontSize: 11,
          letterSpacing: 0.4,
        },
        orderStatusBadge: {
          alignSelf: 'flex-start',
          borderRadius: 999,
          paddingHorizontal: s(1.2),
          paddingVertical: s(0.65),
          borderWidth: 1,
        },
        orderStatusTxt: {
          ...font.meta,
          fontSize: 11,
          fontWeight: '800',
        },
        orderDescription: {
          ...font.meta,
          color: colors.text,
          lineHeight: 18,
        },
        orderMetaGrid: {
          gap: s(0.85),
          marginTop: s(0.3),
        },
        orderMetaRow: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: s(1.2),
        },
        orderMetaLabel: {
          ...font.meta,
          color: colors.textDim,
          fontSize: 11,
          fontWeight: '700',
          width: 62,
        },
        orderMetaValue: {
          ...font.meta,
          color: colors.text,
          flex: 1,
          lineHeight: 17,
        },
        orderMetaValueStrong: {
          fontWeight: '800',
        },
        skeletonPill: {
          overflow: 'hidden',
          borderRadius: 999,
          height: 34,
        },
        skeletonPillRow: {
          flexDirection: 'row',
          gap: s(1.2),
          marginTop: s(1.4),
        },
        skeletonPillWide: {
          width: 112,
        },
        skeletonPillMedium: {
          width: 96,
        },
        skeletonLine: {
          height: 14,
          borderRadius: 999,
          overflow: 'hidden',
        },
        skeletonLineShort: {
          width: '56%',
        },
        skeletonLineMedium: {
          width: '74%',
        },
        orderSkeletonCard: {
          padding: s(1.6),
        },
        orderSkeletonRow: {
          flexDirection: 'row',
          gap: s(1.6),
        },
        orderSkeletonContent: {
          flex: 1,
          gap: s(1),
        },
        orderSkeletonMeta: {
          gap: s(0.85),
          marginTop: s(0.3),
        },
        orderSkeletonActions: {
          flexDirection: 'row',
          justifyContent: 'flex-end',
          gap: s(1.2),
          marginTop: s(0.5),
        },
        orderSkeletonAction: {
          width: 118,
          height: 36,
          borderRadius: 999,
          overflow: 'hidden',
        },
        orderActionsRow: {
          flexDirection: 'row',
          justifyContent: 'flex-end',
          flexWrap: 'wrap',
          gap: s(1.2),
          marginTop: s(0.3),
        },
        orderActionBtn: {
          minHeight: 36,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: colors.text,
          backgroundColor: colors.text,
          paddingHorizontal: s(1.8),
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 122,
        },
        orderActionBtnTxt: {
          ...font.meta,
          color: isDark ? colors.bg : '#fff',
          fontWeight: '800',
        },
        orderActionBtnDanger: {
          minHeight: 36,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: 'rgba(191, 45, 45, 0.24)',
          backgroundColor: 'rgba(214, 53, 53, 0.08)',
          paddingHorizontal: s(1.8),
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 122,
        },
        orderActionBtnDangerTxt: {
          ...font.meta,
          color: '#bf2d2d',
          fontWeight: '800',
        },
        ordersEmptyCard: {
          borderRadius: 22,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.82)',
          paddingHorizontal: s(2.5),
          paddingVertical: s(2.8),
          marginTop: s(2.5),
        },
        ordersEmptyTitle: {
          ...font.meta,
          color: colors.text,
          fontWeight: '900',
          marginBottom: s(0.8),
        },
        ordersEmptyBody: {
          ...font.meta,
          color: colors.textDim,
          lineHeight: 18,
        },
      }),
    [colors, isDark]
  );

  const renderListingSkeletonGrid = useCallback(() => (
    <View style={styles.listingTilesGrid}>
      {Array.from({ length: PROFILE_LISTING_SKELETON_COUNT }, (_, index) => (
        <View key={`listing-skeleton-${index}`} style={styles.listingTile}>
          <ShimmerPlaceholder borderRadius={18} />
          <View style={[styles.listingTileOptionBtn, styles.listingTileSkeletonBtn]}>
            <ShimmerPlaceholder borderRadius={14} />
          </View>
          <View style={styles.listingTileSkeletonFooter}>
            <ShimmerPlaceholder borderRadius={10} />
          </View>
        </View>
      ))}
    </View>
  ), [
    styles.listingTile,
    styles.listingTileOptionBtn,
    styles.listingTileSkeletonBtn,
    styles.listingTileSkeletonFooter,
    styles.listingTilesGrid,
  ]);

  const renderListingFilterSkeletons = useCallback(() => (
    <View style={styles.skeletonPillRow}>
      <View style={[styles.skeletonPill, styles.skeletonPillWide]}>
        <ShimmerPlaceholder borderRadius={999} />
      </View>
      <View style={[styles.skeletonPill, styles.skeletonPillMedium]}>
        <ShimmerPlaceholder borderRadius={999} />
      </View>
    </View>
  ), [
    styles.skeletonPill,
    styles.skeletonPillMedium,
    styles.skeletonPillRow,
    styles.skeletonPillWide,
  ]);

  const renderOrderSkeletons = useCallback(() => (
    <View style={styles.ordersStack}>
      {Array.from({ length: PROFILE_ORDER_SKELETON_COUNT }, (_, index) => (
        <View key={`order-skeleton-${index}`} style={[styles.orderCard, styles.orderSkeletonCard]}>
          <View style={styles.orderSkeletonRow}>
            <View style={styles.orderThumbWrap}>
              <ShimmerPlaceholder borderRadius={16} />
            </View>
            <View style={styles.orderSkeletonContent}>
              <View style={[styles.skeletonLine, { width: '82%' }]}>
                <ShimmerPlaceholder borderRadius={999} />
              </View>
              <View style={[styles.skeletonLine, styles.skeletonLineShort]}>
                <ShimmerPlaceholder borderRadius={999} />
              </View>
              <View style={[styles.skeletonLine, { width: '68%', height: 12 }]}>
                <ShimmerPlaceholder borderRadius={999} />
              </View>
              <View style={styles.orderSkeletonMeta}>
                <View style={[styles.skeletonLine, styles.skeletonLineMedium]}>
                  <ShimmerPlaceholder borderRadius={999} />
                </View>
                <View style={[styles.skeletonLine, { width: '88%' }]}>
                  <ShimmerPlaceholder borderRadius={999} />
                </View>
                <View style={[styles.skeletonLine, { width: '72%' }]}>
                  <ShimmerPlaceholder borderRadius={999} />
                </View>
              </View>
              <View style={styles.orderSkeletonActions}>
                <View style={styles.orderSkeletonAction}>
                  <ShimmerPlaceholder borderRadius={999} />
                </View>
                <View style={styles.orderSkeletonAction}>
                  <ShimmerPlaceholder borderRadius={999} />
                </View>
              </View>
            </View>
          </View>
        </View>
      ))}
    </View>
  ), [
    styles.orderCard,
    styles.orderSkeletonAction,
    styles.orderSkeletonActions,
    styles.orderSkeletonCard,
    styles.orderSkeletonContent,
    styles.orderSkeletonMeta,
    styles.orderSkeletonRow,
    styles.orderThumbWrap,
    styles.ordersStack,
    styles.skeletonLine,
    styles.skeletonLineMedium,
    styles.skeletonLineShort,
  ]);

  useEffect(() => {
    if (!user) {
      setRealListings([]);
      setRealSold([]);
      setRealPosts([]);
      setRealLikedListings([]);
      setRealLikedPosts([]);
      setRealBought([]);
      setRealOutfits([]);
      setSavedOutfitItemsById({});
      setSellingOrders([]);
      setBuyingOrders([]);
      setSellingFallbackOrders([]);
      setBuyingFallbackOrders([]);
      setListingProductsByGridId({});
      setLikedListingProductsByGridId({});
      setBoughtProductsByGridId({});
      setPostPreviewByGridId({});
      setLikedPostPreviewByGridId({});
      setViewerLikedPostIds(new Set());
      setActiveCommentsPost(null);
      outfitLookupSeqRef.current += 1;
      setActiveOutfitUri(null);
      setActiveOutfitId(null);
      setActiveOutfitItems([]);
      setLocalClosetItems([]);
      setLocalListingDrafts([]);
      setClosetHydrated(false);
      setMyActiveListingItems({});
      setEditableListingFormsById({});
      setListingsHydrated(true);
      setPostsHydrated(true);
      setOutfitsHydrated(true);
      setDraftsHydrated(true);
      setLikedListingsHydrated(true);
      setLikedPostsHydrated(true);
      setSellingOrdersHydrated(true);
      setBuyingOrdersHydrated(true);
      setBuyingFallbackHydrated(true);
      return;
    }

    setListingsHydrated(false);
    setPostsHydrated(false);
    setSellingOrdersHydrated(false);
    setBuyingOrdersHydrated(false);
    setBuyingFallbackHydrated(false);

    const listingsRef = collection(db, 'listings');
    const listingsQuery = query(listingsRef, where('sellerUid', '==', user.uid));
    const unsubscribeListings = onSnapshot(
      listingsQuery,
      (snap) => {
        const active: GridItem[] = [];
        const soldItems: GridItem[] = [];
        const soldFallbackItems: OrderManagerItem[] = [];
        const activeListingMap: Record<string, ListingItem> = {};
        const editableForms: Record<string, ListingEditorState> = {};
        const listingProducts: Record<string, ProductLike> = {};
        snap.docs.forEach((docSnap) => {
          const data = docSnap.data();
          const status = String(data?.status || '').toLowerCase();
          if (status === 'sold') {
            const soldFallback = buildFallbackOrderManagerItemFromListing(docSnap, data, 'selling');
            if (soldFallback) soldFallbackItems.push(soldFallback);
          }
          const baseItem = mapListingDoc(docSnap);
          if (!baseItem) return;
          listingProducts[baseItem.id] = listingDocToProductLike(docSnap, data, baseItem.uri);
          if (status === 'sold') {
            soldItems.push({ ...baseItem, sold: true });
          } else if (!status || status === 'active' || status === 'live' || status === 'published') {
            active.push(baseItem);
            const listingItem = listingDocToItem(docSnap);
            if (listingItem) {
              activeListingMap[docSnap.id] = listingItem;
            }
            editableForms[docSnap.id] = mapListingDataToEditorState(data);
          }
        });
        setRealListings(active);
        setRealSold(soldItems);
        setSellingFallbackOrders(soldFallbackItems);
        setMyActiveListingItems(activeListingMap);
        setEditableListingFormsById(editableForms);
        setListingProductsByGridId(listingProducts);
        setListingsHydrated(true);
      },
      () => {
        setRealListings([]);
        setRealSold([]);
        setSellingFallbackOrders([]);
        setMyActiveListingItems({});
        setEditableListingFormsById({});
        setListingProductsByGridId({});
        setListingsHydrated(true);
      }
    );

    const postsRef = collection(db, 'posts');
    const postsQuery = query(postsRef, where('authorUid', '==', user.uid));
    const unsubscribePosts = onSnapshot(
      postsQuery,
      (snap) => {
        const items: GridItem[] = [];
        const previews: Record<string, CommentScreenPostPreview> = {};
        snap.docs.forEach((docSnap) => {
          const data = docSnap.data() as any;
          const uri = extractPostImage(data);
          if (!uri) return;
          const postId = docSnap.id;
          const gridId = `real-post-${postId}`;
          items.push({
            id: gridId,
            uri,
            meta: 'Post',
            title: String(data?.caption || data?.title || 'Post'),
          });
          previews[gridId] = {
            id: postId,
            user: {
              id: user.uid,
              username: profile?.username || 'user',
              avatarUri: profile?.photoURL || '',
              bio: profile?.bio || '',
            },
            modelUri: uri,
            caption: typeof data?.caption === 'string' ? data.caption : null,
            likes: Number(data?.likeCount ?? 0) || 0,
            commentCount: Number(data?.commentCount ?? 0) || 0,
            garments: extractPostGarments(data),
          };
        });
        setRealPosts(items);
        setPostPreviewByGridId(previews);
        setPostsHydrated(true);
      },
      () => {
        setRealPosts([]);
        setPostPreviewByGridId({});
        setPostsHydrated(true);
      }
    );

    const boughtOrdersRef = collection(db, 'orders');
    const boughtOrdersQuery = query(boughtOrdersRef, where('buyerUid', '==', user.uid));
    const unsubscribeBoughtOrders = onSnapshot(
      boughtOrdersQuery,
      (snap) => {
        const items: GridItem[] = [];
        const products: Record<string, ProductLike> = {};
        const orders: OrderManagerItem[] = [];
        snap.docs.forEach((docSnap) => {
          const data = docSnap.data() as any;
          const order = buildOrderManagerItem(docSnap.id, data, 'buying');
          if (order) orders.push(order);
          const gridItem = mapOrderDoc(docSnap);
          if (gridItem) {
            items.push(gridItem);
            products[gridItem.id] = buildOrderProduct(docSnap.id, data);
          }
        });
        orders.sort((left, right) => right.sortMs - left.sortMs);
        setRealBought(items);
        setBoughtProductsByGridId(products);
        setBuyingOrders(orders);
        setBuyingOrdersHydrated(true);
      },
      () => {
        setRealBought([]);
        setBoughtProductsByGridId({});
        setBuyingOrders([]);
        setBuyingOrdersHydrated(true);
      }
    );

    const boughtListingsRef = collection(db, 'listings');
    const boughtListingsQuery = query(boughtListingsRef, where('soldToUid', '==', user.uid));
    const unsubscribeBoughtListings = onSnapshot(
      boughtListingsQuery,
      (snap) => {
        const fallbackOrders: OrderManagerItem[] = [];
        snap.docs.forEach((docSnap) => {
          const data = docSnap.data();
          if (String(data?.status || '').toLowerCase() !== 'sold') return;
          const fallbackOrder = buildFallbackOrderManagerItemFromListing(docSnap, data, 'buying');
          if (fallbackOrder) fallbackOrders.push(fallbackOrder);
        });
        fallbackOrders.sort((left, right) => right.sortMs - left.sortMs);
        setBuyingFallbackOrders(fallbackOrders);
        setBuyingFallbackHydrated(true);
      },
      () => {
        setBuyingFallbackOrders([]);
        setBuyingFallbackHydrated(true);
      }
    );

    const soldOrdersRef = collection(db, 'orders');
    const soldOrdersQuery = query(soldOrdersRef, where('sellerUid', '==', user.uid));
    const unsubscribeSoldOrders = onSnapshot(
      soldOrdersQuery,
      (snap) => {
        const orders: OrderManagerItem[] = [];
        snap.docs.forEach((docSnap) => {
          const data = docSnap.data() as any;
          const order = buildOrderManagerItem(docSnap.id, data, 'selling');
          if (order) orders.push(order);
        });
        orders.sort((left, right) => right.sortMs - left.sortMs);
        setSellingOrders(orders);
        setSellingOrdersHydrated(true);
      },
      () => {
        setSellingOrders([]);
        setSellingOrdersHydrated(true);
      }
    );

    return () => {
      unsubscribeListings();
      unsubscribePosts();
      unsubscribeBoughtOrders();
      unsubscribeBoughtListings();
      unsubscribeSoldOrders();
    };
  }, [profile?.bio, profile?.photoURL, profile?.username, user?.uid]);

  useEffect(() => {
    if (!user?.uid) {
      setRealOutfits([]);
      setSavedOutfitItemsById({});
      setOutfitsHydrated(true);
      return;
    }

    let cancelled = false;
    setOutfitsHydrated(false);
    const hydrate = async () => {
      try {
        const local = await loadLocalOutfits(user.uid);
        if (cancelled) return;
        const mapped = local
          .map(mapLocalOutfitItem)
          .filter(Boolean) as GridItem[];
        const itemMap: Record<string, PostGarmentInput[]> = {};
        local.forEach((saved) => {
          const id = String(saved?.id || '').trim();
          if (!id) return;
          const rawItems = Array.isArray(saved?.items) ? saved.items : [];
          itemMap[id] = buildSavedOutfitItems(rawItems);
        });
        setRealOutfits(mapped);
        setSavedOutfitItemsById(itemMap);
      } catch {
        if (cancelled) return;
        setRealOutfits([]);
        setSavedOutfitItemsById({});
      } finally {
        if (!cancelled) setOutfitsHydrated(true);
      }
    };

    void hydrate();
    const unsubscribe = subscribeLocalOutfits(user.uid, () => {
      void hydrate();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [buildSavedOutfitItems, user?.uid]);

  useEffect(() => {
    if (!user?.uid) {
      setLocalListingDrafts([]);
      setDraftsHydrated(true);
      return;
    }

    let cancelled = false;
    setDraftsHydrated(false);
    const hydrate = async () => {
      try {
        const drafts = await loadLocalListingDrafts(user.uid);
        if (cancelled) return;
        setLocalListingDrafts(drafts);
      } catch {
        if (cancelled) return;
        setLocalListingDrafts([]);
      } finally {
        if (!cancelled) setDraftsHydrated(true);
      }
    };

    void hydrate();
    const unsubscribe = subscribeLocalListingDrafts(user.uid, () => {
      void hydrate();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    setClosetHydrated(false);
    loadLocalCloset(user.uid)
      .then((items) => {
        if (cancelled) return;
        setLocalClosetItems(items);
        setClosetHydrated(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLocalClosetItems([]);
        setClosetHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid || !closetHydrated) return;
    void saveLocalCloset(user.uid, localClosetItems).catch((error) => {
      console.warn('[ProfileScreen] failed to persist local closet', error);
    });
  }, [closetHydrated, localClosetItems, user?.uid]);

  useEffect(() => {
    const listingsRef = collection(db, 'listings');
    const listingsQuery = query(listingsRef, limit(200));
    const unsub = onSnapshot(
      listingsQuery,
      (snap) => {
        const items = snap.docs.map((docSnap) => listingDocToItem(docSnap)).filter(Boolean) as ListingItem[];
        setAllListingItems(items);
      },
      () => setAllListingItems([])
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) {
      setRealLikedListings([]);
      setLikedListingProductsByGridId({});
      setLikedListingsHydrated(true);
      return;
    }
    setLikedListingsHydrated(false);
    const likedListingIds = Array.from(
      new Set(
        Array.from(likedIds)
          .map((id) => parseListingLikeDocId(String(id || '')))
          .filter(Boolean) as string[]
      )
    );
    if (!likedListingIds.length) {
      setRealLikedListings([]);
      setLikedListingProductsByGridId({});
      setLikedListingsHydrated(true);
      return;
    }

    let cancelled = false;
    const load = async () => {
      try {
        const chunks = chunk(likedListingIds, 10);
        const out: GridItem[] = [];
        const products: Record<string, ProductLike> = {};
        for (const idsChunk of chunks) {
          const listingsRef = collection(db, 'listings');
          const listingsQuery = query(listingsRef, where(documentId(), 'in', idsChunk));
          const result = await getDocs(listingsQuery);
          result.docs.forEach((docSnap) => {
            const data = docSnap.data() as any;
            const image = extractListingImageFromData(data);
            if (!image) return;
            const gridId = `${LIKED_LISTING_PREFIX}${docSnap.id}`;
            out.push({
              id: gridId,
              listingId: docSnap.id,
              title: String(data?.title || data?.name || 'Listing'),
              uri: image,
              price: typeof data?.price?.amount === 'number' ? Math.round(data.price.amount / 100) : undefined,
              sold: String(data?.status || '').toLowerCase() === 'sold',
            });
            products[gridId] = listingDocToProductLike(docSnap, data, image);
          });
        }
        if (!cancelled) {
          setRealLikedListings(out);
          setLikedListingProductsByGridId(products);
          setLikedListingsHydrated(true);
        }
      } catch {
        if (!cancelled) {
          setRealLikedListings([]);
          setLikedListingProductsByGridId({});
          setLikedListingsHydrated(true);
        }
      }
    };
    void load();

    return () => {
      cancelled = true;
    };
  }, [likedIds, user?.uid]);

  useEffect(() => {
    if (!user) {
      setRealLikedPosts([]);
      setLikedPostPreviewByGridId({});
      setLikedPostsHydrated(true);
      return;
    }
    const likesRef = collection(db, 'users', user.uid, 'postLikes');
    let cancelled = false;
    setLikedPostsHydrated(false);
    const unsubscribe = onSnapshot(likesRef, (snap) => {
      const ids = snap.docs.map((d) => d.id);
      if (!ids.length) {
        setRealLikedPosts([]);
        setLikedPostPreviewByGridId({});
        setLikedPostsHydrated(true);
        return;
      }
      const load = async () => {
        try {
          const chunks = chunk(ids, 10);
          const out: GridItem[] = [];
          const previews: Record<string, CommentScreenPostPreview> = {};
          for (const idsChunk of chunks) {
            const postsRef = collection(db, 'posts');
            const postsQuery = query(postsRef, where(documentId(), 'in', idsChunk));
            const result = await getDocs(postsQuery);
            result.docs.forEach((docSnap) => {
              const data = docSnap.data() as any;
              const uri = extractPostImage(data);
              if (!uri) return;
              const postId = docSnap.id;
              const gridId = `liked-post-${postId}`;
              const authorUid = String(data?.authorUid || user.uid);
              const authorUsername = String(data?.authorUsername || data?.username || 'user');
              const authorAvatar = data?.authorPhotoURL || data?.authorAvatar || null;
              out.push({
                id: gridId,
                uri,
                meta: 'Post',
                title: String(data?.caption || data?.title || 'Post'),
              });
              previews[gridId] = {
                id: postId,
                user: {
                  id: authorUid,
                  username: authorUsername,
                  avatarUri: authorAvatar,
                  bio: data?.authorBio || undefined,
                },
                modelUri: uri,
                caption: typeof data?.caption === 'string' ? data.caption : null,
                likes: Number(data?.likeCount ?? 0) || 0,
                commentCount: Number(data?.commentCount ?? 0) || 0,
                garments: extractPostGarments(data),
              };
            });
          }
          if (!cancelled) {
            setRealLikedPosts(out);
            setLikedPostPreviewByGridId(previews);
            setLikedPostsHydrated(true);
          }
        } catch {
          if (!cancelled) {
            setRealLikedPosts([]);
            setLikedPostPreviewByGridId({});
            setLikedPostsHydrated(true);
          }
        }
      };
      void load();
    }, () => {
      setRealLikedPosts([]);
      setLikedPostPreviewByGridId({});
      setLikedPostsHydrated(true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) {
      setViewerLikedPostIds(new Set());
      setUnreadNotificationCount(0);
      return;
    }
    const unsub = subscribePostLikes(user.uid, (ids) => setViewerLikedPostIds(new Set(ids)));
    return () => unsub();
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) {
      setUnreadNotificationCount(0);
      return;
    }
    void backfillNotifications({ actorUid: user.uid }).catch(() => {});
    const unsub = subscribeUnreadNotificationCount(user.uid, setUnreadNotificationCount);
    return () => unsub();
  }, [user?.uid]);

  return (
    <View style={styles.root}>
      <MinimalHeader
        title="Profile"
        rightIcon="notifications-outline"
        onRightPress={() => nav.navigate({ name: 'notifications' })}
        rightA11yLabel="Open notifications"
        rightBadgeCount={unreadNotificationCount}
        rightTertiaryIcon="bag-outline"
        onTertiaryPress={() => nav.navigate({ name: 'basket' })}
        rightTertiaryA11yLabel="Open basket"
        rightSecondaryIcon="settings-outline"
        onSecondaryPress={() => nav.navigate({ name: 'settings' })}
        rightSecondaryA11yLabel="Open settings"
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bottomPad }}
      >
        {/* Profile Head: avatar left, info right */}
        <View style={{ paddingHorizontal: s(3), marginTop: s(3) }}>
          <ProfileHeader
            avatarUri={profile?.photoURL || undefined}
            name={profile?.username || 'profile'}
            username={profile?.username || 'profile'}
            displayName={profile?.displayName || profile?.username || 'Profile'}
            bio={profile?.bio || ' '}
            stats={{
              listings: realListings.length,
              sold: realSold.length,
              likes: realLikedListings.length + realLikedPosts.length,
            }}
            social={{ followers, following }}
            onPressFollowers={openFollowers}
            onPressFollowing={openFollowing}
            onEdit={openEditProfileModal}
            showShare={false}
          />
        </View>

        {/* Tabs */}
        <View
          style={{
            paddingHorizontal: s(3),
            marginTop: s(4),
          }}
        >
          <SegmentedTabs
            tabs={mainTabs as any}
            activeKey={tab}
            onChange={handleTabChange}
            snapGroupSize={4}
            snapGroupStep={2}
          />
        </View>

        {/* Tab Content */}
        <Animated.View
          style={{
            paddingHorizontal: s(3),
            marginTop: s(4),
            opacity: sectionOpacity,
            transform: [{ translateY: sectionTranslateY }, { scale: sectionScale }],
          }}
        >
          {tab === 'listings' && (
            <>
              <View style={styles.listingsHeaderRow}>
                <Text style={[styles.h2]}>Listings</Text>
                <Pressable style={styles.listingsNewBtn} onPress={openCreateListing}>
                  <Text style={styles.listingsNewBtnTxt}>New listing</Text>
                </Pressable>
              </View>
              <Text style={styles.listingsIntro}>
                Manage your live listings and the drafts saved only on this device.
              </Text>
              <SegmentedChips
                options={listingChips as any}
                value={listingsTab}
                onChange={handleListingsTabChange}
              />

              <View style={styles.listingsStack}>
                {listingsLoading ? (
                  <>
                    {renderListingFilterSkeletons()}
                    {renderListingSkeletonGrid()}
                  </>
                ) : listingsTab === 'active' ? (
                  activeListingManagerItems.length ? (
                    <View style={styles.listingTilesGrid}>
                      {activeListingManagerItems.map((item) => (
                        (() => {
                          const listingId = resolveManagedListingId(item.gridItem);
                          const removing = !!listingId && removingListingId === listingId;
                          return (
                            <Pressable
                              key={item.id}
                              style={({ pressed }) => [
                                styles.listingTile,
                                pressed && !removing && { opacity: 0.9 },
                                removing && { opacity: 0.72 },
                              ]}
                              onPress={() => {
                                if (!removing) openProductForGridItem(item.gridItem);
                              }}
                            >
                              {item.imageUri ? (
                                <CachedImage
                                  source={{ uri: item.imageUri }}
                                  style={styles.listingTileImage}
                                  contentFit="cover"
                                  transition={120}
                                  borderRadius={18}
                                />
                              ) : (
                                <View style={[styles.listingTileImage, styles.listingTileFallback]}>
                                  <Ionicons name="images-outline" size={24} color={colors.textDim} />
                                </View>
                              )}
                              <Pressable
                                style={styles.listingTileOptionBtn}
                                onPress={(event) => {
                                  event.stopPropagation();
                                  if (!removing) openListingActions(item.gridItem);
                                }}
                              >
                                {removing ? (
                                  <ActivityIndicator size="small" color={colors.text} />
                                ) : (
                                  <Ionicons name="ellipsis-horizontal" size={14} color={colors.text} />
                                )}
                              </Pressable>
                            </Pressable>
                          );
                        })()
                      ))}
                    </View>
                  ) : (
                    <View style={styles.listingsEmptyCard}>
                      <Text style={styles.listingsEmptyTitle}>No active listings yet</Text>
                      <Text style={styles.listingsEmptyBody}>
                        Create your first listing from the upload flow, then edit it here any time.
                      </Text>
                    </View>
                  )
                ) : draftListingManagerItems.length ? (
                  <View style={styles.listingTilesGrid}>
                    {draftListingManagerItems.map((item) => (
                      <Pressable
                        key={item.id}
                        style={({ pressed }) => [styles.listingTile, pressed && { opacity: 0.9 }]}
                        onPress={() => resumeDraftListing(item.draft)}
                      >
                        {item.imageUri ? (
                          <CachedImage
                            source={{ uri: item.imageUri }}
                            style={styles.listingTileImage}
                            contentFit="cover"
                            transition={120}
                            borderRadius={18}
                          />
                        ) : (
                          <View style={[styles.listingTileImage, styles.listingTileFallback]}>
                            <Ionicons name="images-outline" size={24} color={colors.textDim} />
                          </View>
                        )}
                        <Pressable
                          style={styles.listingTileOptionBtn}
                          onPress={(event) => {
                            event.stopPropagation();
                            removeDraftListing(item.draft);
                          }}
                        >
                          <Ionicons name="trash-outline" size={14} color={colors.text} />
                        </Pressable>
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <View style={styles.listingsEmptyCard}>
                    <Text style={styles.listingsEmptyTitle}>No drafts saved</Text>
                    <Text style={styles.listingsEmptyBody}>
                      Save a listing draft from the upload screen and it will appear here for later.
                    </Text>
                  </View>
                )}
              </View>
            </>
          )}

          {tab === 'closet' && (
            <ClosetSection
              items={localClosetItems}
              loading={closetLoading}
              skeletonCount={5}
              adding={addingClosetItem}
              onAddPress={openAddClosetSheet}
              onEditItem={openEditClosetTags}
              onOpenItemMenu={openClosetItemMenu}
            />
          )}

          {tab === 'outfits' && (
            <>
              <Text style={[styles.h2]}>Outfits</Text>
              <Text style={styles.outfitsIntro}>
                All your saved try-on outfits will be stored here so you can revisit them anytime.
              </Text>
              <ProfileGrid
                items={combinedOutfits}
                loading={outfitsLoading}
                skeletonCount={PROFILE_GRID_SKELETON_COUNT}
                animateItems={false}
                onPressItem={openOutfitItem}
              />
            </>
          )}

          {tab === 'posts' && (  // ← new section
            <>
              <Text style={[styles.h2]}>Posts</Text>
              <ProfileGrid
                items={combinedPosts}
                loading={postsLoading}
                skeletonCount={PROFILE_GRID_SKELETON_COUNT}
                animateItems={false}
                onPressItem={openPostItem}
              />
            </>
          )}

          {tab === 'likes' && (
            <>
              <View style={{ marginBottom: s(3) }}>
                <SegmentedChips
                  options={likeChips as any}
                  value={likesTab}
                  onChange={handleLikesTabChange}
                />
              </View>
              {likesTab === 'liked_listings' ? (
                <>
                  <Text style={[styles.h2]}>Liked listings</Text>
                  <ProfileGrid
                    items={combinedLikedListings}
                    loading={likesLoading}
                    skeletonCount={PROFILE_GRID_SKELETON_COUNT}
                    animateItems={false}
                    onPressItem={openProductForGridItem}
                  />
                </>
              ) : (
                <>
                  <Text style={[styles.h2]}>Liked posts</Text>
                  <ProfileGrid
                    items={combinedLikedPosts}
                    loading={likesLoading}
                    skeletonCount={PROFILE_GRID_SKELETON_COUNT}
                    animateItems={false}
                    onPressItem={openPostItem}
                  />
                </>
              )}
            </>
          )}

          {tab === 'orders' && (
            <>
              <View style={{ marginBottom: s(3) }}>
                <SegmentedChips
                  options={orderChips as any}
                  value={ordersTab}
                  onChange={handleOrdersTabChange}
                />
              </View>
              <Text style={[styles.h2]}>{ordersTab === 'selling' ? 'Sold orders' : 'Bought orders'}</Text>
              <Text style={styles.ordersIntro}>
                {ordersTab === 'selling'
                  ? 'Track every item you sold and move each order through delivery.'
                  : 'See every item you bought, its order number, and the current delivery status.'}
              </Text>
              {ordersLoading ? renderOrderSkeletons() : activeOrders.length ? (
                <View style={styles.ordersStack}>
                  {activeOrders.map((order) => {
                    const cancelAction =
                      order.orderId && order.canCancel
                        ? getOrderCancellationAction(
                            order.status,
                            ordersTab === 'selling' ? 'seller' : 'buyer'
                          )
                        : null;
                    const isBusy = updatingOrderId === order.orderId;
                    const showCreateSandbox =
                      ordersTab === 'selling' && order.orderId && !order.hasSandboxShipment;
                    const showTrackParcel = Boolean(order.hasSandboxShipment && order.trackingUrl);
                    const showAdvanceSandbox =
                      ordersTab === 'selling' &&
                      order.orderId &&
                      order.hasSandboxShipment &&
                      order.canAdvanceSandbox;
                    const statusTone =
                      order.status === 'completed'
                        ? {
                            backgroundColor: 'rgba(42, 122, 73, 0.12)',
                            borderColor: 'rgba(42, 122, 73, 0.18)',
                            color: '#2a7a49',
                          }
                        : order.status === 'cancelled' ||
                            order.status === 'cancelled_by_buyer' ||
                            order.status === 'cancelled_by_seller'
                          ? {
                              backgroundColor: 'rgba(214, 53, 53, 0.12)',
                              borderColor: 'rgba(214, 53, 53, 0.18)',
                              color: '#bf2d2d',
                            }
                        : order.status === 'delivered'
                          ? {
                              backgroundColor: 'rgba(52, 120, 246, 0.12)',
                              borderColor: 'rgba(52, 120, 246, 0.16)',
                              color: '#2f64d6',
                            }
                          : order.status === 'shipped' || order.status === 'out_for_delivery'
                            ? {
                                backgroundColor: 'rgba(242, 162, 30, 0.14)',
                                borderColor: 'rgba(242, 162, 30, 0.18)',
                                color: '#b66b00',
                              }
                            : {
                                backgroundColor: 'rgba(17, 17, 20, 0.06)',
                                borderColor: colors.borderLight,
                                color: colors.textDim,
                              };
                    return (
                      <Pressable
                        key={order.id}
                        style={({ pressed }) => [styles.orderCard, pressed && { opacity: 0.94 }]}
                        onPress={() => openOrderProduct(order)}
                      >
                        <View style={styles.orderCardInner}>
                          <View style={styles.orderThumbWrap}>
                            {order.imageUri ? (
                              <CachedImage
                                source={{ uri: order.imageUri }}
                                style={styles.orderThumb}
                                contentFit="cover"
                                transition={120}
                                borderRadius={16}
                              />
                            ) : (
                              <View style={[styles.orderThumb, styles.orderThumbFallback]}>
                                <Ionicons name="cube-outline" size={24} color={colors.textDim} />
                              </View>
                            )}
                          </View>

                          <View style={styles.orderContent}>
                            <View style={styles.orderTopRow}>
                              <View style={styles.orderTitleWrap}>
                                <Text style={styles.orderTitle} numberOfLines={2}>
                                  {order.title}
                                </Text>
                                <Text style={styles.orderNumber}>{order.orderNumber}</Text>
                              </View>
                              <View
                                style={[
                                  styles.orderStatusBadge,
                                  {
                                    backgroundColor: statusTone.backgroundColor,
                                    borderColor: statusTone.borderColor,
                                  },
                                ]}
                              >
                                <Text style={[styles.orderStatusTxt, { color: statusTone.color }]}>
                                  {order.statusLabel}
                                </Text>
                              </View>
                            </View>

                            <Text style={styles.orderDescription}>{order.statusDescription}</Text>

                            <View style={styles.orderMetaGrid}>
                              {order.priceLabel ? (
                                <View style={styles.orderMetaRow}>
                                  <Text style={styles.orderMetaLabel}>Total</Text>
                                  <Text style={[styles.orderMetaValue, styles.orderMetaValueStrong]}>
                                    {order.priceLabel}
                                  </Text>
                                </View>
                              ) : null}
                              {order.purchasedAtLabel ? (
                                <View style={styles.orderMetaRow}>
                                  <Text style={styles.orderMetaLabel}>Ordered</Text>
                                  <Text style={styles.orderMetaValue}>{order.purchasedAtLabel}</Text>
                                </View>
                              ) : null}
                              {order.shippingPaidLabel ? (
                                <View style={styles.orderMetaRow}>
                                  <Text style={styles.orderMetaLabel}>Shipping paid</Text>
                                  <Text style={styles.orderMetaValue}>{order.shippingPaidLabel}</Text>
                                </View>
                              ) : null}
                              {order.parcelProfileLabel ? (
                                <View style={styles.orderMetaRow}>
                                  <Text style={styles.orderMetaLabel}>Parcel size</Text>
                                  <Text style={styles.orderMetaValue}>{order.parcelProfileLabel}</Text>
                                </View>
                              ) : null}
                              {order.shippingName ? (
                                <View style={styles.orderMetaRow}>
                                  <Text style={styles.orderMetaLabel}>
                                    {ordersTab === 'selling' ? 'Ship to' : 'Deliver to'}
                                  </Text>
                                  <Text style={[styles.orderMetaValue, styles.orderMetaValueStrong]}>
                                    {order.shippingName}
                                  </Text>
                                </View>
                              ) : null}
                              {order.shippingAddressLabel ? (
                                <View style={styles.orderMetaRow}>
                                  <Text style={styles.orderMetaLabel}>Address</Text>
                                  <Text style={styles.orderMetaValue}>{order.shippingAddressLabel}</Text>
                                </View>
                              ) : null}
                              {order.shippingQuoteLabel ? (
                                <View style={styles.orderMetaRow}>
                                  <Text style={styles.orderMetaLabel}>Shipping method</Text>
                                  <Text style={styles.orderMetaValue}>{order.shippingQuoteLabel}</Text>
                                </View>
                              ) : null}
                              {order.trackingCode ? (
                                <View style={styles.orderMetaRow}>
                                  <Text style={styles.orderMetaLabel}>Tracking</Text>
                                  <Text style={[styles.orderMetaValue, styles.orderMetaValueStrong]}>
                                    {order.trackingCode}
                                  </Text>
                                </View>
                              ) : null}
                              {order.trackingPhaseLabel ? (
                                <View style={styles.orderMetaRow}>
                                  <Text style={styles.orderMetaLabel}>Shipment</Text>
                                  <Text style={styles.orderMetaValue}>{order.trackingPhaseLabel}</Text>
                                </View>
                              ) : null}
                              {ordersTab === 'selling' && showCreateSandbox && !sellerAddressComplete ? (
                                <View style={styles.orderMetaRow}>
                                  <Text style={styles.orderMetaLabel}>Sender</Text>
                                  <Text style={styles.orderMetaValue}>
                                    Complete your delivery address in Settings to create a ShippingCo sandbox shipment.
                                  </Text>
                                </View>
                              ) : null}
                            </View>

                            {(cancelAction ||
                              showCreateSandbox ||
                              showTrackParcel ||
                              showAdvanceSandbox) ? (
                              <View style={styles.orderActionsRow}>
                                {cancelAction ? (
                                  <Pressable
                                    style={({ pressed }) => [
                                      styles.orderActionBtnDanger,
                                      pressed && !isBusy && { opacity: 0.92 },
                                      isBusy && { opacity: 0.75 },
                                    ]}
                                    onPress={(event) => {
                                      event.stopPropagation();
                                      confirmCancelOrder(
                                        order,
                                        ordersTab === 'selling' ? 'seller' : 'buyer'
                                      );
                                    }}
                                    disabled={isBusy}
                                  >
                                    <Text style={styles.orderActionBtnDangerTxt}>
                                      {cancelAction.label}
                                    </Text>
                                  </Pressable>
                                ) : null}

                                {showCreateSandbox ? (
                                  <Pressable
                                    style={({ pressed }) => [
                                      styles.orderActionBtn,
                                      pressed && !isBusy && { opacity: 0.92 },
                                      isBusy && { opacity: 0.75 },
                                    ]}
                                    onPress={(event) => {
                                      event.stopPropagation();
                                      if (!sellerAddressComplete) {
                                        nav.navigate({ name: 'settings' });
                                        return;
                                      }
                                      void createSellingOrderSandbox(order);
                                    }}
                                    disabled={isBusy}
                                  >
                                    {isBusy ? (
                                      <ActivityIndicator size="small" color={isDark ? colors.bg : '#fff'} />
                                    ) : (
                                      <Text style={styles.orderActionBtnTxt}>
                                        {sellerAddressComplete ? 'Create ShippingCo Sandbox' : 'Open Settings'}
                                      </Text>
                                    )}
                                  </Pressable>
                                ) : null}

                                {showTrackParcel ? (
                                  <Pressable
                                    style={({ pressed }) => [
                                      styles.orderActionBtn,
                                      pressed && !isBusy && { opacity: 0.92 },
                                      isBusy && { opacity: 0.75 },
                                    ]}
                                    onPress={(event) => {
                                      event.stopPropagation();
                                      void openOrderTracking(order);
                                    }}
                                    disabled={isBusy}
                                  >
                                    <Text style={styles.orderActionBtnTxt}>Track Parcel</Text>
                                  </Pressable>
                                ) : null}

                                {showAdvanceSandbox ? (
                                  <Pressable
                                    style={({ pressed }) => [
                                      styles.orderActionBtn,
                                      pressed && !isBusy && { opacity: 0.92 },
                                      isBusy && { opacity: 0.75 },
                                    ]}
                                    onPress={(event) => {
                                      event.stopPropagation();
                                      void advanceSellingOrder(order);
                                    }}
                                    disabled={isBusy}
                                  >
                                    {isBusy ? (
                                      <ActivityIndicator size="small" color={isDark ? colors.bg : '#fff'} />
                                    ) : (
                                      <Text style={styles.orderActionBtnTxt}>Advance Now</Text>
                                    )}
                                  </Pressable>
                                ) : null}
                              </View>
                            ) : null}
                          </View>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <View style={styles.ordersEmptyCard}>
                  <Text style={styles.ordersEmptyTitle}>
                    {ordersTab === 'selling' ? 'No sold orders yet' : 'No bought orders yet'}
                  </Text>
                  <Text style={styles.ordersEmptyBody}>
                    {ordersTab === 'selling'
                      ? 'When someone buys one of your listings, the order will appear here with simple delivery controls.'
                      : 'Once you buy a listing, you will be able to track its status here from purchase through completion.'}
                  </Text>
                </View>
              )}
            </>
          )}
        </Animated.View>
      </ScrollView>

      <FollowListModal
        visible={!!followMode}
        mode={followMode || 'followers'}
        targetUid={user?.uid || ''}
        viewerUid={user?.uid}
        isOwner
        onClose={closeFollowModal}
        onSelectUser={handleSelectUser}
      />

      <PostCommentsScreen
        visible={Boolean(activeCommentsPost)}
        post={activeCommentsPost}
        viewerUid={user?.uid || null}
        viewerUsername={profile?.username || ''}
        viewerPhotoURL={profile?.photoURL || ''}
        viewerLikedPost={activeCommentsPost ? viewerLikedPostIds.has(activeCommentsPost.id) : false}
        followingIds={[]}
        knownUsers={knownUsers}
        onOpenUser={handleOpenUserFromComments}
        onOpenProduct={(product) => {
          setActiveProduct(product);
          setActiveProductId(product.id || null);
          setProductModalOpen(true);
        }}
        onCountChange={handleCommentsCountChange}
        onClose={() => setActiveCommentsPost(null)}
      />

      <ResultModal
        visible={Boolean(activeOutfitUri)}
        afterUri={activeOutfitUri}
        savedOutfitId={activeOutfitId}
        savedOutfitItems={activeOutfitItems}
        resolveUsedItemProduct={resolveUsedOutfitItemProduct}
        getUsedItemInitialLiked={(product) => isListingLiked(product?.id || null, product?.listingId)}
        onUsedItemLikeChange={(liked, product) => {
          if (product?.id) setListingLiked(product.id, liked, product.listingId);
        }}
        onClose={() => {
          outfitLookupSeqRef.current += 1;
          setActiveOutfitUri(null);
          setActiveOutfitId(null);
          setActiveOutfitItems([]);
        }}
      />

      <ProductModal
        visible={productModalOpen}
        onClose={() => setProductModalOpen(false)}
        product={activeProduct}
        initialLiked={isListingLiked(activeProductId, activeProduct?.listingId)}
        onLikeChange={(liked, product) => {
          if (product?.id) setListingLiked(product.id, liked, product.listingId);
        }}
      />

      <Modal
        visible={editProfileModalOpen}
        transparent
        animationType="none"
        onRequestClose={closeEditProfileModal}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFillObject,
              {
                backgroundColor: 'rgba(0,0,0,0.34)',
                opacity: editProfileAnim,
              },
            ]}
          />
          <Pressable style={{ flex: 1 }} onPress={closeEditProfileModal} />
          <Animated.View
            style={[
              styles.editSheet,
              {
                opacity: editProfileAnim,
                transform: [{ translateY: editSheetTranslateY }],
              },
            ]}
          >
            <View style={styles.editHeader}>
              <Text style={styles.editTitle}>Edit profile</Text>
              <Pressable style={styles.editCloseBtn} onPress={closeEditProfileModal} disabled={savingProfileEdit}>
                <Ionicons name="close" size={18} color={colors.text} />
              </Pressable>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: s(1.8) }}>
              <View style={styles.profilePhotoRow}>
                <View style={styles.profilePhotoShell}>
                  <UserAvatar
                    uri={profilePhotoDraftUri || profile?.photoURL || undefined}
                    size={s(10)}
                    style={styles.profilePhotoImage}
                  />
                </View>
                <Pressable style={styles.profilePhotoAction} onPress={pickProfilePhoto} disabled={savingProfileEdit}>
                  <Text style={styles.profilePhotoActionTxt}>Change photo</Text>
                </Pressable>
              </View>
              <Text style={styles.profileHelpTxt}>Profile photo, username, display name, and bio are public.</Text>

              <View style={styles.fieldWrap}>
                <Text style={styles.fieldLabel}>Username</Text>
                <TextInput
                  value={profileUsernameDraft}
                  onChangeText={setProfileUsernameDraft}
                  placeholder="username"
                  placeholderTextColor={colors.textDim}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.input}
                />
              </View>

              <View style={styles.fieldWrap}>
                <Text style={styles.fieldLabel}>Display name</Text>
                <TextInput
                  value={profileDisplayNameDraft}
                  onChangeText={setProfileDisplayNameDraft}
                  placeholder="Display name"
                  placeholderTextColor={colors.textDim}
                  style={styles.input}
                />
              </View>

              <View style={styles.fieldWrap}>
                <Text style={styles.fieldLabel}>Bio</Text>
                <TextInput
                  value={profileBioDraft}
                  onChangeText={setProfileBioDraft}
                  placeholder="Tell people about your style"
                  placeholderTextColor={colors.textDim}
                  multiline
                  maxLength={200}
                  style={[styles.input, styles.inputMultiline]}
                />
                <Text style={styles.profileBioMeta}>{profileBioDraft.length}/200</Text>
              </View>
            </ScrollView>

            <View style={styles.actionsRow}>
              <Pressable style={styles.actionBtn} onPress={closeEditProfileModal} disabled={savingProfileEdit}>
                <Text style={styles.actionTxt}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.actionBtn,
                  styles.actionPrimary,
                  (!canSaveProfileEdit || savingProfileEdit) && { opacity: 0.7 },
                ]}
                onPress={saveProfileEdit}
                disabled={!canSaveProfileEdit || savingProfileEdit}
              >
                {savingProfileEdit ? (
                  <ActivityIndicator size="small" color={isDark ? colors.bg : '#fff'} />
                ) : (
                  <Text style={styles.actionPrimaryTxt}>Save</Text>
                )}
              </Pressable>
            </View>
          </Animated.View>
        </KeyboardAvoidingView>
      </Modal>

      <ClosetEditorModal
        visible={closetTagModalOpen}
        editingItem={editingClosetItem}
        saving={savingClosetEdit}
        categories={CLOSET_CATEGORIES}
        categoryDraft={closetCategoryDraft}
        brandDraft={closetBrandDraft}
        colorDraft={closetColorDraft}
        tagDraft={closetTagDraft}
        suggestedTags={closetSuggestedTags}
        draftTags={draftClosetTags}
        onClose={closeClosetTagModal}
        onSetCategoryDraft={setClosetCategoryDraft}
        onSetBrandDraft={setClosetBrandDraft}
        onSetColorDraft={setClosetColorDraft}
        onSetTagDraft={setClosetTagDraft}
        onToggleSuggestedTag={toggleClosetSuggestedTag}
        onClearTags={clearClosetDraftTags}
        onRemove={removeClosetItem}
        onSave={submitClosetTagUpdate}
      />

    </View>
  );
}
