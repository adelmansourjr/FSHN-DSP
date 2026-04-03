import { RECOMMENDER_ENDPOINT } from '../config/recommender';
import type { GarmentMap } from '../components/studio/ClothingSelectorModal';
import { buildJsonHeaders } from '../lib/apiAuth';

export type RecommendationItem = {
  imagePath: string;
  id?: string;
  category?: keyof GarmentMap;
  meta?: Record<string, any>;
};

export type RecommendationSelection = Partial<Record<keyof GarmentMap, RecommendationItem>>;
export type RecommendationPools = Partial<Record<keyof GarmentMap, RecommendationItem[]>>;
export type RecommendationResponse = {
  selection: RecommendationSelection;
  pools: RecommendationPools;
  intent?: Record<string, any> | null;
  diagnostics?: Record<string, any> | null;
  meta?: Record<string, any> | null;
  looksCount?: number;
};

const CATEGORY_KEYS: Array<keyof GarmentMap> = ['top', 'bottom', 'mono', 'shoes'];
interface RecommendOptions {
  poolSize?: number;
  abortSignal?: AbortSignal;
  randomizeSelection?: boolean;
  diversifyBandSize?: number;
  anchorEmbeddings?: Array<{
    id: string;
    slot?: keyof GarmentMap | null;
    vector: number[];
  }>;
}

export async function recommendFromPrompt(
  prompt: string,
  genderPref: 'any' | 'men' | 'women',
  opts: RecommendOptions = {},
): Promise<RecommendationSelection> {
  const result = await recommendFromPromptDetailed(prompt, genderPref, opts);
  return result.selection;
}

export async function recommendFromPromptDetailed(
  prompt: string,
  genderPref: 'any' | 'men' | 'women',
  opts: RecommendOptions = {},
): Promise<RecommendationResponse> {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) throw new Error('Prompt is required.');
  if (!RECOMMENDER_ENDPOINT) {
    throw new Error(
      'Recommender endpoint is not configured. Set EXPO_PUBLIC_RECOMMENDER_ENDPOINT or RECOMMENDER_BASE_URL.',
    );
  }

  const body = {
    prompt: trimmedPrompt,
    gender_pref: genderPref,
    pool_size: opts.poolSize ?? 1,
    anchor_embeddings: Array.isArray(opts.anchorEmbeddings) ? opts.anchorEmbeddings : undefined,
  };

  let responseText = '';
  let contentType: string | null = null;

  try {
    const res = await fetch(RECOMMENDER_ENDPOINT, {
      method: 'POST',
      headers: await buildJsonHeaders(),
      body: JSON.stringify(body),
      signal: opts.abortSignal,
    });
    contentType = res.headers.get('content-type');
    responseText = await res.text();

    if (!res.ok) {
      const message = extractErrorMessage(responseText) ?? `Recommender request failed (${res.status})`;
      throw new Error(message);
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(err?.message || 'Unable to reach recommender service.');
  }

  const parsed = parseRecommendationPayload(responseText, contentType, {
    randomizeSelection: !!opts.randomizeSelection,
    diversifyBandSize: opts.diversifyBandSize,
  });
  if (parsed) return parsed;
  throw new Error('Recommender did not return any outfits for this prompt yet.');
}

function parseRecommendationPayload(
  payload: string,
  contentType: string | null,
  opts: Pick<RecommendOptions, 'randomizeSelection' | 'diversifyBandSize'> = {},
): RecommendationResponse | null {
  if (!payload) return null;
  const looksLikeJson = Boolean(contentType && /json/i.test(contentType));
  if (looksLikeJson) {
    const json = safeJsonParse(payload);
    const fromJson = json ? extractRecommendationFromJson(json, opts) : null;
    if (fromJson) return fromJson;
  } else {
    const json = safeJsonParse(payload);
    if (json) {
      const fromJson = extractRecommendationFromJson(json, opts);
      if (fromJson) return fromJson;
    }
  }

  const selection = parseCliText(payload);
  return selection ? { selection, pools: buildPoolsFromSelection(selection) } : null;
}

