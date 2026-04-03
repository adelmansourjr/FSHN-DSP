import type { Item } from '../../data/mock';
import { ensureAssetUri } from '../../data/assets';
import type { LocalClosetItem } from '../../lib/localCloset';
import { recommendFromPrompt, type RecommendationSelection } from '../../utils/localRecommender';

export type OutfitSlots = {
  top?: string | null;
  bottom?: string | null;
  mono?: string | null;
  shoes?: string | null;
};

type SlotKey = keyof OutfitSlots;

type GenerateTodaysPickParams = {
  closetItems: LocalClosetItem[];
  listingPool: Item[];
  basePrompt?: string;
  genderPref?: 'any' | 'men' | 'women';
  seenSignatures?: Set<string> | string[];
  maxAttempts?: number;
};

type AnchorCategory = 'top' | 'bottom' | 'mono' | 'shoes';

export type TodaysPickResult = {
  outfit: OutfitSlots;
  anchor: { id: string; category: AnchorCategory; uri: string } | null;
};

const SLOT_KEYS: SlotKey[] = ['top', 'bottom', 'mono', 'shoes'];
const DEFAULT_PROMPT = "Generate an outfit that matches this closet item using available inventory.";

const toAnchorCategory = (value?: string | null): AnchorCategory | null => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes('top')) return 'top';
  if (raw.includes('bottom')) return 'bottom';
  if (raw.includes('mono') || raw.includes('dress')) return 'mono';
  if (
    raw.includes('shoe') ||
    raw.includes('footwear') ||
    raw.includes('sneaker') ||
    raw.includes('boot') ||
    raw.includes('heel')
  ) {
    return 'shoes';
  }
  return null;
};

const roleToSlot = (role?: Item['role']): AnchorCategory | null => {
  if (role === 'top') return 'top';
  if (role === 'bottom') return 'bottom';
  if (role === 'dress') return 'mono';
  if (role === 'shoes') return 'shoes';
  return null;
};

const pickRandom = <T,>(items: T[]): T | null => {
  if (!items.length) return null;
  const index = Math.floor(Math.random() * items.length);
  return items[index] ?? null;
};

const normalizeUri = (value?: string | null) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .split('?')[0];

export const makeOutfitSignature = (outfit: OutfitSlots) =>
  SLOT_KEYS.map((slot) => `${slot}:${normalizeUri(outfit[slot]) || '-'}`).join('|');

export const isCompleteTodaysPickOutfit = (outfit: OutfitSlots) => {
  const hasMonoLook = Boolean(outfit.mono && outfit.shoes);
  const hasSplitLook = Boolean(outfit.top && outfit.bottom && outfit.shoes);
  return hasMonoLook || hasSplitLook;
};

const resolveRecommendedUri = async (value?: string | null) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('file://')) {
    return raw;
  }
  const assetUri = await ensureAssetUri(raw);
  return assetUri || null;
};

async function selectionToOutfit(selection: RecommendationSelection): Promise<OutfitSlots> {
  const out: OutfitSlots = {};
  for (const slot of SLOT_KEYS) {
    const path = selection?.[slot]?.imagePath;
    if (!path) continue;
    const uri = await resolveRecommendedUri(path);
    if (uri) out[slot] = uri;
  }
  return out;
}

const fillFromPool = (
  current: OutfitSlots,
  pool: Item[],
  slot: AnchorCategory,
  excludedUris: Set<string>,
) => {
  if (current[slot]) return;
  const candidates = pool.filter((item) => {
    const roleSlot = roleToSlot(item.role);
    const normalized = normalizeUri(item.image);
    return roleSlot === slot && normalized && !excludedUris.has(normalized);
  });
  const picked = pickRandom(candidates);
  if (!picked?.image) return;
  current[slot] = picked.image;
  excludedUris.add(normalizeUri(picked.image));
};

const fillFromCloset = (
  current: OutfitSlots,
  anchors: Array<{ id: string; category: AnchorCategory; uri: string; tags: string[] }>,
  slot: AnchorCategory,
  excludedUris: Set<string>,
  excludeAnchorId?: string | null,
) => {
  if (current[slot]) return;
  const candidates = anchors.filter((item) => {
    if (excludeAnchorId && item.id === excludeAnchorId) return false;
    if (item.category !== slot) return false;
    const normalized = normalizeUri(item.uri);
    return Boolean(normalized) && !excludedUris.has(normalized);
  });
  const picked = pickRandom(candidates);
  if (!picked?.uri) return;
  current[slot] = picked.uri;
  excludedUris.add(normalizeUri(picked.uri));
};

const buildExcludedUriSet = (outfit: OutfitSlots) => {
  const out = new Set<string>();
  SLOT_KEYS.forEach((slot) => {
    const uri = normalizeUri(outfit[slot]);
    if (uri) out.add(uri);
  });
  return out;
};

