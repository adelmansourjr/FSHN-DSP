import * as FileSystem from 'expo-file-system/legacy';
import type { Item } from '../../data/mock';
import type { ListingItem } from '../../lib/firestoreMappers';
import { buildJsonHeaders } from '../../lib/apiAuth';
import { classifyPhoto, type ClassifyResult } from '../../utils/localClassifier';
import { VISION_SEARCH_ENDPOINT } from '../../config/vision';
import { classifyUploadPhoto } from '../classifier/clientClassifier';

export type VisionSlot = 'top' | 'bottom' | 'mono' | 'shoes' | 'unknown';
export type VisionPoolItem = Item | ListingItem;

type GenderPref = 'any' | 'men' | 'women';

type LocalFallbackResult = ReturnType<typeof classifyUploadPhoto>;

export type VisionSignals = {
  query: string;
  tokens: string[];
  category: string | null;
  brand: string | null;
  color: string | null;
  gender: string | null;
  tags: string[];
  slot: VisionSlot;
  provider: 'google-vision' | 'catalog-fallback' | 'none';
};

export type VisionAppMatch = {
  item: VisionPoolItem;
  score: number;
  slot: VisionSlot;
  reasons: string[];
};

export type VisionWebMatch = {
  title: string;
  source: string;
  pageUrl: string;
  imageUrl: string;
  thumbnailUrl: string;
};

export type VisionLookupResult = {
  signals: VisionSignals;
  appMatches: VisionAppMatch[];
  webMatches: VisionWebMatch[];
  warnings: string[];
};

export type VisionLookupInput = {
  imageUri: string;
  pool: VisionPoolItem[];
  genderPref?: GenderPref;
  includeWeb?: boolean;
  maxAppResults?: number;
  maxWebResults?: number;
  abortSignal?: AbortSignal;
};

type VisionSearchResponse = {
  results?: Array<{
    title?: string;
    source?: string;
    pageUrl?: string;
    imageUrl?: string;
    thumbnailUrl?: string;
  }>;
  error?: {
    message?: string;
  };
  message?: string;
};

const TOKEN_STOPWORDS = new Set([
  'the',
  'and',
  'with',
  'for',
  'your',
  'outfit',
  'look',
  'style',
  'fashion',
  'photo',
  'item',
  'piece',
  'wear',
  'new',
  'best',
  'from',
  'like',
]);

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function normalizeText(value: string) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeGender(value?: string | null): GenderPref | 'unisex' | null {
  const raw = normalizeText(String(value || ''));
  if (!raw) return null;
  if (/\bunisex\b|\ball\b|\bgender neutral\b/.test(raw)) return 'unisex';
  if (/\bmen\b|\bmale\b|\bman\b|\bboy/.test(raw)) return 'men';
  if (/\bwomen\b|\bfemale\b|\bwoman\b|\bgirl/.test(raw)) return 'women';
  return null;
}

function matchesGenderPreference(item: VisionPoolItem, pref: GenderPref) {
  if (pref === 'any') return true;
  const itemGender = normalizeGender((item as any)?.gender);
  if (!itemGender || itemGender === 'unisex') return true;
  return itemGender === pref;
}

function inferSlotFromText(value?: string | null): VisionSlot {
  const raw = normalizeText(String(value || ''));
  if (!raw) return 'unknown';
  if (/\btop\b|\btshirt\b|\btee\b|\bshirt\b|\bhoodie\b|\bsweater\b|\bjacket\b/.test(raw)) return 'top';
  if (/\bbottom\b|\bshorts\b|\bjeans\b|\btrousers\b|\bpants\b|\bskirt\b/.test(raw)) return 'bottom';
  if (/\bdress\b|\bmono\b|\bjumpsuit\b/.test(raw)) return 'mono';
  if (/\bshoe\b|\bsneaker\b|\bboot\b|\bheel\b|\bfootwear\b/.test(raw)) return 'shoes';
  return 'unknown';
}

function inferSlotFromRole(role?: Item['role'] | null): VisionSlot {
  if (role === 'top' || role === 'bottom' || role === 'shoes') return role;
  if (role === 'dress') return 'mono';
  return 'unknown';
}

function inferSlotFromItem(item: VisionPoolItem): VisionSlot {
  const byRole = inferSlotFromRole(item.role);
  if (byRole !== 'unknown') return byRole;
  const byCategory = inferSlotFromText((item as any)?.category);
  if (byCategory !== 'unknown') return byCategory;
  return inferSlotFromText(item.title);
}