function extractRecommendationFromJson(
  data: any,
  opts: Pick<RecommendOptions, 'randomizeSelection' | 'diversifyBandSize'> = {},
): RecommendationResponse | null {
  if (!data) return null;

  if (Array.isArray(data)) {
    for (const entry of data) {
      const parsed = extractRecommendationFromJson(entry, opts);
      if (parsed) return parsed;
    }
    return null;
  }

  const candidateLooks = collectLookSelections(data);
  const pools = extractRecommendationPools(data);
  const explicitSelection = data?.selection ? extractSelectionOnlyFromJson(data.selection) : null;
  if (explicitSelection) {
    return {
      selection: explicitSelection,
      pools: mergeRecommendationPools(pools, buildPoolsFromSelection(explicitSelection)),
      intent: isObjectLike(data.intent) ? data.intent : null,
      diagnostics: isObjectLike(data.diagnostics) ? data.diagnostics : null,
      meta: isObjectLike(data.meta) ? data.meta : null,
      looksCount: Array.isArray(data?.looks) ? data.looks.length : Array.isArray(data?.outfits) ? data.outfits.length : candidateLooks.length || 1,
    };
  }
  if (candidateLooks.length) {
    const chosen = chooseLookSelection(candidateLooks, opts);
    if (chosen) {
      return {
        selection: chosen,
        pools: mergeRecommendationPools(pools, buildPoolsFromSelection(chosen)),
        intent: isObjectLike(data.intent) ? data.intent : null,
        diagnostics: isObjectLike(data.diagnostics) ? data.diagnostics : null,
        meta: isObjectLike(data.meta) ? data.meta : null,
        looksCount: Array.isArray(data?.looks) ? data.looks.length : Array.isArray(data?.outfits) ? data.outfits.length : candidateLooks.length,
      };
    }
  }

  if (Array.isArray(data?.outfits) && data.outfits.length) {
    return extractRecommendationFromJson(data.outfits[0], opts);
  }
  if (Array.isArray(data?.items)) {
    const map: RecommendationSelection = {};
    let found = false;
    for (const item of data.items) {
      const normalized = normalizeRecommendationItem(item);
      if (normalized?.category && CATEGORY_KEYS.includes(normalized.category)) {
        map[normalized.category] = normalized;
        found = true;
      }
    }
    return found ? { selection: map, pools: mergeRecommendationPools(pools, buildPoolsFromSelection(map)) } : null;
  }

  const selection = extractSelectionOnlyFromJson(data);
  if (!selection) return null;
  return {
    selection,
    pools: mergeRecommendationPools(pools, buildPoolsFromSelection(selection)),
    intent: isObjectLike(data.intent) ? data.intent : null,
    diagnostics: isObjectLike(data.diagnostics) ? data.diagnostics : null,
    meta: isObjectLike(data.meta) ? data.meta : null,
    looksCount: Array.isArray(data?.looks) ? data.looks.length : Array.isArray(data?.outfits) ? data.outfits.length : 1,
  };
}

