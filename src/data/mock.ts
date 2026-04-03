// src/data/mock.ts
// Temporary mock data to visualize layout (now backed by local catalog images)

import { Asset } from 'expo-asset';
import { IMAGE_MODULE_MAP } from './imageMap';
import { catalogItems } from './catalog';

export type Item = {
  id: string;
  title: string;
  image: string;
  imagePath?: string;
  price?: string | null;
  role?: 'top' | 'bottom' | 'dress' | 'outer' | 'shoes' | 'accessory';
  /** Optional single color info for ProductModal display */
  colorName?: string | null;
  colorHex?: string | null;
  brand?: string | null;
  category?: string | null;
  sub?: string | null;
  gender?: string | null;
  tags?: string[];
  keywords?: string[];
  entities?: string[];
  colors?: string[];
};

const MODEL_IMAGES = [
  'https://images.unsplash.com/photo-1548142813-c348350df52b?q=80&w=840&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1542291026-7eec264c27ff?q=80&w=840&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1512436991641-6745cdb1723f?q=80&w=840&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1520975930038-d6cc5258f7f4?q=80&w=840&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1542060748-10c28b62716c?q=80&w=840&auto=format&fit=crop',
];

const COLOR_HEX: Record<string, string> = {
  black: '#111111',
  white: '#f4f4f4',
  grey: '#b6b6b6',
  red: '#c62828',
  blue: '#1e3a8a',
  green: '#2e7d32',
  beige: '#e6d3b3',
  brown: '#6d4c41',
  pink: '#ec407a',
  yellow: '#f9a825',
  purple: '#6a1b9a',
};

const toTitleCase = (value: string) =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());

const normalizeSearchText = (value?: string | null) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const looksLikeCatalogId = (value?: string | null) => {
  const raw = String(value || '').trim();
  if (!raw) return true;
  const letters = raw.replace(/[^a-z]/gi, '');
  if (!letters) return true;
  return /^[0-9\s._-]+$/.test(raw);
};

const GENERIC_ENTITY_STOPWORDS = new Set([
  'farfetch',
  'clothing',
  'express',
  'pocket',
  'belt',
  'light',
  'wide',
  'leg',
  'unisex',
  'men',
  'women',
]);
const BRAND_ENTITY_RE =
  /\b(nike|adidas|puma|balenciaga|timberland|zara|gucci|prada|dior|lv|north face|patagonia|reebok|new balance|h&m|uniqlo|yeezy|gap|vetements)\b/i;

const inferCatalogBrand = (item: (typeof catalogItems)[number]) => {
  const meta = Array.isArray((item as any)?.entityMeta) ? ((item as any).entityMeta as Array<{ text?: string; type?: string }>) : [];
  const brandMeta = meta.find((entry) => entry?.type === 'brand' && String(entry?.text || '').trim());
  if (brandMeta?.text) return toTitleCase(brandMeta.text);

  const brandedEntity = (item.entities || []).find((entity) => BRAND_ENTITY_RE.test(String(entity || '')));
  return brandedEntity ? toTitleCase(brandedEntity) : null;
};

const pickCatalogTitleSource = (item: (typeof catalogItems)[number]) => {
  const direct = String(item.name || item.name_normalized || '').trim();
  if (direct && !looksLikeCatalogId(direct)) return direct;

  const subValue = normalizeSearchText(item.sub || '');
  const metaTexts = Array.isArray((item as any)?.entityMeta)
    ? ((item as any).entityMeta as Array<{ text?: string; weight?: number }>)
        .sort((a, b) => Number(b?.weight || 0) - Number(a?.weight || 0))
        .map((entry) => String(entry?.text || '').trim())
    : [];
  const rawCandidates = [...metaTexts, ...(Array.isArray(item.entities) ? item.entities : [])];

  const candidates = rawCandidates.filter((candidate) => {
    const normalized = normalizeSearchText(candidate);
    if (!normalized || looksLikeCatalogId(candidate)) return false;
    if (GENERIC_ENTITY_STOPWORDS.has(normalized)) return false;
    return normalized.split(' ').length <= 6;
  });

  const subMatches = candidates
    .filter((candidate) => {
      const normalized = normalizeSearchText(candidate);
      return subValue && normalized.includes(subValue);
    })
    .sort((a, b) => {
      const wordDelta = b.split(' ').length - a.split(' ').length;
      if (wordDelta !== 0) return wordDelta;
      return b.length - a.length;
    });
  if (subMatches[0]) return subMatches[0];

  return candidates[0] || item.sub || item.category || 'Item';
};

