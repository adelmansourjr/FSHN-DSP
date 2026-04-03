import { COLOUR_OPTIONS } from '../data/catalog';
import { normalizeParcelProfile, type ParcelProfile } from './shippingCo';

export type ListingEditorPhoto = {
  uri: string;
  storagePath?: string | null;
};

export type ListingEditorState = {
  photos: ListingEditorPhoto[];
  title: string;
  description: string;
  category: string | null;
  parcelProfile: ParcelProfile | null;
  gender: string | null;
  size: string | null;
  condition: string | null;
  brand: string;
  color: string;
  price: string;
  originalPrice: string;
  tags: string[];
};

export type UploadEditorMode =
  | { kind: 'create' }
  | { kind: 'draft'; draftId: string }
  | { kind: 'listing'; listingId: string };

export type UploadEditorRequest = {
  requestId: string;
  mode: UploadEditorMode;
  form: ListingEditorState;
};

const safeString = (value: unknown) => String(value || '').trim();

const COLOUR_SET = new Set<string>(COLOUR_OPTIONS as readonly string[]);

export const normalizeListingColor = (value: unknown): string | null => {
  const raw = safeString(value).toLowerCase();
  if (!raw) return null;
  if (COLOUR_SET.has(raw)) return raw;

  if (/\b(black|jet|onyx|ebony)\b/.test(raw)) return 'black';
  if (/\b(white|ivory|off white|offwhite)\b/.test(raw)) return 'white';
  if (/\b(grey|gray|charcoal|silver|slate)\b/.test(raw)) return 'grey';
  if (/\b(red|burgundy|maroon|crimson)\b/.test(raw)) return 'red';
  if (/\b(blue|navy|cobalt|indigo|denim)\b/.test(raw)) return 'blue';
  if (/\b(green|olive|sage|khaki)\b/.test(raw)) return 'green';
  if (/\b(beige|cream|tan|sand|camel|taupe|stone)\b/.test(raw)) return 'beige';
  if (/\b(brown|chocolate|mocha|espresso)\b/.test(raw)) return 'brown';
  if (/\b(pink|rose|fuchsia|blush)\b/.test(raw)) return 'pink';
  if (/\b(yellow|gold|mustard|amber|orange)\b/.test(raw)) return 'yellow';
  if (/\b(purple|violet|lavender|lilac|plum)\b/.test(raw)) return 'purple';

  return null;
};

export const parseListingColors = (raw: unknown): string[] => {
  const values = Array.isArray(raw)
    ? raw
    : safeString(raw)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
  const next: string[] = [];
  const seen = new Set<string>();
  values.forEach((entry) => {
    const normalized = normalizeListingColor(entry);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    next.push(normalized);
  });
  return next;
};

export const serializeListingColors = (raw: unknown) => parseListingColors(raw).join(', ');

const sanitizePhotos = (raw: unknown): ListingEditorPhoto[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const uri = safeString((entry as any)?.uri);
      if (!uri) return null;
      const storagePath = safeString((entry as any)?.storagePath) || null;
      return { uri, storagePath };
    })
    .filter(Boolean)
    .slice(0, 24) as ListingEditorPhoto[];
};

const sanitizeTags = (raw: unknown) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  raw.forEach((entry) => {
    const tag = safeString(entry);
    if (!tag) return;
    const key = tag.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(tag);
  });
  return tags.slice(0, 40);
};

export const createEmptyListingEditorState = (): ListingEditorState => ({
  photos: [],
  title: '',
  description: '',
  category: null,
  parcelProfile: null,
  gender: null,
  size: null,
  condition: null,
  brand: '',
  color: '',
  price: '',
  originalPrice: '',
  tags: [],
});

export const cloneListingEditorState = (raw?: Partial<ListingEditorState> | null): ListingEditorState => ({
  photos: sanitizePhotos(raw?.photos),
  title: safeString(raw?.title),
  description: safeString(raw?.description),
  category: safeString(raw?.category) || null,
  parcelProfile: normalizeParcelProfile((raw as any)?.parcelProfile),
  gender: safeString(raw?.gender) || null,
  size: safeString(raw?.size) || null,
  condition: safeString(raw?.condition) || null,
  brand: safeString(raw?.brand),
  color: serializeListingColors((raw as any)?.colors ?? raw?.color),
  price: safeString(raw?.price),
  originalPrice: safeString(raw?.originalPrice),
  tags: sanitizeTags(raw?.tags),
});

export const hasMeaningfulListingContent = (listing: ListingEditorState) => {
  return Boolean(
    listing.photos.length ||
      safeString(listing.title) ||
      safeString(listing.description) ||
      safeString(listing.category) ||
      safeString(listing.parcelProfile) ||
      safeString(listing.gender) ||
      safeString(listing.size) ||
      safeString(listing.condition) ||
      safeString(listing.brand) ||
      parseListingColors(listing.color).length ||
      safeString(listing.price) ||
      listing.tags.length
  );
};

export const listingEditorStatesEqual = (
  left?: ListingEditorState | null,
  right?: ListingEditorState | null
) => {
  const a = cloneListingEditorState(left || undefined);
  const b = cloneListingEditorState(right || undefined);

  if (a.title !== b.title) return false;
  if (a.description !== b.description) return false;
  if ((a.category || '') !== (b.category || '')) return false;
  if ((a.parcelProfile || '') !== (b.parcelProfile || '')) return false;
  if ((a.gender || '') !== (b.gender || '')) return false;
  if ((a.size || '') !== (b.size || '')) return false;
  if ((a.condition || '') !== (b.condition || '')) return false;
  if (a.brand !== b.brand) return false;
  if (a.color !== b.color) return false;
  if (a.price !== b.price) return false;
  if (a.originalPrice !== b.originalPrice) return false;
  if (a.tags.length !== b.tags.length) return false;
  if (a.photos.length !== b.photos.length) return false;

  for (let index = 0; index < a.tags.length; index += 1) {
    if (a.tags[index] !== b.tags[index]) return false;
  }

  for (let index = 0; index < a.photos.length; index += 1) {
    const leftPhoto = a.photos[index];
    const rightPhoto = b.photos[index];
    if (!leftPhoto || !rightPhoto) return false;
    if (leftPhoto.uri !== rightPhoto.uri) return false;
    if ((leftPhoto.storagePath || '') !== (rightPhoto.storagePath || '')) return false;
  }

  return true;
};

export const isRemoteListingPhotoUri = (uri?: string | null) => /^https?:\/\//i.test(safeString(uri));