function dedupeStrings(list: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  list.forEach((raw) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  });
  return out;
}

function toTokens(values: string[]) {
  const merged = normalizeText(values.join(' '));
  if (!merged) return [];
  const raw = merged.split(' ');
  return dedupeStrings(
    raw.filter((token) => token.length > 1 && !TOKEN_STOPWORDS.has(token))
  );
}

function buildSignals(remote: ClassifyResult | null, fallback: LocalFallbackResult | null): VisionSignals {
  const category = String(remote?.category ?? fallback?.category ?? '').trim() || null;
  const brand = String(remote?.brand ?? fallback?.brand ?? '').trim() || null;
  const color = String(remote?.color ?? fallback?.color ?? '').trim() || null;
  const gender = String(remote?.gender ?? fallback?.gender ?? '').trim() || null;
  const tags = dedupeStrings([
    ...(Array.isArray(remote?.tags) ? remote!.tags : []),
    ...(Array.isArray(fallback?.tags) ? fallback!.tags : []),
  ]).slice(0, 24);

  const queryParts = dedupeStrings([
    brand || '',
    category || '',
    color || '',
    ...tags.slice(0, 4),
    'fashion',
    'similar style',
  ]);
  const query = queryParts.join(' ').trim() || 'fashion outfit similar style';
  const tokens = toTokens([category || '', brand || '', color || '', ...tags]);
  const slotFromCategory = inferSlotFromText(category);
  const slot = slotFromCategory !== 'unknown' ? slotFromCategory : inferSlotFromText(tags.join(' '));

  return {
    query,
    tokens,
    category,
    brand,
    color,
    gender,
    tags,
    slot,
    provider: remote ? 'google-vision' : fallback ? 'catalog-fallback' : 'none',
  };
}

function itemCorpus(item: VisionPoolItem) {
  const fields: string[] = [
    item.title || '',
    String((item as any)?.brand || ''),
    String((item as any)?.category || ''),
    String((item as any)?.description || ''),
    String(item.colorName || ''),
    String((item as any)?.gender || ''),
  ];

  if (Array.isArray((item as any)?.tags)) fields.push((item as any).tags.join(' '));
  if (Array.isArray((item as any)?.entities)) fields.push((item as any).entities.join(' '));
  if (Array.isArray((item as any)?.colors)) fields.push((item as any).colors.join(' '));

  return normalizeText(fields.join(' '));
}

function scorePoolItem(item: VisionPoolItem, signals: VisionSignals, genderPref: GenderPref): VisionAppMatch | null {
  if (!matchesGenderPreference(item, genderPref)) return null;
  const corpus = itemCorpus(item);
  if (!corpus) return null;

  let score = 0;
  let strongHits = 0;
  const reasons: string[] = [];

  signals.tokens.forEach((token) => {
    if (!token || token.length < 2) return;
    if (corpus.includes(token)) {
      score += 1.4;
      strongHits += 1;
      if (reasons.length < 2) reasons.push(token);
    }
  });

  const normalizedBrand = normalizeText(signals.brand || '');
  if (normalizedBrand && corpus.includes(normalizedBrand)) {
    score += 1.6;
    reasons.push('brand');
  }

  const normalizedColor = normalizeText(signals.color || '');
  if (normalizedColor && corpus.includes(normalizedColor)) {
    score += 0.9;
    reasons.push('color');
  }

  const itemSlot = inferSlotFromItem(item);
  if (signals.slot !== 'unknown' && itemSlot === signals.slot) {
    score += 1.8;
    reasons.push('type');
  }

  if (strongHits === 0 && score < 2.5) return null;

  return {
    item,
    score: Number(score.toFixed(2)),
    slot: itemSlot,
    reasons: reasons.slice(0, 3),
  };
}

function rankInAppMatches(
  pool: VisionPoolItem[],
  signals: VisionSignals,
  genderPref: GenderPref,
  maxResults: number
) {
  return pool
    .map((item) => scorePoolItem(item, signals, genderPref))
    .filter((entry): entry is VisionAppMatch => Boolean(entry))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, maxResults));
}

function extractErrorMessage(text: string): string | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as VisionSearchResponse;
    const direct = parsed?.error?.message || parsed?.message;
    if (direct) return direct;
  } catch {
    // no-op
  }
  return text.trim().slice(0, 240) || null;
}

