import Constants from 'expo-constants';
import originalCatalogJson from './index.json';
import farfetchCatalogJson from './index.classifiedfarfetch.json';
import { IMAGE_MODULE_MAP } from './imageMap';

const extra = (Constants?.expoConfig?.extra ?? {}) as Record<string, any>;
const FARFETCH_CATALOG_BASE_URL = String(
  extra.EXPO_PUBLIC_FARFETCH_CATALOG_BASE_URL ??
    process.env.EXPO_PUBLIC_FARFETCH_CATALOG_BASE_URL ??
    '',
).trim();
const FARFETCH_IMAGE_URL_TEMPLATE = String(
  extra.EXPO_PUBLIC_FARFETCH_IMAGE_URL_TEMPLATE ??
    process.env.EXPO_PUBLIC_FARFETCH_IMAGE_URL_TEMPLATE ??
    '',
).trim();
const FIREBASE_STORAGE_BUCKET = String(
  extra.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ??
    process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ??
    'fshn-6a61b.firebasestorage.app',
).trim();

export type CategoryMain = 'top' | 'bottom' | 'shoes' | 'mono';
export type Gender = 'men' | 'women' | 'unisex';
export const COLOUR_OPTIONS = [
  'black',
  'white',
  'grey',
  'red',
  'blue',
  'green',
  'beige',
  'brown',
  'pink',
  'yellow',
  'purple',
] as const;

export type Colour =
  | 'black'
  | 'white'
  | 'grey'
  | 'red'
  | 'blue'
  | 'green'
  | 'beige'
  | 'brown'
  | 'pink'
  | 'yellow'
  | 'purple';
export type Vibe =
  | 'streetwear'
  | 'edgy'
  | 'minimal'
  | 'y2k'
  | 'techwear'
  | 'sporty'
  | 'preppy'
  | 'vintage'
  | 'chic'
  | 'formal'
  | 'comfy';
export type OccasionTag = 'smart_casual' | 'formal' | 'evening' | 'lounge' | 'sleepwear';
export type Fit = 'oversized' | 'regular' | 'slim' | 'cropped';
export type Sport = 'football' | 'basketball' | 'running' | 'tennis' | 'gym' | 'other' | 'none';

export interface EntityMeta {
  text: string;
  weight: number;
  type: 'brand' | 'team' | 'sponsor' | 'generic';
}

export interface SportMeta {
  sport?: Sport | string | null;
  teams?: string[];
  isKit?: boolean;
}

export interface CatalogItem {
  id: string;
  imagePath: string;
  category: CategoryMain;
  sub?: string | null;
  colours: Colour[];
  vibes: Vibe[];
  gender: Gender;
  fit?: Fit | null;
  sportMeta?: SportMeta | null;
  name?: string | null;
  name_normalized?: string | null;
  entities?: string[];
  entityMeta?: EntityMeta[];
  occasion_tags?: OccasionTag[];
  style_markers?: string[];
  formality_score?: number | null;
  streetwear_score?: number | null;
  cleanliness_score?: number | null;
  confidence?: Record<string, number | null> | null;
}

function isRemoteImagePath(value: string) {
  return /^(?:https?:)?\/\//i.test(value) || /^gs:\/\//i.test(value);
}

function defaultFarfetchImageUrl(fileName: string) {
  return `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_STORAGE_BUCKET}/o/${encodeURIComponent(`catalog/farfetch/${fileName}`)}?alt=media`;
}

function bundledFarfetchImagePath(fileName: string) {
  return `images farfetch/${fileName}`;
}

function resolveFarfetchImagePath(imagePath: string) {
  const raw = String(imagePath || '').trim();
  if (!raw) return raw;
  if (isRemoteImagePath(raw)) return raw;

  const fileName = raw.split('/').filter(Boolean).pop() || raw;
  if (!fileName) return raw;
  const bundledPath = bundledFarfetchImagePath(fileName);
  if (IMAGE_MODULE_MAP[bundledPath]) return bundledPath;

  if (FARFETCH_IMAGE_URL_TEMPLATE.includes('{fileName}')) {
    return FARFETCH_IMAGE_URL_TEMPLATE.replaceAll('{fileName}', encodeURIComponent(fileName));
  }

  if (FARFETCH_CATALOG_BASE_URL) {
    return `${FARFETCH_CATALOG_BASE_URL.replace(/\/+$/, '')}/${encodeURIComponent(fileName)}`;
  }
  return defaultFarfetchImageUrl(fileName);
}

function normalizeOriginalItems(items: CatalogItem[]): CatalogItem[] {
  return Array.isArray(items) ? items : [];
}

function normalizeFarfetchItems(items: CatalogItem[]): CatalogItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    ...item,
    id: `farfetch:${item.id}`,
    imagePath: resolveFarfetchImagePath(item.imagePath),
  }));
}

export const catalogItems = [
  ...normalizeOriginalItems(originalCatalogJson as CatalogItem[]),
  ...normalizeFarfetchItems(farfetchCatalogJson as CatalogItem[]),
] as CatalogItem[];