const assetUriFor = (imagePath: string): string | null => {
  if (/^(?:https?:)?\/\//i.test(String(imagePath || '').trim())) {
    return imagePath;
  }
  const moduleId = IMAGE_MODULE_MAP[imagePath];
  if (!moduleId) return null;
  return Asset.fromModule(moduleId).uri ?? null;
};

const roleFromCategory = (category?: string | null): Item['role'] | undefined => {
  switch (category) {
    case 'top':
      return 'top';
    case 'bottom':
      return 'bottom';
    case 'shoes':
      return 'shoes';
    case 'mono':
      return 'dress';
    default:
      return undefined;
  }
};

const priceFromIndex = (i: number) => `£${Math.round(34 + (i % 11) * 6 + (i % 3) * 4)}`;

const buildCatalogItems = (): Item[] => {
  return catalogItems
    .map((item, index) => {
      const image = assetUriFor(item.imagePath);
      if (!image) return null;
      const titleSource = pickCatalogTitleSource(item);
      const colorName = item.colours?.[0] ?? null;
      const tags = Array.from(
        new Set(
          [
            ...(Array.isArray(item.entities) ? item.entities : []),
            ...(Array.isArray((item as any)?.entityMeta)
              ? ((item as any).entityMeta as Array<{ text?: string }>).map((entry) => entry?.text || '')
              : []),
            ...(Array.isArray(item.colours) ? item.colours : []),
            ...(Array.isArray(item.vibes) ? item.vibes : []),
            item.sub || '',
            item.category || '',
            item.name || '',
            item.name_normalized || '',
          ]
            .map((value) => String(value || '').trim())
            .filter(Boolean)
        )
      );
      const brand = inferCatalogBrand(item);
      const mapped: Item = {
        id: item.id,
        title: toTitleCase(titleSource),
        image,
        imagePath: item.imagePath,
        price: priceFromIndex(index),
        role: roleFromCategory(item.category),
        colorName: colorName ? toTitleCase(String(colorName)) : null,
        colorHex: colorName ? COLOR_HEX[String(colorName)] : null,
        brand,
        gender: item.gender || undefined,
        category: item.category || undefined,
        sub: item.sub || undefined,
        tags,
        keywords: tags,
        entities: Array.isArray(item.entities) ? item.entities : [],
        colors: Array.isArray(item.colours) ? item.colours : [],
      };
      return mapped;
    })
    .filter((it): it is Item => Boolean(it));
};

const buildImageMapExtras = (existingIds: Set<string>): Item[] => {
  return Object.keys(IMAGE_MODULE_MAP)
    .map((imagePath, index) => {
      if (existingIds.has(imagePath)) return null;
      const image = assetUriFor(imagePath);
      if (!image) return null;
      const filename = imagePath.split('/').pop() || imagePath;
      const base = filename.replace(/\.[^.]+$/, '');
      return {
        id: imagePath,
        title: toTitleCase(base),
        image,
        imagePath,
        price: priceFromIndex(200 + index),
      } as Item;
    })
    .filter((it): it is Item => Boolean(it));
};

const CATALOG_ITEMS = buildCatalogItems();
const catalogImagePaths = new Set(catalogItems.map((item) => item.imagePath));
const EXTRA_ITEMS = buildImageMapExtras(catalogImagePaths);
const ALL_ITEMS = [...CATALOG_ITEMS, ...EXTRA_ITEMS];

const partitionItems = (items: Item[]) => {
  const recentlyTried: Item[] = [];
  const trending: Item[] = [];
  const discover: Item[] = [];

  items.forEach((item, idx) => {
    const bucket = idx % 3;
    if (bucket === 0) recentlyTried.push(item);
    else if (bucket === 1) trending.push(item);
    else discover.push(item);
  });

  return { recentlyTried, trending, discover };
};

const { recentlyTried, trending, discover } = partitionItems(ALL_ITEMS);

const firstByRole = (role: Item['role']) => ALL_ITEMS.find((it) => it.role === role)?.image ?? null;

export const mock = {
  modelUri: MODEL_IMAGES[0],
  modelUris: MODEL_IMAGES,

  topUri: firstByRole('top') ?? MODEL_IMAGES[1],
  bottomUri: firstByRole('bottom') ?? MODEL_IMAGES[2],
  shoesUri: firstByRole('shoes') ?? MODEL_IMAGES[3],

  allItems: ALL_ITEMS,
  recentlyTried,
  trending,
  discover,
};