const completeMonoLook = (
  base: OutfitSlots,
  listingPool: Item[],
  anchors: Array<{ id: string; category: AnchorCategory; uri: string; tags: string[] }>,
  anchorId?: string,
) => {
  const outfit: OutfitSlots = { ...base, top: null, bottom: null };
  const excluded = buildExcludedUriSet(outfit);
  fillFromPool(outfit, listingPool, 'mono', excluded);
  fillFromPool(outfit, listingPool, 'shoes', excluded);
  fillFromCloset(outfit, anchors, 'mono', excluded, anchorId);
  fillFromCloset(outfit, anchors, 'shoes', excluded, anchorId);
  return outfit;
};

const completeSplitLook = (
  base: OutfitSlots,
  listingPool: Item[],
  anchors: Array<{ id: string; category: AnchorCategory; uri: string; tags: string[] }>,
  anchorId?: string,
) => {
  const outfit: OutfitSlots = { ...base, mono: null };
  const excluded = buildExcludedUriSet(outfit);
  fillFromPool(outfit, listingPool, 'top', excluded);
  fillFromPool(outfit, listingPool, 'bottom', excluded);
  fillFromPool(outfit, listingPool, 'shoes', excluded);
  fillFromCloset(outfit, anchors, 'top', excluded, anchorId);
  fillFromCloset(outfit, anchors, 'bottom', excluded, anchorId);
  fillFromCloset(outfit, anchors, 'shoes', excluded, anchorId);
  return outfit;
};

export async function generateTodaysPick(params: GenerateTodaysPickParams): Promise<TodaysPickResult> {
  const {
    closetItems,
    listingPool,
    basePrompt,
    genderPref = 'any',
    seenSignatures,
    maxAttempts = 8,
  } = params;
  const validAnchors = closetItems
    .map((item) => {
      const category = toAnchorCategory(item.category);
      if (!category || !item.uri) return null;
      return { id: item.id, category, uri: item.uri, tags: item.tags || [] };
    })
    .filter(Boolean) as Array<{ id: string; category: AnchorCategory; uri: string; tags: string[] }>;

  if (!validAnchors.length) {
    return { outfit: {}, anchor: null };
  }

  const blocked = new Set<string>(
    Array.isArray(seenSignatures) ? seenSignatures : seenSignatures ? Array.from(seenSignatures) : []
  );
  let fallback: TodaysPickResult | null = null;

  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt += 1) {
    const anchor = pickRandom(validAnchors);
    if (!anchor) continue;

    const promptParts = [
      basePrompt || DEFAULT_PROMPT,
      `Build the outfit around this fixed anchor item: ${anchor.category}.`,
      anchor.tags.length ? `Anchor attributes: ${anchor.tags.slice(0, 8).join(', ')}.` : '',
      `Variation seed: ${attempt + 1}.`,
    ].filter(Boolean);
    const prompt = promptParts.join(' ');

    let outfit: OutfitSlots = {};
    try {
      const selection = await recommendFromPrompt(prompt, genderPref);
      outfit = await selectionToOutfit(selection);
    } catch {
      outfit = {};
    }

    const baseWithAnchor: OutfitSlots = { ...outfit, [anchor.category]: anchor.uri };
    let completed: OutfitSlots | null = null;

    if (anchor.category === 'mono') {
      completed = completeMonoLook(baseWithAnchor, listingPool, validAnchors, anchor.id);
    } else if (anchor.category === 'top' || anchor.category === 'bottom') {
      completed = completeSplitLook(baseWithAnchor, listingPool, validAnchors, anchor.id);
    } else {
      // Anchor is shoes: prefer whichever complete shape can be built first.
      const preferMono = Boolean(baseWithAnchor.mono) && !(baseWithAnchor.top && baseWithAnchor.bottom);
      const first = preferMono
        ? completeMonoLook(baseWithAnchor, listingPool, validAnchors, anchor.id)
        : completeSplitLook(baseWithAnchor, listingPool, validAnchors, anchor.id);
      if (isCompleteTodaysPickOutfit(first)) {
        completed = first;
      } else {
        const second = preferMono
          ? completeSplitLook(baseWithAnchor, listingPool, validAnchors, anchor.id)
          : completeMonoLook(baseWithAnchor, listingPool, validAnchors, anchor.id);
        completed = isCompleteTodaysPickOutfit(second) ? second : null;
      }
    }

    if (!completed || !isCompleteTodaysPickOutfit(completed)) {
      continue;
    }

    const candidate: TodaysPickResult = {
      outfit: completed,
      anchor: { id: anchor.id, category: anchor.category, uri: anchor.uri },
    };
    if (!fallback) fallback = candidate;
    const signature = makeOutfitSignature(completed);
    if (!blocked.has(signature)) return candidate;
  }

  return fallback || { outfit: {}, anchor: null };
}
