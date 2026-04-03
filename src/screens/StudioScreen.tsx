import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  Pressable,
  StyleSheet as RNStyleSheet,
  Image,
  Alert,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { collection, query, limit, where, getDocs } from 'firebase/firestore';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import MinimalHeader from '../components/MinimalHeader';
import VisionSheet from '../components/Vision/VisionSheet';
import type { VisionPoolItem, VisionSlot } from '../components/Vision/visionEngine';
import {
  startTryOnProgress,
  stepTryOnProgress,
  completeTryOnProgress,
  subscribeTryOnPress,
  subscribeTryOnProgress,
  getTryOnProgress,
  resetTryOnProgress,
} from '../data/tryOnProgress';
import { font, hairline, s } from '../theme/tokens';
import ResultModal from '../components/ResultModal';
import { callTryOn } from '../components/studio/TryOnClient';
import ClothingSelectorModal, { GarmentMap } from '../components/studio/ClothingSelectorModal';
import {
  recommendFromPromptDetailed,
  type RecommendationItem,
  type RecommendationPools,
  type RecommendationSelection,
} from '../utils/localRecommender';
import { ensureAssetUri } from '../data/assets';
import { consumeStoredTryOnSelection, consumeTryOnSelection, subscribeTryOnSelection, type TryOnSelection } from '../tryon/selection';
import { useTheme } from '../theme/ThemeContext';
import { pressFeedback } from '../theme/pressFeedback';
import { db } from '../lib/firebase';
import { listingDocToItem, listingItemToProduct, type ListingItem } from '../lib/firestoreMappers';
import { mock, type Item } from '../data/mock';
import { useAuth } from '../context/AuthContext';
import type { PostGarmentInput } from '../lib/firebasePosts';
import { loadLocalCloset, upsertLocalClosetEmbedding } from '../lib/localCloset';
import { embedLocalClosetItem } from '../lib/localClosetEmbeddings';
import { type ProductLike } from '../components/ProductModal';
import { useListingLikes } from '../lib/listingLikes';

const { width: W, height: H } = Dimensions.get('window');
const STORAGE_KEY = 'feed.model.uri';
const DEFAULT_SELFIE_MAX = 1600;
const DEFAULT_GARMENT_MAX = 1400;
const DEBUG_PROMPT = __DEV__;
const TRYON_CACHE_DIR = `${FileSystem.cacheDirectory}tryon/`;
const MODEL_STORAGE_DIR = `${FileSystem.documentDirectory || ''}studio-model/`;
const MODEL_STORAGE_FILE = `${MODEL_STORAGE_DIR}selected-model.jpg`;

async function ensureTryOnCacheDir() {
  try {
    await FileSystem.makeDirectoryAsync(TRYON_CACHE_DIR, { intermediates: true });
  } catch {
    // no-op
  }
}