async function toBase64(uri: string): Promise<string> {
  if (!uri) throw new Error('Empty URI');

  if (uri.startsWith('data:')) {
    const [, data] = uri.split(',');
    return data || '';
  }

  if (/^https?:\/\//i.test(uri)) {
    const tmp = FileSystem.cacheDirectory + `vision_dl_${Date.now()}`;
    const res = await FileSystem.downloadAsync(uri, tmp, {
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
    } as any);
    const b64 = await FileSystem.readAsStringAsync(res.uri, { encoding: 'base64' });
    try { await FileSystem.deleteAsync(res.uri, { idempotent: true }); } catch {}
    return b64;
  }

  return FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
}

async function searchWebWithGoogle(
  query: string,
  maxResults: number,
  imageUri: string,
  signal?: AbortSignal
): Promise<VisionWebMatch[]> {
  if (!VISION_SEARCH_ENDPOINT) {
    throw new Error(
      'Vision endpoint is not configured. Set EXPO_PUBLIC_VISION_SEARCH_ENDPOINT or TRYON_BASE_URL.'
    );
  }

  const capped = Math.max(1, Math.min(maxResults, 10));
  const imageB64 = await toBase64(imageUri);
  const res = await fetch(VISION_SEARCH_ENDPOINT, {
    method: 'POST',
    headers: await buildJsonHeaders(),
    body: JSON.stringify({
      query,
      num: capped,
      safe: 'active',
      imageB64,
    }),
    signal,
  });
  const payload = await res.text();
  if (!res.ok) {
    throw new Error(extractErrorMessage(payload) || `Vision web search failed (${res.status}).`);
  }

  let data: VisionSearchResponse = {};
  try {
    data = JSON.parse(payload) as VisionSearchResponse;
  } catch {
    throw new Error('Vision web search returned malformed JSON.');
  }

  const rows = Array.isArray(data.results) ? data.results : [];
  return rows
    .map((row) => {
      const title = String(row?.title || '').trim();
      const imageUrl = String(row?.imageUrl || '').trim();
      const pageUrl = String(row?.pageUrl || '').trim();
      const thumbnailUrl = String(row?.thumbnailUrl || row?.imageUrl || '').trim();
      if (!title || !imageUrl || !pageUrl) return null;
      return {
        title,
        source: String(row?.source || '').trim() || 'google',
        pageUrl,
        imageUrl,
        thumbnailUrl,
      } as VisionWebMatch;
    })
    .filter((entry): entry is VisionWebMatch => Boolean(entry));
}

async function classifyVisionImage(
  imageUri: string,
  signal?: AbortSignal
): Promise<{ remote: ClassifyResult | null; fallback: LocalFallbackResult | null; warnings: string[] }> {
  const warnings: string[] = [];
  let remote: ClassifyResult | null = null;
  try {
    remote = await classifyPhoto(imageUri, { signal });
  } catch (err: any) {
    warnings.push(err?.message ? `Google vision fallback: ${String(err.message)}` : 'Google vision fallback triggered.');
  }

  let fallback: LocalFallbackResult | null = null;
  if (!remote) {
    fallback = classifyUploadPhoto(imageUri);
    if (!fallback) {
      warnings.push('Unable to classify this image with the local catalog fallback.');
    }
  }

  return { remote, fallback, warnings };
}

export async function findVisionMatches({
  imageUri,
  pool,
  genderPref = 'any',
  includeWeb = true,
  maxAppResults = 14,
  maxWebResults = 8,
  abortSignal,
}: VisionLookupInput): Promise<VisionLookupResult> {
  const trimmedUri = String(imageUri || '').trim();
  if (!trimmedUri) throw new Error('Select an image before running Vision.');

  const { remote, fallback, warnings } = await classifyVisionImage(trimmedUri, abortSignal);
  const signals = buildSignals(remote, fallback);
  const appMatches = rankInAppMatches(pool, signals, genderPref, maxAppResults);

  const webMatches: VisionWebMatch[] = [];
  if (includeWeb) {
    if (!VISION_SEARCH_ENDPOINT) {
      warnings.push('Vision web search is disabled. Set EXPO_PUBLIC_VISION_SEARCH_ENDPOINT or TRYON_BASE_URL.');
    } else {
      try {
        const found = await searchWebWithGoogle(signals.query, maxWebResults, trimmedUri, abortSignal);
        webMatches.push(...found);
      } catch (err: any) {
        warnings.push(err?.message || 'Vision web search failed.');
      }
    }
  }

  return {
    signals,
    appMatches,
    webMatches,
    warnings,
  };
}