function isObjectLike(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractSelectionOnlyFromJson(data: any): RecommendationSelection | null {
  if (!data || typeof data !== 'object') return null;
  const selection: RecommendationSelection = {};
  let hasAny = false;
  for (const key of CATEGORY_KEYS) {
    const normalized = normalizeRecommendationItem(data[key], key);
    if (normalized) {
      selection[key] = normalized;
      hasAny = true;
    }
  }
  return hasAny ? selection : null;
}

function collectLookSelections(data: any): RecommendationSelection[] {
  const candidates: RecommendationSelection[] = [];

  if (Array.isArray(data?.looks)) {
    for (const look of data.looks) {
      const parsed = extractSelectionOnlyFromJson(look?.selection || look || null);
      if (parsed) candidates.push(parsed);
    }
  }

  if (Array.isArray(data?.outfits)) {
    for (const outfit of data.outfits) {
      const parsed = extractSelectionOnlyFromJson(outfit);
      if (parsed) candidates.push(parsed);
    }
  }

  return candidates;
}

function extractRecommendationPools(data: any): RecommendationPools {
  const pools: RecommendationPools = {};
  const appendSelection = (selection: RecommendationSelection | null | undefined) => {
    if (!selection) return;
    for (const key of CATEGORY_KEYS) {
      const item = selection[key];
      if (!item) continue;
      if (!pools[key]) pools[key] = [];
      pools[key]!.push(item);
    }
  };

  if (Array.isArray(data?.looks)) {
    for (const look of data.looks) {
      appendSelection(extractSelectionOnlyFromJson(look?.selection || look || null));
    }
  }

  if (Array.isArray(data?.outfits)) {
    for (const outfit of data.outfits) {
      appendSelection(extractSelectionOnlyFromJson(outfit));
    }
  }

  for (const key of CATEGORY_KEYS) {
    if (Array.isArray(data?.[key])) {
      for (const entry of data[key]) {
        const normalized = normalizeRecommendationItem(entry, key);
        if (!normalized) continue;
        if (!pools[key]) pools[key] = [];
        pools[key]!.push(normalized);
      }
    }
  }

  return dedupeRecommendationPools(pools);
}

function buildPoolsFromSelection(selection: RecommendationSelection): RecommendationPools {
  const pools: RecommendationPools = {};
  for (const key of CATEGORY_KEYS) {
    const item = selection[key];
    if (item) pools[key] = [item];
  }
  return pools;
}

function mergeRecommendationPools(...sources: RecommendationPools[]): RecommendationPools {
  const merged: RecommendationPools = {};
  for (const source of sources) {
    for (const key of CATEGORY_KEYS) {
      const list = source[key];
      if (!list?.length) continue;
      if (!merged[key]) merged[key] = [];
      merged[key]!.push(...list);
    }
  }
  return dedupeRecommendationPools(merged);
}

function dedupeRecommendationPools(pools: RecommendationPools): RecommendationPools {
  const deduped: RecommendationPools = {};
  for (const key of CATEGORY_KEYS) {
    const list = pools[key];
    if (!list?.length) continue;
    const seen = new Set<string>();
    const unique: RecommendationItem[] = [];
    for (const item of list) {
      const fingerprint = String(item.id || item.imagePath || '').trim();
      if (!fingerprint || seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      unique.push(item);
    }
    if (unique.length) deduped[key] = unique;
  }
  return deduped;
}

function chooseLookSelection(
  looks: RecommendationSelection[],
  opts: Pick<RecommendOptions, 'randomizeSelection' | 'diversifyBandSize'>,
): RecommendationSelection | null {
  if (!looks.length) return null;
  if (!opts.randomizeSelection || looks.length === 1) return looks[0];

  const capped = looks.slice(0, Math.max(1, Math.min(opts.diversifyBandSize || 4, looks.length)));
  const coreCounts = new Map<string, number>();
  const topCounts = new Map<string, number>();
  const bottomCounts = new Map<string, number>();
  const shoeCounts = new Map<string, number>();
  for (const look of capped) {
    const topId = String(look.top?.id || look.top?.imagePath || '').trim();
    const bottomId = String(look.bottom?.id || look.bottom?.imagePath || '').trim();
    const shoesId = String(look.shoes?.id || look.shoes?.imagePath || '').trim();
    const monoId = String(look.mono?.id || look.mono?.imagePath || '').trim();
    const core = monoId || `${topId || '-'}|${bottomId || '-'}`;
    if (core) coreCounts.set(core, (coreCounts.get(core) || 0) + 1);
    if (topId) topCounts.set(topId, (topCounts.get(topId) || 0) + 1);
    if (bottomId) bottomCounts.set(bottomId, (bottomCounts.get(bottomId) || 0) + 1);
    if (shoesId) shoeCounts.set(shoesId, (shoeCounts.get(shoesId) || 0) + 1);
  }
  const weights = capped.map((look, index) => {
    const topId = String(look.top?.id || look.top?.imagePath || '').trim();
    const bottomId = String(look.bottom?.id || look.bottom?.imagePath || '').trim();
    const shoesId = String(look.shoes?.id || look.shoes?.imagePath || '').trim();
    const monoId = String(look.mono?.id || look.mono?.imagePath || '').trim();
    const core = monoId || `${topId || '-'}|${bottomId || '-'}`;
    const rankWeight = Math.max(0.45, 1 - index * 0.08);
    const coreBonus = Math.max(0, 2 - (coreCounts.get(core) || 0)) * 0.9;
    const topBonus = topId ? Math.max(0, 3 - (topCounts.get(topId) || 0)) * 0.35 : 0;
    const bottomBonus = bottomId ? Math.max(0, 3 - (bottomCounts.get(bottomId) || 0)) * 0.28 : 0;
    const shoesBonus = shoesId ? Math.max(0, 3 - (shoeCounts.get(shoesId) || 0)) * 0.14 : 0;
    return rankWeight * (1 + coreBonus + topBonus + bottomBonus + shoesBonus);
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!total) return capped[0];
  let cursor = Math.random() * total;
  for (let i = 0; i < capped.length; i += 1) {
    cursor -= weights[i];
    if (cursor <= 0) return capped[i];
  }
  return capped[0];
}

function normalizeRecommendationItem(
  value: any,
  fallbackCategory?: keyof GarmentMap,
): RecommendationItem | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const imagePath = value.trim();
    if (!imagePath) return null;
    return { imagePath, category: fallbackCategory };
  }
  if (typeof value === 'object') {
    const rawPath = value.imagePath ?? value.path ?? value.uri ?? value.url;
    const imagePath = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!imagePath) return null;
    const category = value.category ?? fallbackCategory;
    const id = value.id ? String(value.id) : undefined;
    const meta = value.meta && typeof value.meta === 'object' ? value.meta : undefined;
    return {
      imagePath,
      id,
      category: CATEGORY_KEYS.includes(category) ? category : fallbackCategory,
      meta,
    };
  }
  return null;
}

function parseCliText(payload: string): RecommendationSelection | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;
  const blocks = trimmed.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) continue;

    const selection: RecommendationSelection = {};
    let found = false;
    for (const line of lines) {
      const firstSpace = line.indexOf(' ');
      if (firstSpace <= 0) continue;
      const category = line.slice(0, firstSpace) as keyof GarmentMap;
      if (!CATEGORY_KEYS.includes(category)) continue;
      const imagePath = line.slice(firstSpace + 1).trim();
      if (!imagePath) continue;
      selection[category] = { imagePath, category };
      found = true;
    }
    if (found) return selection;
  }
  return null;
}

function extractErrorMessage(payload: string): string | null {
  if (!payload) return null;
  const json = safeJsonParse(payload);
  if (json) {
    if (typeof json.error === 'string') return json.error;
    if (json.error?.message) return String(json.error.message);
    if (typeof json.message === 'string') return json.message;
  }
  const text = payload.trim();
  return text ? text.slice(0, 200) : null;
}

function safeJsonParse(text: string): any | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
