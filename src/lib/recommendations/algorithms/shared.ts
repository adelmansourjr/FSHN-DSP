import type { Item } from '../../../data/mock';

export type RecommendationItem = Item & {
  listingId?: string;
  likeCount?: number;
  likes?: number;
  brand?: string | null;
  category?: string | null;
  gender?: string | null;
  tags?: string[];
  colors?: string[];
};

export type RecommendationInput = {
  items: RecommendationItem[];
  likedIds: Set<string> | string[];
  limit?: number;
};

type TasteBucket = {
  counts: Record<string, number>;
  max: number;
};

export type TasteProfile = {
  likedCount: number;
  roles: TasteBucket;
  categories: TasteBucket;
  tags: TasteBucket;
  colors: TasteBucket;
  brands: TasteBucket;
  topRoles: Set<string>;
  topCategories: Set<string>;
};

function createBucket(): TasteBucket {
  return { counts: {}, max: 0 };
}

function bump(bucket: TasteBucket, key: string, amount = 1) {
  if (!key) return;
  const next = (bucket.counts[key] || 0) + amount;
  bucket.counts[key] = next;
  if (next > bucket.max) bucket.max = next;
}

function topKeys(bucket: TasteBucket, count: number): Set<string> {
  return new Set(
    Object.entries(bucket.counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, count))
      .map(([key]) => key)
  );
}

function bucketScore(bucket: TasteBucket, key: string): number {
  if (!key || bucket.max <= 0) return 0;
  return Math.min(1, (bucket.counts[key] || 0) / bucket.max);
}

export function normalizeText(value?: string | null): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenList(values: Array<string | null | undefined>) {
  const raw = normalizeText(values.filter(Boolean).join(' '));
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  raw.split(' ').forEach((token) => {
    if (token.length < 3 || seen.has(token)) return;
    seen.add(token);
    out.push(token);
  });
  return out;
}

export function itemRoleKey(item: RecommendationItem): string {
  const role = normalizeText(item.role || '');
  if (role) return role;
  const category = normalizeText((item as any)?.category || '');
  if (/\bshoe|boot|heel|sneaker|footwear\b/.test(category)) return 'shoes';
  if (/\bdress|mono|jumpsuit\b/.test(category)) return 'dress';
  if (/\btop|shirt|tee|hoodie|jacket|sweater\b/.test(category)) return 'top';
  if (/\bbottom|jeans|pants|shorts|skirt|trouser\b/.test(category)) return 'bottom';
  return '';
}

export function itemCategoryKey(item: RecommendationItem): string {
  const category = normalizeText((item as any)?.category || '');
  if (category) return category;
  return itemRoleKey(item);
}

function itemBrandKey(item: RecommendationItem): string {
  return normalizeText((item as any)?.brand || '');
}

function itemColorKey(item: RecommendationItem): string {
  const fromName = normalizeText(item.colorName || '');
  if (fromName) return fromName;
  const list = Array.isArray((item as any)?.colors) ? ((item as any).colors as string[]) : [];
  return normalizeText(list[0] || '');
}

function itemTagKeys(item: RecommendationItem): string[] {
  const tags = Array.isArray((item as any)?.tags) ? ((item as any).tags as string[]) : [];
  const entities = Array.isArray((item as any)?.entities) ? ((item as any).entities as string[]) : [];
  const base = tokenList([
    ...tags.slice(0, 8),
    ...entities.slice(0, 6),
    item.title,
    (item as any)?.category,
    (item as any)?.brand,
  ]);
  return base.slice(0, 10);
}

export function toLikedSet(likedIds: Set<string> | string[]): Set<string> {
  if (likedIds instanceof Set) return likedIds;
  return new Set(likedIds || []);
}

function listingLikeCandidates(item: RecommendationItem): string[] {
  const id = String(item.id || '').trim();
  const listingId = String((item as any)?.listingId || '').trim();
  const out = new Set<string>();
  if (id) out.add(id);
  if (listingId) {
    out.add(`listing:${listingId}`);
    out.add(`real-listing-${listingId}`);
    out.add(`liked-listing:${listingId}`);
    out.add(listingId);
  }
  if (id.startsWith('listing:')) {
    const raw = id.slice('listing:'.length);
    out.add(raw);
    out.add(`listing:${raw}`);
  }
  if (id.startsWith('real-listing-')) {
    const raw = id.slice('real-listing-'.length);
    out.add(raw);
    out.add(`listing:${raw}`);
  }
  if (id.startsWith('liked-listing:')) {
    const raw = id.slice('liked-listing:'.length);
    out.add(raw);
    out.add(`listing:${raw}`);
  }
  return Array.from(out);
}

export function isItemLiked(item: RecommendationItem, likedSet: Set<string>): boolean {
  const candidates = listingLikeCandidates(item);
  for (let i = 0; i < candidates.length; i += 1) {
    if (likedSet.has(candidates[i])) return true;
  }
  return false;
}

export function popularityValue(item: RecommendationItem): number {
  const raw = Number((item as any)?.likeCount ?? (item as any)?.likes ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, raw);
}

export function deterministicJitter(seed: string): number {
  const text = String(seed || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

export function buildTasteProfile(items: RecommendationItem[], likedSet: Set<string>): TasteProfile {
  const profile: TasteProfile = {
    likedCount: 0,
    roles: createBucket(),
    categories: createBucket(),
    tags: createBucket(),
    colors: createBucket(),
    brands: createBucket(),
    topRoles: new Set<string>(),
    topCategories: new Set<string>(),
  };

  items.forEach((item) => {
    if (!isItemLiked(item, likedSet)) return;
    profile.likedCount += 1;
    bump(profile.roles, itemRoleKey(item), 1.2);
    bump(profile.categories, itemCategoryKey(item), 1.3);
    bump(profile.colors, itemColorKey(item), 0.7);
    bump(profile.brands, itemBrandKey(item), 0.7);
    itemTagKeys(item).forEach((tag) => bump(profile.tags, tag, 0.35));
  });

  profile.topRoles = topKeys(profile.roles, 2);
  profile.topCategories = topKeys(profile.categories, 3);
  return profile;
}

export function affinityScore(item: RecommendationItem, profile: TasteProfile): number {
  if (profile.likedCount <= 0) return 0;
  const role = bucketScore(profile.roles, itemRoleKey(item));
  const category = bucketScore(profile.categories, itemCategoryKey(item));
  const color = bucketScore(profile.colors, itemColorKey(item));
  const brand = bucketScore(profile.brands, itemBrandKey(item));
  const tags = itemTagKeys(item);
  let tagScore = 0;
  if (tags.length) {
    const hitSum = tags.reduce((sum, tag) => sum + bucketScore(profile.tags, tag), 0);
    tagScore = Math.min(1, hitSum / Math.min(tags.length, 6));
  }
  return role * 0.3 + category * 0.28 + tagScore * 0.24 + color * 0.1 + brand * 0.08;
}