function hash36(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

async function toLocalFile(uri: string): Promise<string> {
  if (!uri) throw new Error('Missing image URI');
  if (uri.startsWith('file://') || uri.startsWith('content://')) return uri;
  if (uri.startsWith('data:')) {
    await ensureTryOnCacheDir();
    const ext = uri.startsWith('data:image/png') ? 'png' : 'jpg';
    const name = `data_${hash36(uri.slice(0, 120))}.${ext}`;
    const dest = `${TRYON_CACHE_DIR}${name}`;
    const info = await FileSystem.getInfoAsync(dest);
    if (info.exists) return info.uri;
    const b64 = uri.split(',')[1] || '';
    await FileSystem.writeAsStringAsync(dest, b64, { encoding: 'base64' });
    return dest;
  }
  if (/^https?:\/\//i.test(uri)) {
    await ensureTryOnCacheDir();
    const ext =
      /\.png(?:\?|$)/i.test(uri) ? 'png' :
      /\.(jpg|jpeg)(?:\?|$)/i.test(uri) ? 'jpg' :
      /\.webp(?:\?|$)/i.test(uri) ? 'webp' :
      /\.avif(?:\?|$)/i.test(uri) ? 'avif' : 'img';
    const name = `dl_${hash36(uri)}.${ext}`;
    const dest = `${TRYON_CACHE_DIR}${name}`;
    const info = await FileSystem.getInfoAsync(dest);
    if (info.exists) return info.uri;
    const res = await FileSystem.downloadAsync(uri, dest);
    return res.uri;
  }
  return uri;
}

async function ensureModelStorageDir() {
  if (!MODEL_STORAGE_DIR) return;
  try {
    await FileSystem.makeDirectoryAsync(MODEL_STORAGE_DIR, { intermediates: true });
  } catch {
    // no-op
  }
}

async function persistModelImage(uri: string): Promise<string> {
  if (!uri) throw new Error('Missing model URI');
  await ensureModelStorageDir();
  const sourceUri = await toLocalFile(uri);
  const normalized = await ImageManipulator.manipulateAsync(sourceUri, [], {
    compress: 0.92,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  try {
    await FileSystem.deleteAsync(MODEL_STORAGE_FILE, { idempotent: true });
  } catch {
    // no-op
  }
  await FileSystem.copyAsync({ from: normalized.uri, to: MODEL_STORAGE_FILE });
  return MODEL_STORAGE_FILE;
}

async function removePersistedModelImage(uri?: string | null) {
  const target = String(uri || '').trim();
  if (!target || !MODEL_STORAGE_DIR) return;
  if (!target.startsWith(MODEL_STORAGE_DIR)) return;
  try {
    await FileSystem.deleteAsync(target, { idempotent: true });
  } catch {
    // no-op
  }
}

type GarmentKey = keyof GarmentMap;
const LAYER_PRIORITY: GarmentKey[] = ['shoes', 'bottom', 'top'];
const PROMPT_STOPWORDS = new Set([
  'the', 'and', 'with', 'for', 'a', 'an', 'to', 'of', 'in', 'on', 'my', 'your',
  'fit', 'outfit', 'look', 'style', 'wear', 'want', 'like', 'me', 'please',
]);
const ALL_PROMPT_SLOTS: GarmentKey[] = ['top', 'bottom', 'mono', 'shoes'];
const PROMPT_SLOT_KEYWORDS: Record<GarmentKey, string[]> = {
  top: [
    'top',
    'shirt',
    't shirt',
    'tshirt',
    'tee',
    'hoodie',
    'crewneck',
    'sweater',
    'jacket',
    'coat',
    'blazer',
    'jersey',
    'polo',
  ],
  bottom: [
    'bottom',
    'jeans',
    'denim',
    'pants',
    'trousers',
    'shorts',
    'cargo',
    'cargos',
    'joggers',
    'leggings',
    'skirt',
    'skort',
    'culottes',
    'fleece pants',
  ],
  mono: ['dress', 'gown', 'jumpsuit', 'romper', 'slip dress', 'maxi dress', 'mini dress'],
  shoes: [
    'shoe',
    'shoes',
    'sneaker',
    'sneakers',
    'trainer',
    'trainers',
    'boot',
    'boots',
    'loafer',
    'loafers',
    'heel',
    'heels',
    'sandals',
  ],
};
const OUTFIT_PROMPT_HINTS = [
  'outfit',
  'fit',
  'look',
  'style me',
  'style this',
  'complete the look',
  'what goes with',
  'build around',
  'build me',
];

type PromptSlotPlan = {
  explicitSlots: Set<GarmentKey>;
  slotsToResolve: Set<GarmentKey>;
  hasOutfitCue: boolean;
};

function computeLayerOrder(garments: GarmentMap): GarmentKey[] {
  if (garments.mono) {
    const layered: GarmentKey[] = [];
    if (garments.shoes) layered.push('shoes');
    layered.push('mono');
    return layered;
  }
  return LAYER_PRIORITY.filter((key) => Boolean(garments[key]));
}

function stripDataUri(dataUri?: string | null) {
  if (!dataUri) return '';
  const match = String(dataUri).match(/^data:\w+\/[\w.+-]+;base64,(.+)$/i);
  return match ? match[1] : dataUri;
}

function normalizeText(value: string) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUri(value?: string | null) {
  if (!value) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .split('?')[0];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesPromptKeyword(text: string, keyword: string) {
  if (!text || !keyword) return false;
  const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
  return pattern.test(text);
}

function tokenizePrompt(prompt: string) {
  return normalizeText(prompt)
    .split(' ')
    .filter((token) => token && token.length > 1 && !PROMPT_STOPWORDS.has(token));
}

function inferPromptSlotPlan(prompt: string): PromptSlotPlan {
  const normalizedPrompt = normalizeText(prompt);
  const explicitSlots = new Set<GarmentKey>();

  const hasMonoCue =
    PROMPT_SLOT_KEYWORDS.mono.some((keyword) => matchesPromptKeyword(normalizedPrompt, keyword)) &&
    !/\bdress (shirt|pants|shoes|sock|socks)\b/i.test(normalizedPrompt);

  if (hasMonoCue) {
    explicitSlots.add('mono');
  }

  (['top', 'bottom', 'shoes'] as GarmentKey[]).forEach((slot) => {
    if (PROMPT_SLOT_KEYWORDS[slot].some((keyword) => matchesPromptKeyword(normalizedPrompt, keyword))) {
      explicitSlots.add(slot);
    }
  });

  if (explicitSlots.has('mono')) {
    explicitSlots.delete('top');
    explicitSlots.delete('bottom');
  }

  const hasOutfitCue = OUTFIT_PROMPT_HINTS.some((keyword) =>
    matchesPromptKeyword(normalizedPrompt, keyword)
  );

  const slotsToResolve =
    explicitSlots.size > 0 && !hasOutfitCue
      ? new Set(explicitSlots)
      : new Set<GarmentKey>(ALL_PROMPT_SLOTS);

  return {
    explicitSlots,
    slotsToResolve,
    hasOutfitCue,
  };
}

function promptHasCompoundItemCue(prompt: string) {
  const normalizedPrompt = normalizeText(prompt);
  return /\b(and|with|plus)\b/.test(normalizedPrompt) || normalizedPrompt.includes('&') || normalizedPrompt.includes(',');
}

function requestedFormToSlots(value?: string | null): Set<GarmentKey> {
  const requestedForm = String(value || '').trim().toLowerCase();
  const slots = new Set<GarmentKey>();
  if (!requestedForm) return slots;
  if (requestedForm.includes('top')) slots.add('top');
  if (requestedForm.includes('bottom')) slots.add('bottom');
  if (requestedForm.includes('shoes')) slots.add('shoes');
  if (requestedForm.includes('mono')) slots.add('mono');
  if (slots.has('mono')) {
    slots.delete('top');
    slots.delete('bottom');
  }
  return slots;
}

function backendInferredPromptSlots(
  backendIntent: Record<string, any> | null | undefined,
  selection: RecommendationSelection | null | undefined,
  pools: RecommendationPools | null | undefined
) {
  const slots = requestedFormToSlots(String(backendIntent?.requested_form || ''));
  (Object.keys(selection || {}) as GarmentKey[]).forEach((slot) => slots.add(slot));
  (Object.keys(pools || {}) as GarmentKey[]).forEach((slot) => {
    if ((pools?.[slot] || []).length) slots.add(slot);
  });
  if (slots.has('mono')) {
    slots.delete('top');
    slots.delete('bottom');
  }
  return slots;
}

function roleForGarmentKey(key: GarmentKey) {
  if (key === 'mono') return 'dress';
  return key;
}

function roleToGarmentKey(role?: Item['role'] | null): GarmentKey | null {
  if (role === 'top' || role === 'bottom' || role === 'shoes') return role;
  if (role === 'dress') return 'mono';
  return null;
}

function visionSlotToGarmentKey(slot: VisionSlot): GarmentKey | null {
  if (slot === 'top' || slot === 'bottom' || slot === 'mono' || slot === 'shoes') return slot;
  return null;
}

function resolveVisionItemImage(item: VisionPoolItem): string | null {
  const direct = String(item?.image || '').trim();
  if (direct) return direct;
  const gallery = Array.isArray((item as any)?.images) ? ((item as any).images as string[]) : [];
  return String(gallery[0] || '').trim() || null;
}

function inferRoleFromCategory(value?: string | null) {
  const v = String(value || '').toLowerCase();
  if (v.includes('top')) return 'top';
  if (v.includes('bottom')) return 'bottom';
  if (v.includes('dress') || v.includes('mono')) return 'dress';
  if (v.includes('shoe') || v.includes('footwear') || v.includes('sneaker') || v.includes('boot') || v.includes('heel')) {
    return 'shoes';
  }
  return undefined;
}

function closetCategoryToRole(value?: string | null): Item['role'] | undefined {
  const inferred = inferRoleFromCategory(value);
  if (inferred === 'top' || inferred === 'bottom' || inferred === 'dress' || inferred === 'shoes') {
    return inferred;
  }
  return undefined;
}

function toTitleCaseWords(value: string) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function buildClosetItemTitle(raw: {
  category?: string | null;
  brand?: string | null;
  tags?: string[];
}) {
  const preferredTag = Array.isArray(raw.tags) ? raw.tags.find((tag) => String(tag || '').trim()) : '';
  if (preferredTag) return toTitleCaseWords(preferredTag);
  const brand = String(raw.brand || '').trim();
  const category = String(raw.category || '').trim();
  const merged = [brand, category].filter(Boolean).join(' ');
  if (merged) return toTitleCaseWords(merged);
  return 'Closet Item';
}

function isListingItem(item: Item | ListingItem) {
  return (item as any)?.source === 'listing' || String(item?.id || '').startsWith('listing:');
}

function parseListingId(value?: string | null) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('listing:')) return raw.slice('listing:'.length);
  if (raw.startsWith('real-listing-')) return raw.slice('real-listing-'.length);
  if (raw.startsWith('liked-listing:')) return raw.slice('liked-listing:'.length);
  if (/^[A-Za-z0-9_-]{20,}$/.test(raw)) return raw;
  return null;
}

function isClosetItem(item: Item | ListingItem | null | undefined) {
  if (!item) return false;
  return (item as any)?.source === 'closet' || String((item as any)?.id || '').startsWith('closet:');
}

function sexPreferenceToGenderPref(value?: string | null): 'any' | 'men' | 'women' {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'male') return 'men';
  if (raw === 'female') return 'women';
  if (raw === 'all' || raw === 'unisex') return 'any';
  return 'any';
}

function normalizeGenderValue(value?: string | null): 'men' | 'women' | 'any' | null {
  const raw = normalizeText(String(value || ''));
  if (!raw) return null;
  if (/(^| )any( |$)|\bunisex\b|\ball\b|\bgender neutral\b/.test(raw)) return 'any';
  if (/\bmen\b|\bman\b|\bmale\b|\bboy\b|\bboys\b/.test(raw)) return 'men';
  if (/\bwomen\b|\bwoman\b|\bfemale\b|\bgirl\b|\bgirls\b|\blad(y|ies)\b/.test(raw)) return 'women';
  return null;
}

function inferItemGender(item: Item | ListingItem | null | undefined): 'men' | 'women' | 'any' | null {
  if (!item) return null;
  const fromMeta = normalizeGenderValue((item as any)?.meta?.gender);
  if (fromMeta) return fromMeta;
  const fromField = normalizeGenderValue((item as any)?.gender);
  if (fromField) return fromField;

  const textParts: string[] = [
    String(item.title || ''),
    String((item as any)?.category || ''),
    String((item as any)?.brand || ''),
  ];
  if (Array.isArray((item as any)?.tags)) {
    textParts.push((item as any).tags.join(' '));
  }
  if (Array.isArray((item as any)?.entities)) {
    textParts.push((item as any).entities.join(' '));
  }
  const inferred = normalizeGenderValue(textParts.join(' '));
  if (inferred === 'any') {
    const semantic = normalizeText(textParts.join(' '));
    if (/\bpump|pumps|heel|heels|stiletto|stilettos|slingback|slingbacks|mary jane|mary janes|kitten heel|kitten heels|bralette|corset|camisole|blouse\b/.test(semantic)) {
      return 'women';
    }
    if (/\blegging|leggings|tights|stockings|hosiery|jeggings\b/.test(semantic)) {
      return 'women';
    }
    if (/\bmenswear|workwear|boxy fit|field jacket|combat boot|cargo trousers\b/.test(semantic)) {
      return 'men';
    }
  }
  return inferred;
}

function matchesGenderPreference(
  item: Item | ListingItem | null | undefined,
  genderPref: 'any' | 'men' | 'women'
) {
  if (!item || genderPref === 'any') return true;
  const inferred = inferItemGender(item);
  if (!inferred) return false;
  if (inferred === 'any') return true;
  return inferred === genderPref;
}

function recommendationMetaTags(meta: RecommendationItem['meta'] | undefined): string[] {
  if (!meta || typeof meta !== 'object') return [];
  return Array.from(
    new Set(
      [
        ...(Array.isArray(meta.occasion_tags) ? meta.occasion_tags : []),
        ...(Array.isArray(meta.style_markers) ? meta.style_markers : []),
        ...(Array.isArray(meta.vibes) ? meta.vibes : []),
        ...(Array.isArray(meta.entities) ? meta.entities : []),
        ...(Array.isArray(meta.colours) ? meta.colours : []),
        String(meta.sub || ''),
      ]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );
}

function recommendationMetaGender(meta: RecommendationItem['meta'] | undefined): 'men' | 'women' | 'any' | null {
  if (!meta || typeof meta !== 'object') return null;
  return normalizeGenderValue(String(meta.gender || ''));
}

function formatRecommendationDebugItem(item: {
  id?: string | null;
  title?: string | null;
  gender?: string | null;
} | null | undefined) {
  if (!item) return null;
  return {
    id: String(item.id || '').trim() || null,
    title: String(item.title || '').trim() || null,
    gender: String(item.gender || '').trim() || null,
  };
}

function choosePromptBandCandidate<T extends { score: number }>(
  scored: T[],
  opts?: {
    maxBandSize?: number;
    relativeFloor?: number;
    absoluteDrop?: number;
  }
): T | null {
  if (!scored.length) return null;
  const bestScore = scored[0]?.score || 0;
  if (bestScore <= 0) return null;
  const relativeFloor = opts?.relativeFloor ?? 0.88;
  const absoluteDrop = opts?.absoluteDrop ?? 0.75;
  const maxBandSize = Math.max(1, opts?.maxBandSize ?? 4);
  const floor = Math.max(bestScore * relativeFloor, bestScore - absoluteDrop);
  const band = scored.filter((entry) => entry.score >= floor).slice(0, maxBandSize);
  if (!band.length) return scored[0] || null;
  return band[Math.floor(Math.random() * band.length)] || band[0] || null;
}

export default function FeedScreen() {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { user, profile } = useAuth();
  const { isLiked: isListingLiked, setLiked: setListingLiked } = useListingLikes(user?.uid);
  const [modelUri, setModelUri] = useState<string | null>(null);
  const [garments, setGarments] = useState<GarmentMap>({
    top: null,
    bottom: null,
    mono: null,
    shoes: null,
  });
  const [closetAnchorSlots, setClosetAnchorSlots] = useState<Set<GarmentKey>>(new Set());
  const [genderPref, setGenderPref] = useState<'any' | 'men' | 'women'>('any');
  const [tryOnBusy, setTryOnBusy] = useState(false);
  const [recommendBusy, setRecommendBusy] = useState(false);
  const [resultVisible, setResultVisible] = useState(false);
  const [resultDataUri, setResultDataUri] = useState<string | null>(null);
  const [resultPostGarments, setResultPostGarments] = useState<PostGarmentInput[]>([]);
  const [tryOnError, setTryOnError] = useState<string | null>(null);
  const [clothingModalVisible, setClothingModalVisible] = useState(false);
  const [visionVisible, setVisionVisible] = useState(false);
  const [listingItems, setListingItems] = useState<ListingItem[]>([]);
  const [myListingItems, setMyListingItems] = useState<ListingItem[]>([]);
  const [closetSelectorItems, setClosetSelectorItems] = useState<Item[]>([]);
  const [promptRecommendations, setPromptRecommendations] = useState<
    Partial<Record<GarmentKey, Item[]>>
  >({});
  const [deferredPromptPools, setDeferredPromptPools] = useState<RecommendationPools | null>(null);
  const lastPromptRef = useRef<string | null>(null);
  const lastPromptTokensRef = useRef<string[]>([]);
  const lastPromptSlotPlanRef = useRef<PromptSlotPlan>({
    explicitSlots: new Set<GarmentKey>(),
    slotsToResolve: new Set<GarmentKey>(ALL_PROMPT_SLOTS),
    hasOutfitCue: false,
  });
  const lastSelectionRef = useRef<RecommendationSelection | null>(null);
  const [pillVisible, setPillVisible] = useState<boolean>(() => {
    try { return getTryOnProgress().visible; }
    catch { return false; }
  });

  useEffect(() => {
    setGenderPref(sexPreferenceToGenderPref(profile?.sexPreference));
  }, [profile?.sexPreference]);

  useEffect(() => {
    setClosetAnchorSlots(new Set());
  }, [user?.uid]);

  const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);

  const garmentLayerOrder = useMemo(() => computeLayerOrder(garments), [garments]);
  const hasGarmentSelection = garmentLayerOrder.length > 0;

  const canTryOn = !!modelUri && hasGarmentSelection && !tryOnBusy;

  const applySelection = useCallback((selection: TryOnSelection) => {
    console.log('[Studio] applySelection', selection);
    setGarments((prev) => {
      const next: GarmentMap = { ...prev };
      const g = selection.garments;
      const hasMono = g.mono !== undefined && g.mono !== null;
      const hasSplit = g.top !== undefined || g.bottom !== undefined;

      if (hasMono) {
        next.mono = g.mono ?? null;
        if (g.mono) {
          next.top = null;
          next.bottom = null;
        }
      }

      if (g.top !== undefined) {
        next.top = g.top;
        if (!hasMono) next.mono = null;
      }

      if (g.bottom !== undefined) {
        next.bottom = g.bottom;
        if (!hasMono) next.mono = null;
      }

      if (g.shoes !== undefined) {
        next.shoes = g.shoes;
      }

      return next;
    });

    if (selection.openSelector) {
      console.log('[Studio] opening clothing selector');
      setClothingModalVisible(true);
    }
  }, []);

  // ─── Load saved model photo ───
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = (await AsyncStorage.getItem(STORAGE_KEY))?.trim();
        if (!saved) return;
        const info = await FileSystem.getInfoAsync(saved);
        if (info.exists) {
          if (!cancelled) setModelUri(saved);
          return;
        }

        // Migration path for older ephemeral URIs: persist into document storage.
        try {
          const persisted = await persistModelImage(saved);
          await AsyncStorage.setItem(STORAGE_KEY, persisted);
          if (!cancelled) setModelUri(persisted);
        } catch {
          await AsyncStorage.removeItem(STORAGE_KEY);
          if (!cancelled) setModelUri(null);
        }
      } catch {
        if (!cancelled) setModelUri(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const listingsRef = collection(db, 'listings');
    const allListingsQuery = query(listingsRef, limit(120));
    const myListingsQuery = user
      ? query(listingsRef, where('sellerUid', '==', user.uid), limit(120))
      : null;

    const mapListingDocs = (docs: Array<any>) =>
      docs.map((doc) => listingDocToItem(doc)).filter(Boolean) as ListingItem[];

    const loadListings = async () => {
      try {
        const [allSnap, mySnap] = await Promise.all([
          getDocs(allListingsQuery),
          myListingsQuery ? getDocs(myListingsQuery) : Promise.resolve(null),
        ]);
        if (cancelled) return;

        const allItems = mapListingDocs(allSnap.docs);
        const myItems = mySnap ? mapListingDocs(mySnap.docs) : [];

        setListingItems(allItems);
        setMyListingItems(myItems);

        if (DEBUG_PROMPT) {
          console.log('[Studio][listings] loaded', {
            raw: allSnap.size,
            count: allItems.length,
            sample: allItems.slice(0, 3).map((it) => it.title),
          });
          console.log('[Studio][my-listings] loaded', {
            raw: mySnap?.size ?? 0,
            count: myItems.length,
            sample: myItems.slice(0, 3).map((it) => it.title),
          });
        }
      } catch (error: any) {
        if (cancelled) return;
        if (error?.code === 'permission-denied') {
          setListingItems([]);
          setMyListingItems([]);
          return;
        }
        console.warn('[StudioScreen] listing load error', error);
      }
    };

    void loadListings();
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  useEffect(() => {
    let cancelled = false;
    const uid = user?.uid;
    if (!uid) {
      setClosetSelectorItems([]);
      return () => {
        cancelled = true;
      };
    }

    const loadClosetItems = async () => {
      try {
        const closet = await loadLocalCloset(uid);
        if (cancelled) return;
        const mapped = closet
          .filter((item) => Boolean(item?.uri))
          .sort((a, b) => (b?.createdAt || 0) - (a?.createdAt || 0))
          .map((item) => {
            const mappedItem: Item = {
              id: `closet:${item.id}`,
              title: buildClosetItemTitle({
                category: item.category,
                brand: item.brand,
                tags: item.tags,
              }),
              image: item.uri,
              imagePath: item.uri,
              role: closetCategoryToRole(item.category),
              colorName: item.color ? toTitleCaseWords(item.color) : null,
              colorHex: null,
              price: null,
            };
            (mappedItem as any).source = 'closet';
            (mappedItem as any).category = item.category || null;
            (mappedItem as any).brand = item.brand || null;
            (mappedItem as any).tags = Array.isArray(item.tags) ? item.tags : [];
            (mappedItem as any).embedding = item.embedding || null;
            return mappedItem;
          });
        setClosetSelectorItems(mapped);
      } catch (error) {
        if (cancelled) return;
        console.warn('[StudioScreen] local closet load error', error);
        setClosetSelectorItems([]);
      }
    };

    void loadClosetItems();
    return () => {
      cancelled = true;
    };
  }, [clothingModalVisible, user?.uid]);

  const selectorItems = useMemo(() => {
    const seen = new Set<string>();
    const out: Item[] = [];
    myListingItems.forEach((it) => {
      if (seen.has(it.id)) return;
      seen.add(it.id);
      out.push(it);
    });
    listingItems.forEach((it) => {
      if (seen.has(it.id)) return;
      seen.add(it.id);
      out.push(it);
    });
    closetSelectorItems.forEach((it) => {
      if (seen.has(it.id)) return;
      seen.add(it.id);
      out.push(it);
    });
    (mock.allItems || []).forEach((it) => {
      if (seen.has(it.id)) return;
      seen.add(it.id);
      out.push(it);
    });
    return out;
  }, [closetSelectorItems, listingItems, myListingItems]);

  const listingPool = useMemo(
    () => selectorItems.filter((item) => isListingItem(item)) as ListingItem[],
    [selectorItems]
  );

  const recommendationPathCandidates = useCallback((value?: string | null) => {
    const raw = String(value || '').trim();
    if (!raw) return [] as string[];
    const normalized = normalizeUri(raw);
    const decoded = (() => {
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    })();
    const normalizedDecoded = normalizeUri(decoded);
    const basename = raw.split('/').filter(Boolean).pop() || '';
    const decodedBasename = decoded.split('/').filter(Boolean).pop() || '';
    return Array.from(
      new Set(
        [raw, normalized, decoded, normalizedDecoded, basename, decodedBasename]
          .map((entry) => String(entry || '').trim())
          .filter(Boolean)
      )
    );
  }, []);

  const findItemByImagePath = useCallback(
    (imagePath?: string | null) => {
      if (!imagePath) return null;
      const candidates = recommendationPathCandidates(imagePath);
      const matched =
        selectorItems.find((item) => {
          const itemCandidates = [
            item.id,
            item.imagePath,
            item.image,
            ...(Array.isArray((item as any)?.images) ? ((item as any).images as string[]) : []),
          ]
            .flatMap((value) => recommendationPathCandidates(value))
            .filter(Boolean);
          return candidates.some((candidate) => itemCandidates.includes(candidate));
        }) || null;
      return matched;
    },
    [recommendationPathCandidates, selectorItems]
  );

  const findItemByImageUri = useCallback(
    (uri?: string | null) => {
      const normalized = normalizeUri(uri);
      if (!normalized) return null;
      return (
        selectorItems.find((item) => {
          const candidates = [
            item.image,
            ...(Array.isArray((item as any)?.images) ? ((item as any).images as string[]) : []),
            (item as any)?.imagePath,
          ]
            .map((v) => normalizeUri(v))
            .filter(Boolean);
          return candidates.some((candidate) => {
            return (
              candidate === normalized ||
              candidate.endsWith(normalized) ||
              normalized.endsWith(candidate)
            );
          });
        }) || null
      );
    },
    [selectorItems]
  );

  const postGarments = useMemo<PostGarmentInput[]>(() => {
    const out: PostGarmentInput[] = [];
    (['top', 'bottom', 'mono', 'shoes'] as GarmentKey[]).forEach((key) => {
      const image = garments[key];
      if (!image) return;
      const matched = findItemByImageUri(image);
      out.push({
        role: roleForGarmentKey(key),
        title: matched?.title || key,
        listingId: (matched as any)?.listingId || null,
        itemId: matched?.id || null,
        image,
        imagePath: (matched as any)?.imagePath || null,
        brand: (matched as any)?.brand || null,
        category: (matched as any)?.category || null,
        price: (matched as any)?.price || null,
        size: (matched as any)?.size || null,
        condition: (matched as any)?.condition || null,
        tags: Array.isArray((matched as any)?.tags) ? (matched as any).tags : [],
      });
    });
    return out;
  }, [findItemByImageUri, garments]);

  const resolveResultUsedItemProduct = useCallback((item: PostGarmentInput) => {
    const listingId = parseListingId(item?.listingId) || parseListingId(item?.itemId);
    const listing = listingId
      ? selectorItems.find((entry) => {
          const directListingId = String((entry as any)?.listingId || '').trim();
          if (directListingId && directListingId === listingId) return true;
          const rawId = String(entry?.id || '').trim();
          return rawId === `listing:${listingId}` || rawId === listingId;
        })
      : null;
    const rawPrice = String(item?.price || '').trim();
    const normalizedPrice = rawPrice ? (rawPrice.startsWith('£') ? rawPrice : `£${rawPrice}`) : null;
    const image = String(item?.image || '').trim();
    const product: ProductLike =
      listing && isListingItem(listing as any)
        ? listingItemToProduct(listing as ListingItem)
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
  }, [selectorItems]);

  const scorePromptItem = useCallback((item: Item | ListingItem | null | undefined, tokens: string[]) => {
    if (!item || !tokens.length) return 0;
    const primaryFields: string[] = [
      item.title || '',
      String((item as any)?.brand || ''),
      String((item as any)?.category || ''),
      String((item as any)?.sub || ''),
      String((item as any)?.description || ''),
      String((item as any)?.colorName || ''),
      String((item as any)?.gender || ''),
    ];
    if (Array.isArray((item as any)?.colors)) primaryFields.push((item as any).colors.join(' '));

    const supportFields: string[] = [];
    if (Array.isArray((item as any)?.tags)) supportFields.push((item as any).tags.join(' '));
    if (Array.isArray((item as any)?.entities)) supportFields.push((item as any).entities.join(' '));
    if (Array.isArray((item as any)?.keywords)) supportFields.push((item as any).keywords.join(' '));
    if ((item as any)?.imagePath) supportFields.push(String((item as any).imagePath));

    const primaryCorpus = normalizeText(primaryFields.join(' '));
    const supportCorpus = normalizeText(supportFields.join(' '));
    const fullCorpus = [primaryCorpus, supportCorpus].filter(Boolean).join(' ');
    if (!fullCorpus) return 0;

    let score = 0;
    let hitCount = 0;
    const exactPhrase = normalizeText(tokens.join(' '));
    if (exactPhrase && fullCorpus.includes(exactPhrase)) {
      score += 2.5;
    }

    tokens.forEach((token) => {
      let tokenScore = 0;
      if (primaryCorpus && primaryCorpus.includes(token)) {
        tokenScore += 2.25;
      }
      if (supportCorpus && supportCorpus.includes(token)) {
        tokenScore += primaryCorpus.includes(token) ? 0.6 : 1.35;
      }
      if (!tokenScore) return;
      hitCount += 1;
      score += tokenScore;
    });

    if (!hitCount) return 0;

    score += (hitCount / tokens.length) * 1.5;
    if (hitCount > 1) score += (hitCount - 1) * 0.75;
    return Number(score.toFixed(3));
  }, []);

  const buildPromptRecommendations = useCallback(
    (
      prompt: string,
      selection?: RecommendationSelection | null,
      opts?: {
        tokens?: string[];
        activeSlots?: Set<GarmentKey>;
      }
    ) => {
      const tokens = opts?.tokens?.length ? opts.tokens : tokenizePrompt(prompt);
      const activeSlots = opts?.activeSlots || new Set<GarmentKey>(ALL_PROMPT_SLOTS);
      const output: Partial<Record<GarmentKey, Item[]>> = {};
      (['top', 'bottom', 'mono', 'shoes'] as GarmentKey[]).forEach((key) => {
        if (!activeSlots.has(key)) {
          output[key] = [];
          return;
        }

        const desiredRole = roleForGarmentKey(key);
        const list: Item[] = [];

        const selectionItem = selection?.[key];
        if (selectionItem?.imagePath) {
          const matched = findItemByImagePath(selectionItem.imagePath);
          if (
            matched &&
            !isClosetItem(matched as any) &&
            matchesGenderPreference(matched as any, genderPref)
          ) {
            list.push(matched);
          }
        }

        const candidates = selectorItems.filter((item) => {
          if (isClosetItem(item as any)) return false;
          if (!matchesGenderPreference(item as any, genderPref)) return false;
          const itemRole = item.role || inferRoleFromCategory((item as any)?.category);
          if (!itemRole) return false;
          return itemRole === desiredRole;
        });

        const scored = candidates
          .map((item) => ({ item, score: scorePromptItem(item, tokens) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.item);

        const fallback = [
          ...candidates.filter((item) => isListingItem(item)),
          ...candidates.filter((item) => !isListingItem(item)),
        ].slice(0, 8);
        const combined = [...list, ...(scored.length ? scored : fallback)];

        const deduped = new Map<string, Item>();
        combined.forEach((item) => {
          if (!item?.id) return;
          if (!deduped.has(item.id)) deduped.set(item.id, item);
        });

        const ordered = Array.from(deduped.values());
        output[key] = ordered.slice(0, 10);

        if (DEBUG_PROMPT) {
          const topTitles = output[key]
            ?.slice(0, 3)
            .map((it) => `${it.title}${isListingItem(it as ListingItem) ? ' (listing)' : ''}`);
          console.log('[Studio][prompt] role', key, {
            tokens,
            candidates: candidates.length,
            matched: scored.length,
            top: topTitles,
          });
        }
      });

      return output;
    },
    [findItemByImagePath, genderPref, scorePromptItem, selectorItems]
  );

  const materializeRecommendationItem = useCallback(
    async (item: RecommendationItem, slot: GarmentKey): Promise<Item | null> => {
      const matched = findItemByImagePath(item.imagePath);
      const metaTags = recommendationMetaTags(item.meta);
      const metaGender = recommendationMetaGender(item.meta);
      if (matched) {
        const merged: Item = {
          ...matched,
          title:
            String(item.meta?.name || matched.title || item.id || slot)
              .trim() || matched.title || slot,
          image: matched.image,
          imagePath: matched.imagePath || item.imagePath,
          role: matched.role || (roleForGarmentKey(slot) as Item['role']),
          category: String(matched.category || slot || '').trim() || slot,
          sub: String(item.meta?.sub || matched.sub || '').trim() || matched.sub,
          gender: metaGender || matched.gender || null,
          tags: Array.from(new Set([...(matched.tags || []), ...metaTags])),
          keywords: Array.from(new Set([...(matched.keywords || []), ...metaTags])),
          entities: Array.from(
            new Set([
              ...(matched.entities || []),
              ...(Array.isArray(item.meta?.entities) ? item.meta!.entities.map(String) : []),
            ])
          ),
          colors: Array.from(
            new Set([
              ...(matched.colors || []),
              ...(Array.isArray(item.meta?.colours) ? item.meta!.colours.map(String) : []),
            ])
          ),
        };
        return merged;
      }

      const uri = await ensureAssetUri(item.imagePath);
      if (!uri) return null;

      return {
        id: item.id || item.imagePath,
        title:
          String(item.meta?.title || item.meta?.name || item.id || slot)
            .trim() || slot,
        image: uri,
        imagePath: item.imagePath,
        role: roleForGarmentKey(slot) as Item['role'],
        category: slot,
        sub: String(item.meta?.sub || '').trim() || undefined,
        gender: metaGender || undefined,
        tags: metaTags,
        keywords: metaTags,
        entities: Array.isArray(item.meta?.entities) ? item.meta!.entities.map(String) : [],
        colors: Array.isArray(item.meta?.colours) ? item.meta!.colours.map(String) : [],
        price: null,
        colorName: null,
        colorHex: null,
      };
    },
    [findItemByImagePath]
  );

  const materializedBackendMatchesGender = useCallback(
    (item: Item | null | undefined) => {
      if (!item) return false;
      return matchesGenderPreference(item, genderPref);
    },
    [genderPref]
  );

  const materializeRecommendationPools = useCallback(
    async (
      pools: RecommendationPools | null | undefined,
      opts?: { rawLimit?: number; outputLimit?: number }
    ) => {
      const output: Partial<Record<GarmentKey, Item[]>> = {};
      if (!pools) return output;
      const rawLimit = Math.max(1, opts?.rawLimit ?? 24);
      const outputLimit = Math.max(1, opts?.outputLimit ?? 18);

      for (const key of ALL_PROMPT_SLOTS) {
        const rawList = pools[key] || [];
        if (!rawList.length) {
          output[key] = [];
          continue;
        }

        const resolved = await Promise.all(
          rawList.slice(0, rawLimit).map((item) => materializeRecommendationItem(item, key))
        );
        const unique = new Map<string, Item>();
        resolved.forEach((item) => {
          if (!item?.id) return;
          if (!materializedBackendMatchesGender(item)) return;
          if (!unique.has(item.id)) unique.set(item.id, item);
        });
        output[key] = Array.from(unique.values()).slice(0, outputLimit);
      }

      return output;
    },
    [materializeRecommendationItem, materializedBackendMatchesGender]
  );

  useEffect(() => {
    if (!clothingModalVisible || !deferredPromptPools) return;
    let cancelled = false;
    (async () => {
      const expanded = await materializeRecommendationPools(deferredPromptPools, {
        rawLimit: 24,
        outputLimit: 18,
      });
      if (cancelled) return;
      setPromptRecommendations(expanded);
      setDeferredPromptPools(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [clothingModalVisible, deferredPromptPools, materializeRecommendationPools]);

  // ─── Apply try-on selections from elsewhere in the app ───
  useEffect(() => {
    console.log('[Studio] check try-on selection');
    const pending = consumeTryOnSelection();
    if (pending) applySelection(pending);
    (async () => {
      if (pending) return;
      const stored = await consumeStoredTryOnSelection();
      if (!stored) console.log('[Studio] no stored selection');
      if (stored) applySelection(stored);
    })();
    const unsub = subscribeTryOnSelection((selection) => applySelection(selection));
    return unsub;
  }, [applySelection]);

  const encodeImage = useCallback(
    async (uri: string, opts: { format: 'jpeg' | 'png'; max?: number }) => {
      if (!uri) throw new Error('Missing image URI');
      const localUri = await toLocalFile(uri);
      const { format, max } = opts;
      const resizeOps = max ? [{ resize: { width: max } }] : [];
      const result = await ImageManipulator.manipulateAsync(localUri, resizeOps, {
        compress: format === 'jpeg' ? 0.92 : 1,
        format: format === 'png' ? ImageManipulator.SaveFormat.PNG : ImageManipulator.SaveFormat.JPEG,
        base64: true,
      });
      if (!result.base64) throw new Error('Unable to encode image');
      return result.base64;
    },
    []
  );

  const handleTryOn = useCallback(async () => {
    if (!modelUri) {
      Alert.alert('Select a model', 'Add a selfie or model photo first.');
      return;
    }
    if (!garmentLayerOrder.length) {
      Alert.alert('Select a garment', 'Pick at least one garment image to try on.');
      return;
    }

    try {
      setTryOnBusy(true);
      setTryOnError(null);
      const postGarmentsSnapshot: PostGarmentInput[] = (postGarments || []).map((garment) => ({
        ...garment,
        tags: Array.isArray(garment.tags) ? [...garment.tags] : [],
      }));
      const selectedGarmentKeys = garmentLayerOrder.filter((key) => Boolean(garments[key]));
      startTryOnProgress({ modelName: 'Try-on', modelUri, totalSteps: selectedGarmentKeys.length });

      let currentPersonB64 = await encodeImage(modelUri, {
        format: 'jpeg',
        max: DEFAULT_SELFIE_MAX,
      });
      let finalResultDataUri: string | null = null;

      for (const key of selectedGarmentKeys) {
        const garmentUri = garments[key];
        if (!garmentUri) continue;
        const productB64 = await encodeImage(garmentUri, {
          format: 'png',
          max: DEFAULT_GARMENT_MAX,
        });

        const res = await callTryOn({ personB64: currentPersonB64, productB64, sampleCount: 1 });
        finalResultDataUri = res.dataUri;
        currentPersonB64 = stripDataUri(res.dataUri);

        stepTryOnProgress();
      }

      if (!finalResultDataUri) {
        throw new Error('Try-on did not return an image.');
      }

      // Keep the exact garment metadata used for this try-on result so uploads stay in sync.
      setResultPostGarments(postGarmentsSnapshot);

      // Mark complete so the pill shows "Done". Do NOT auto-open the result modal;
      // the pill press should be the only way to open the result view.
      completeTryOnProgress(finalResultDataUri);
    } catch (err: any) {
      resetTryOnProgress();
      console.error('try-on error', err);
      const msg = err?.message || 'Failed to run try-on. Please try again.';
      setTryOnError(msg);
      Alert.alert('Try-on failed', msg);
    } finally {
      setTryOnBusy(false);
    }
  }, [encodeImage, garmentLayerOrder, garments, modelUri, postGarments]);

  // When the pill is pressed elsewhere (global event), open the result modal here.
  useEffect(() => {
    const unsub = subscribeTryOnPress(() => {
      const st = getTryOnProgress();
      if (st.modelUri) {
        setResultDataUri(st.modelUri);
        setResultVisible(true);
        // hide the pill after opening the result
        resetTryOnProgress();
      }
    });
    return unsub;
  }, []);

  // Subscribe to pill visibility so we can hide the fixed Try On button
  useEffect(() => subscribeTryOnProgress((s) => setPillVisible(Boolean(s.visible))), []);

  // ─── Model helpers: open gallery, remove model, pick model ───
  const openGallery = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert('Permission required', 'Please allow photo access to choose a model.');
        return;
      }
    } catch (err) {
      // ignore permission errors and proceed to picker
    }

    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
    });
    if (!res.canceled && res.assets?.[0]?.uri) {
      const uri = res.assets[0].uri;
      try {
        const persistedUri = await persistModelImage(uri);
        setModelUri(persistedUri);
        await AsyncStorage.setItem(STORAGE_KEY, persistedUri);
      } catch (error) {
        console.warn('[StudioScreen] failed to persist model image', error);
        Alert.alert('Could not save model', 'Please try selecting the image again.');
      }
    }
  }, []);

  const removeModel = useCallback(() => {
    Alert.alert('Remove model', 'Do you want to remove your saved model?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const currentUri = modelUri;
          setModelUri(null);
          await AsyncStorage.removeItem(STORAGE_KEY);
          await removePersistedModelImage(currentUri);
        },
      },
    ]);
  }, [modelUri]);

  const pickModel = useCallback(async () => {
    if (modelUri) {
      // If a model is already set, offer change/remove/cancel options
      Alert.alert('Model', undefined, [
        { text: 'Change picture', onPress: openGallery },
        { text: 'Remove', style: 'destructive', onPress: removeModel },
        { text: 'Cancel', style: 'cancel' },
      ]);
      return;
    }

    // No model set — open gallery immediately
    await openGallery();
  }, [modelUri, openGallery, removeModel]);

  const updateGarment = useCallback((key: keyof typeof garments, uri: string | null) => {
    setGarments((prev) => {
      const next = { ...prev, [key]: uri };
      if (uri && key === 'mono') {
        next.top = null;
        next.bottom = null;
      }
      if (uri && (key === 'top' || key === 'bottom')) {
        next.mono = null;
      }
      return next;
    });
    setClosetAnchorSlots((prev) => {
      const next = new Set(prev);
      if (!uri) {
        next.delete(key);
        return next;
      }
      const selected = findItemByImageUri(uri);
      if (isClosetItem(selected as any)) next.add(key as GarmentKey);
      else next.delete(key as GarmentKey);

      if (uri && key === 'mono') {
        next.delete('top');
        next.delete('bottom');
      }
      if (uri && (key === 'top' || key === 'bottom')) {
        next.delete('mono');
      }
      return next;
    });
  }, [findItemByImageUri]);

  const applyVisionItem = useCallback((item: VisionPoolItem, slot: VisionSlot) => {
    const slotFromVision = visionSlotToGarmentKey(slot);
    const slotFromRole = roleToGarmentKey(item.role);
    const slotFromCategory = inferRoleFromCategory((item as any)?.category);
    const inferredSlot =
      slotFromVision ||
      slotFromRole ||
      (slotFromCategory === 'dress' ? 'mono' : slotFromCategory === 'shoes' ? 'shoes' : slotFromCategory) ||
      null;
    if (!inferredSlot) {
      Alert.alert('Cannot apply item', 'We could not infer a clothing slot for this result.');
      return;
    }
    const imageUri = resolveVisionItemImage(item);
    if (!imageUri) {
      Alert.alert('Cannot apply item', 'This result has no usable image URI.');
      return;
    }

    updateGarment(inferredSlot, imageUri);
    setVisionVisible(false);
    Alert.alert('Applied to Studio', `${item.title} is now selected for ${inferredSlot}.`);
  }, [updateGarment]);

  const handlePromptSubmit = useCallback(async (promptText: string) => {
    const trimmed = promptText.trim();
    if (!trimmed) {
      Alert.alert('Add prompt', 'Describe the vibe or sport before generating.');
      return false;
    }
    const selectedClosetAnchors: Array<{ slot: GarmentKey; item: Item | ListingItem }> = [];
    (['top', 'bottom', 'mono', 'shoes'] as GarmentKey[]).forEach((slot) => {
      if (!closetAnchorSlots.has(slot)) return;
      const uri = garments[slot];
      if (!uri) return;
      const selected = findItemByImageUri(uri);
      if (!isClosetItem(selected as any)) return;
      selectedClosetAnchors.push({ slot, item: selected as Item | ListingItem });
    });

    const lockedSlots = new Set<GarmentKey>(selectedClosetAnchors.map((anchor) => anchor.slot));
    if (lockedSlots.has('mono')) {
      lockedSlots.add('top');
      lockedSlots.add('bottom');
    }
    if (lockedSlots.has('top') || lockedSlots.has('bottom')) {
      lockedSlots.add('mono');
    }

    const anchorContext = selectedClosetAnchors
      .map(({ slot, item }) => {
        const bits = [item.title, (item as any)?.colorName, (item as any)?.category]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .slice(0, 3);
        return `${slot}: ${bits.join(', ')}`;
      })
      .join(' | ');

    const promptForRecommendation = anchorContext
      ? `${trimmed} Keep these closet items fixed as anchors: ${anchorContext}. Build the rest of the outfit around them.`
      : trimmed;

    const promptTokens = Array.from(new Set(tokenizePrompt(trimmed)));
    const promptSlotPlan = inferPromptSlotPlan(trimmed);
    const slotsToResolve =
      selectedClosetAnchors.length > 0
        ? new Set<GarmentKey>(ALL_PROMPT_SLOTS)
        : promptSlotPlan.slotsToResolve;
    lastPromptRef.current = promptForRecommendation;
    lastPromptTokensRef.current = promptTokens;
    lastPromptSlotPlanRef.current = {
      explicitSlots: new Set(promptSlotPlan.explicitSlots),
      slotsToResolve,
      hasOutfitCue: promptSlotPlan.hasOutfitCue,
    };
    setRecommendBusy(true);
    try {
      let selection: RecommendationSelection | null = null;
      let backendPools: RecommendationPools | null = null;
      let backendIntent: Record<string, any> | null = null;
      let backendDiagnostics: Record<string, any> | null = null;
      let backendMeta: Record<string, any> | null = null;
      let backendLooksCount = 0;
      let remoteError: any = null;
      const broadPromptNeedsDiversification =
        promptSlotPlan.hasOutfitCue &&
        !promptSlotPlan.explicitSlots.size &&
        selectedClosetAnchors.length === 0;
      const recommendedPoolSize = broadPromptNeedsDiversification
        ? (promptTokens.length <= 2 ? 16 : promptTokens.length <= 4 ? 14 : 12)
        : 1;
      const recommendationBandSize = broadPromptNeedsDiversification
        ? Math.min(10, Math.max(6, Math.round(recommendedPoolSize * 0.65)))
        : 1;
      const anchorEmbeddings = (
        await Promise.all(
          selectedClosetAnchors.map(async ({ slot, item }) => {
            const rawEmbedding = (item as any)?.embedding;
            if (Array.isArray(rawEmbedding?.vector) && rawEmbedding.vector.length) {
              return {
                id: String(item.id || '').replace(/^closet:/, ''),
                slot,
                vector: rawEmbedding.vector,
              };
            }

            try {
              const embedded = await embedLocalClosetItem({
                id: String(item.id || '').replace(/^closet:/, ''),
                category: String((item as any)?.category || slot || '').trim(),
                brand: String((item as any)?.brand || '').trim() || null,
                color: String((item as any)?.colorName || '').trim() || null,
                tags: Array.isArray((item as any)?.tags) ? (item as any).tags : [],
              });
              if (!embedded?.vector?.length) return null;
              (item as any).embedding = embedded;
              if (user?.uid) {
                void upsertLocalClosetEmbedding(user.uid, String(item.id || '').replace(/^closet:/, ''), embedded).catch((error) => {
                  console.warn('[StudioScreen] failed to persist closet embedding', error);
                });
              }
              return {
                id: String(item.id || '').replace(/^closet:/, ''),
                slot,
                vector: embedded.vector,
              };
            } catch (error) {
              console.warn('[StudioScreen] closet anchor embedding failed', error);
              return null;
            }
          }),
        )
      ).filter(Boolean) as Array<{ id: string; slot: GarmentKey; vector: number[] }>;

      try {
        const response = await recommendFromPromptDetailed(promptForRecommendation, genderPref, {
          poolSize: recommendedPoolSize,
          randomizeSelection: broadPromptNeedsDiversification,
          diversifyBandSize: recommendationBandSize,
          anchorEmbeddings,
        });
        selection = response.selection;
        backendPools = response.pools;
        backendIntent = response.intent || null;
        backendDiagnostics = response.diagnostics || null;
        backendMeta = response.meta || null;
        backendLooksCount = Number(response.looksCount || 0);
        lastSelectionRef.current = selection;
      } catch (err) {
        remoteError = err;
        lastSelectionRef.current = null;
      }

      const effectiveSlotsToResolve = (() => {
        if (selectedClosetAnchors.length > 0) return new Set<GarmentKey>(ALL_PROMPT_SLOTS);
        const next = new Set<GarmentKey>(slotsToResolve);
        if (!remoteError && promptHasCompoundItemCue(trimmed)) {
          const backendSlots = backendInferredPromptSlots(backendIntent, selection, backendPools);
          if (backendSlots.size > next.size) {
            backendSlots.forEach((slot) => next.add(slot));
          }
        }
        return next;
      })();
      lastPromptSlotPlanRef.current = {
        explicitSlots: new Set(promptSlotPlan.explicitSlots),
        slotsToResolve: effectiveSlotsToResolve,
        hasOutfitCue: promptSlotPlan.hasOutfitCue,
      };

      let recommendations =
        remoteError || !backendPools
          ? {}
          : await materializeRecommendationPools(backendPools, {
              rawLimit: 8,
              outputLimit: 6,
            });
      const hasBackendRecommendations = Object.values(recommendations).some((list) => list && list.length);
      if (!hasBackendRecommendations) {
        recommendations = buildPromptRecommendations(promptForRecommendation, selection, {
          tokens: promptTokens,
          activeSlots: effectiveSlotsToResolve,
        });
        setDeferredPromptPools(null);
      } else {
        setDeferredPromptPools(backendPools);
      }
      setPromptRecommendations(recommendations);

      if (DEBUG_PROMPT) {
        const flatSelectionItems = Object.fromEntries(
          Object.entries(selection || {}).map(([key, item]) => [
            key,
            formatRecommendationDebugItem({
              id: item?.id || null,
              title: String(item?.meta?.title || item?.meta?.name || '').trim() || null,
              gender: String(item?.meta?.gender || '').trim() || null,
            }),
          ]),
        );
        const flatRecommendationSamples = Object.fromEntries(
          Object.entries(recommendations).map(([key, list]) => [
            key,
            (list || []).slice(0, 4).map((item) =>
              formatRecommendationDebugItem({
                id: item.id,
                title: item.title,
                gender: String((item as any)?.gender || '').trim() || null,
              })
            ),
          ]),
        );
        console.log('[Studio][prompt] backend', {
          status: remoteError
            ? 'remote_error'
            : selection
              ? 'remote_selection'
              : backendPools
                ? 'remote_pools_only'
                : 'local_fallback',
          endpointPoolSize: recommendedPoolSize,
          randomizeSelection: broadPromptNeedsDiversification,
          diversifyBandSize: recommendationBandSize,
          genderPref,
          looksCount: backendLooksCount,
          meta: backendMeta
            ? {
                poolSize: backendMeta.poolSize ?? null,
                perRoleLimit: backendMeta.perRoleLimit ?? null,
                parserMode: backendMeta.parserMode ?? null,
                embeddingMode: backendMeta.embeddingMode ?? null,
                model: backendMeta.model ?? null,
                embeddingModel: backendMeta.embeddingModel ?? null,
              }
            : null,
          diagnostics: backendDiagnostics
            ? {
                gemini: backendDiagnostics.gemini
                  ? {
                      active: backendDiagnostics.gemini.active ?? null,
                      reason: backendDiagnostics.gemini.reason ?? null,
                      source: backendDiagnostics.gemini.source ?? null,
                      cache_hit: backendDiagnostics.gemini.cache_hit ?? null,
                    }
                  : null,
                embeddings: backendDiagnostics.embeddings
                  ? {
                      active: backendDiagnostics.embeddings.active ?? null,
                      source: backendDiagnostics.embeddings.source ?? null,
                      reason: backendDiagnostics.embeddings.reason ?? null,
                      cache_hit: backendDiagnostics.embeddings.cache_hit ?? null,
                    }
                  : null,
                score_attribution: backendDiagnostics.score_attribution
                  ? {
                      parser_source: backendDiagnostics.score_attribution.parser_source ?? null,
                      symbolic_share: backendDiagnostics.score_attribution.symbolic_share ?? null,
                      semantic_share: backendDiagnostics.score_attribution.semantic_share ?? null,
                    }
                  : null,
                candidate_counts: backendDiagnostics.candidate_counts || null,
                candidate_previews: backendDiagnostics.candidate_previews
                  ? Object.fromEntries(
                      Object.entries(backendDiagnostics.candidate_previews).map(([slot, list]) => [
                        slot,
                        (Array.isArray(list) ? list : []).slice(0, 6).map((entry: any) => ({
                          id: entry?.id || null,
                          title: entry?.title || null,
                          gender: entry?.gender || null,
                          source: entry?.source || null,
                          listing_id: entry?.listing_id || null,
                          score: entry?.score ?? null,
                          symbolic: entry?.symbolic ?? null,
                          semantic: entry?.semantic ?? null,
                          brand: entry?.brand || null,
                          sub: entry?.sub || null,
                        })),
                      ]),
                    )
                  : null,
              }
            : null,
          intent: backendIntent
            ? {
                target_gender: backendIntent.target_gender ?? null,
                sport_context: backendIntent.sport_context ?? null,
                vibe_tags: Array.isArray(backendIntent.vibe_tags) ? backendIntent.vibe_tags : [],
                occasion_tags: Array.isArray(backendIntent.occasion_tags) ? backendIntent.occasion_tags : [],
                setting_context: Array.isArray(backendIntent.setting_context) ? backendIntent.setting_context : [],
                activity_context: Array.isArray(backendIntent.activity_context) ? backendIntent.activity_context : [],
                persona_terms: Array.isArray(backendIntent.persona_terms) ? backendIntent.persona_terms : [],
                requested_form: backendIntent.requested_form ?? null,
              }
            : null,
          remoteError: remoteError ? String(remoteError?.message || remoteError) : null,
        });
        console.log('[Studio][prompt] submit', {
          prompt: promptForRecommendation,
          tokens: promptTokens,
          promptSlots: Array.from(effectiveSlotsToResolve),
          explicitPromptSlots: Array.from(promptSlotPlan.explicitSlots),
          hasOutfitCue: promptSlotPlan.hasOutfitCue,
          lockedSlots: Array.from(lockedSlots),
          anchorItems: selectedClosetAnchors.map(({ slot, item }) => ({
            slot,
            id: item.id,
            title: item.title,
          })),
          listingItems: listingItems.length,
          myListingItems: myListingItems.length,
          listingPool: listingPool.length,
          selectionKeys: selection ? Object.keys(selection) : [],
          selectionItems: flatSelectionItems,
          recommendations: Object.fromEntries(
            Object.entries(recommendations).map(([key, list]) => [key, list?.length || 0])
          ),
          recommendationSamples: flatRecommendationSamples,
        });
      }

      // Only replace the garment slots returned by the recommender.
      // Preserve existing selections for slots not present in `selection`.
      const resolvedKeys = new Set<GarmentKey>();
      const attemptedSelectionKeys = new Set<GarmentKey>();
      const resolvedUris: Partial<Record<GarmentKey, string | null>> = {};
      if (selection) {
        for (const key of Object.keys(selection) as GarmentKey[]) {
          if (!effectiveSlotsToResolve.has(key)) continue;
          if (lockedSlots.has(key)) continue;
          attemptedSelectionKeys.add(key);
          const item = selection[key];
          if (!item) continue;
          const materializedSelection = await materializeRecommendationItem(item, key);
          let chosenItem = materializedBackendMatchesGender(materializedSelection)
            ? materializedSelection
            : null;

          if (!chosenItem) {
            chosenItem =
              (recommendations[key] || []).find((candidate) => materializedBackendMatchesGender(candidate)) ||
              null;
          }

          const uri =
            chosenItem?.image ||
            (chosenItem?.imagePath ? await ensureAssetUri(chosenItem.imagePath) : null) ||
            (materializedSelection?.imagePath ? await ensureAssetUri(materializedSelection.imagePath) : null);
          if (DEBUG_PROMPT) {
            console.log('[Studio][prompt] backend slot', key, {
              requested: {
                id: item.id || null,
                title: String(item.meta?.title || item.meta?.name || '').trim() || null,
                gender: String(item.meta?.gender || '').trim() || null,
              },
              materialized: materializedSelection
                ? {
                    id: materializedSelection.id,
                    title: materializedSelection.title,
                    gender: String((materializedSelection as any)?.gender || '').trim() || null,
                  }
                : null,
              applied: chosenItem
                ? {
                    id: chosenItem.id,
                    title: chosenItem.title,
                    gender: String((chosenItem as any)?.gender || '').trim() || null,
                  }
                : null,
            });
          }
          if (!chosenItem && DEBUG_PROMPT) {
            console.log('[Studio][prompt] backend slot rejected', key, {
              requested: formatRecommendationDebugItem({
                id: item.id || null,
                title: String(item.meta?.title || item.meta?.name || '').trim() || null,
                gender: String(item.meta?.gender || '').trim() || null,
              }),
              fallbackCandidates: (recommendations[key] || []).slice(0, 4).map((candidate) =>
                formatRecommendationDebugItem({
                  id: candidate.id,
                  title: candidate.title,
                  gender: String((candidate as any)?.gender || '').trim() || null,
                })
              ),
              reason: 'no_gender_compatible_backend_candidate',
            });
          }
          if (!uri || !chosenItem) continue;

          resolvedUris[key] = uri;
          resolvedKeys.add(key);
        }
      }

      const promptResolvedUris: Partial<Record<GarmentKey, string | null>> = {};
      if (!selection && !hasBackendRecommendations && promptSlotPlan.hasOutfitCue) {
        for (const key of ['top', 'bottom', 'mono', 'shoes'] as GarmentKey[]) {
          if (!effectiveSlotsToResolve.has(key)) continue;
          if (lockedSlots.has(key)) continue;
          if (resolvedUris[key] || promptResolvedUris[key]) continue;

          const list = recommendations[key] || [];
          const scoredFallback = list
            .map((item) => ({ item, score: scorePromptItem(item, promptTokens) }))
            .sort((a, b) => b.score - a.score);
          const fallbackPick =
            choosePromptBandCandidate(scoredFallback, {
              maxBandSize: 4,
              relativeFloor: 0.88,
              absoluteDrop: 0.75,
            })?.item ||
            list[0];
          if (!fallbackPick) continue;

          let uri = fallbackPick.image || null;
          if (!uri && fallbackPick.imagePath) {
            uri = await ensureAssetUri(fallbackPick.imagePath);
          }
          if (!uri) continue;

          promptResolvedUris[key] = uri;
          resolvedKeys.add(key);
        }
      }

      // Anchor mode fallback:
      // if closet item(s) are locked, still fill surrounding slots from recommendations
      // even when token matching is weak.
      if (!selection && selectedClosetAnchors.length > 0) {
        for (const key of ['top', 'bottom', 'mono', 'shoes'] as GarmentKey[]) {
          if (!effectiveSlotsToResolve.has(key)) continue;
          if (lockedSlots.has(key)) continue;
          if (resolvedUris[key] || promptResolvedUris[key]) continue;

          const recommended = recommendations[key] || [];
          const role = roleForGarmentKey(key);
          let fallbackPick =
            recommended.find((it) => !isClosetItem(it as any)) ||
            recommended[0] ||
            null;

          if (!fallbackPick) {
            const poolByRole = selectorItems.filter((it) => {
              if (isClosetItem(it as any)) return false;
              if (!matchesGenderPreference(it as any, genderPref)) return false;
              return !role || !it.role || it.role === role;
            });
            const scoredPool = poolByRole
              .map((it) => ({ it, score: scorePromptItem(it, promptTokens) }))
              .sort((a, b) => b.score - a.score);
            fallbackPick = scoredPool[0]?.it || poolByRole[0] || null;
          }

          if (!fallbackPick) continue;
          let uri = fallbackPick.image || null;
          if (!uri && fallbackPick.imagePath) {
            uri = await ensureAssetUri(fallbackPick.imagePath);
          }
          if (!uri) continue;

          promptResolvedUris[key] = uri;
          resolvedKeys.add(key);
        }
      }

      if (DEBUG_PROMPT) {
        console.log('[Studio][prompt] prompt picks', {
          picks: Object.fromEntries(
            Object.entries({ ...resolvedUris, ...promptResolvedUris }).map(([key, uri]) => [key, Boolean(uri)])
          ),
          remoteError: remoteError ? String(remoteError?.message || remoteError) : null,
        });
      }

      if (!resolvedKeys.size) {
        const hasRecommendations = Object.values(recommendations).some((list) => list && list.length);
        if (hasRecommendations) {
          setClothingModalVisible(true);
          return true;
        }
        if (remoteError) {
          console.error('recommendation error', remoteError);
          Alert.alert('Recommender error', 'Failed to generate outfit suggestions.');
          return false;
        }
        Alert.alert('No matches yet', 'Need more catalog coverage for that prompt.');
        return false;
      }

      setGarments((prev) => {
        // Start from previous selection and apply only the resolved slots.
        // Locked closet anchor slots remain untouched.
        const next: GarmentMap = { ...prev };
        const mergedResolved: Partial<Record<GarmentKey, string | null>> = {
          ...resolvedUris,
          ...promptResolvedUris,
        };
        attemptedSelectionKeys.forEach((k) => {
          if (lockedSlots.has(k)) return;
          if (k in mergedResolved) return;
          if (DEBUG_PROMPT) {
            console.log('[Studio][prompt] clearing unresolved backend slot', {
              slot: k,
              reason: 'backend_selected_slot_not_applied',
            });
          }
          next[k] = null;
        });
        (Object.keys(mergedResolved) as GarmentKey[]).forEach((k) => {
          if (lockedSlots.has(k)) return;
          next[k] = mergedResolved[k] ?? null;
        });

        const monoValue = lockedSlots.has('mono') ? prev.mono : next.mono;
        const topValue = lockedSlots.has('top') ? prev.top : next.top;
        const bottomValue = lockedSlots.has('bottom') ? prev.bottom : next.bottom;

        if (monoValue) {
          if (!lockedSlots.has('top')) next.top = null;
          if (!lockedSlots.has('bottom')) next.bottom = null;
        } else if ((topValue || bottomValue) && !lockedSlots.has('mono')) {
          next.mono = null;
        }

        return next;
      });
      setClothingModalVisible(true);
      return true;
    } catch (err) {
      console.error('recommendation error', err);
      Alert.alert('Recommender error', 'Failed to generate outfit suggestions.');
      return false;
    } finally {
      setRecommendBusy(false);
    }
  }, [
    buildPromptRecommendations,
    closetAnchorSlots,
    embedLocalClosetItem,
    findItemByImagePath,
    findItemByImageUri,
    garments,
    genderPref,
    listingItems.length,
    listingPool,
    materializeRecommendationItem,
    materializedBackendMatchesGender,
    materializeRecommendationPools,
    myListingItems.length,
    scorePromptItem,
    selectorItems,
    upsertLocalClosetEmbedding,
    user?.uid,
  ]);

  // ─── Mock outfit mixer ───
  const onMixOutfit = useCallback(async () => {
    // Use the same recommender pipeline but with a preset prompt based on the user's data.
    // This reuses `handlePromptSubmit` which applies returned garments and opens the selector.
    const preset = "Generate an outfit tailored to the user's data and preferences.";
    try {
      const ok = await handlePromptSubmit(preset);
      if (!ok) {
        Alert.alert('No suggestions', 'Could not generate an outfit from your data.');
      }
    } catch (err) {
      console.error('mixer error', err);
      Alert.alert('Mixer error', 'Failed to generate outfit.');
    }
  }, [handlePromptSubmit]);

  const auroraBg = useMemo(
    () => (
      <View pointerEvents="none" style={RNStyleSheet.absoluteFill}>
        <View style={[styles.blob, { top: -H * 0.1, left: -W * 0.25, opacity: 0.5 }]} />
        <View style={[styles.blob, { bottom: -H * 0.15, right: -W * 0.2, opacity: 0.45 }]} />
      </View>
    ),
    []
  );

  return (
    <View style={styles.screen}>
      {auroraBg}
      <MinimalHeader
        title="Studio"
        rightSecondaryIcon="scan-outline"
        rightSecondaryLabel="Vision"
        rightSecondaryA11yLabel="Open vision finder"
        onSecondaryPress={() => setVisionVisible(true)}
      />

      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'flex-start',
          alignItems: 'center',
          // small extra bottom padding so content can scroll just above the fixed Try On bar
          paddingBottom: insets.bottom + s(18) + s(12),
          paddingTop: s(6),
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Model Card */}
        <View style={{ position: 'relative' }}>
          <Pressable
            onPress={pickModel}
            onLongPress={modelUri ? removeModel : undefined}
            style={({ pressed }) => [styles.stagePress, pressFeedback(pressed, 'strong')]}
          >
            <BlurView intensity={28} tint="light" style={RNStyleSheet.absoluteFill} />
            {modelUri ? (
              <Image source={{ uri: modelUri }} style={styles.stageImage} />
            ) : (
              <View style={styles.stagePlaceholder}>
                <Ionicons name="person-circle-outline" size={80} color={colors.muted} />
                <Text style={styles.stagePlaceholderTxt}>Tap to select your model</Text>
              </View>
            )}
          </Pressable>

          {/* Outfit Mixer on bottom-right corner of model image */}
          <Pressable
            onPress={onMixOutfit}
            style={({ pressed }) => [
              styles.magicFab,
              pressFeedback(pressed, 'strong'),
            ]}
          >
            <Ionicons name="sparkles-outline" size={22} color={isDark ? colors.bg : '#fff'} />
          </Pressable>
        </View>

        {/* Inline Try-On removed; fixed bar added to bottom of screen */}

        {/* Model management buttons removed — tap the photo to Change/Remove */}

        <Pressable
          onPress={() => setClothingModalVisible(true)}
          style={({ pressed }) => [styles.selectorBtn, pressFeedback(pressed)]}
        >
          <Ionicons name="color-palette-outline" size={18} color={colors.text} />
          <Text style={styles.selectorTxt}>Select Clothing Items</Text>
        </Pressable>

      </ScrollView>

      <ResultModal
        visible={resultVisible}
        onClose={() => setResultVisible(false)}
        afterUri={resultDataUri || undefined}
        postGarments={resultPostGarments.length ? resultPostGarments : postGarments}
        resolveUsedItemProduct={resolveResultUsedItemProduct}
        getUsedItemInitialLiked={(product) => isListingLiked(product?.id || null, product?.listingId)}
        onUsedItemLikeChange={(liked, product) => {
          if (product?.id) setListingLiked(product.id, liked, product.listingId);
        }}
      />

      {/* Fixed Try-On Bar: locked above nav/safe area */}
      {!pillVisible && (
        <View style={[styles.fixedTryOnWrap, { bottom: insets.bottom + s(18) }]}>
          <Pressable
            onPress={handleTryOn}
            disabled={!canTryOn}
            style={({ pressed }) => [
              styles.fixedTryOnBtn,
              !canTryOn && styles.fixedTryOnBtnDisabled,
              canTryOn ? pressFeedback(pressed) : null,
            ]}
          >
            {tryOnBusy ? (
              <ActivityIndicator color={isDark ? colors.bg : '#fff'} />
            ) : (
              <>
                <Ionicons
                  name="sparkles"
                  size={18}
                  color={canTryOn ? (isDark ? colors.bg : '#fff') : (isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.45)')}
                  style={{ marginRight: 8 }}
                />
                <Text style={[styles.fixedTryOnTxt, !canTryOn && styles.fixedTryOnTxtDisabled]}>Try On</Text>
              </>
            )}
          </Pressable>
          {/* hint and error text removed per UI request */}
        </View>
      )}

      <VisionSheet
        visible={visionVisible}
        onClose={() => setVisionVisible(false)}
        pool={selectorItems}
        genderPref={genderPref}
        onApplyItem={applyVisionItem}
      />

      <ClothingSelectorModal
        visible={clothingModalVisible}
        onClose={() => {
          setClothingModalVisible(false);
          setPromptRecommendations({});
        }}
        garments={garments}
        onChange={updateGarment}
        gender={genderPref}
        onGenderChange={setGenderPref}
        onPromptSearch={handlePromptSubmit}
        recommendBusy={recommendBusy}
        items={selectorItems}
        closetItems={closetSelectorItems}
        recommendations={promptRecommendations}
        authoritativeRecommendations
      />
    </View>
  );
}

/* ───────────── styles ───────────── */
const makeStyles = (colors: any, isDark: boolean) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  blob: {
    position: 'absolute',
    width: Math.max(W * 0.9, 360),
    height: Math.max(W * 0.9, 360),
    borderRadius: 800,
    backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#ffffff',
  },
  stagePress: {
    width: Math.min(W - s(6), 380),
    height: Math.min(H * 0.6, 540),
    borderRadius: s(24),
    overflow: 'hidden',
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.07,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
  },
  stagePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  stagePlaceholderTxt: {
    marginTop: 12,
    fontSize: 15.5,
    fontWeight: '700',
    color: colors.muted,
    letterSpacing: 0.2,
  },
  stageImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  buttonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: s(3),
    marginTop: s(5),
    marginBottom: s(8),
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
    borderRadius: 999,
    paddingHorizontal: s(4.5),
    paddingVertical: s(2),
    borderWidth: hairline,
    borderColor: colors.borderLight,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  actionTxt: { marginLeft: 5, fontWeight: '700', color: colors.text },
  selectorBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 999,
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
    paddingVertical: s(2.8),
    marginTop: s(3),
    paddingHorizontal: s(6),
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    marginBottom: s(6),
  },
  selectorTxt: { fontWeight: '700', color: colors.text },

  fixedTryOnWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 30,
    paddingHorizontal: s(12),
    elevation: 20,
  },
  fixedTryOnBtn: {
    width: Math.min(W - s(8), 420),
    height: 56,
    borderRadius: 999,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
  },
  fixedTryOnBtnDisabled: {
    backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
    borderWidth: hairline,
    borderColor: colors.borderLight,
    opacity: 0.65,
  },
  fixedTryOnTxt: { color: isDark ? colors.bg : '#fff', fontWeight: '800', fontSize: 17, letterSpacing: 0.4 },
  fixedTryOnTxtDisabled: { color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)', fontWeight: '800', fontSize: 17, letterSpacing: 0.4 },
  tryOnHint: { marginTop: s(2), color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)', textAlign: 'center' },
  tryOnError: { marginTop: s(2), color: '#c62828', textAlign: 'center' },

  magicFab: {
    position: 'absolute',
    bottom: s(6),
    right: s(6),
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },

});
