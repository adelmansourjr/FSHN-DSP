import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GarmentMap } from '../components/studio/ClothingSelectorModal';
import type { ProductLike } from '../components/ProductModal';

type Listener = (selection: TryOnSelection) => void;

export type TryOnSelection = {
  garments: Partial<GarmentMap>;
  openSelector?: boolean;
};

let pending: TryOnSelection | null = null;
const listeners = new Set<Listener>();
const STORAGE_KEY = 'tryon.selection';

export function setTryOnSelection(selection: TryOnSelection) {
  console.log('[TryOnSelection] set', selection);
  pending = selection;
  listeners.forEach((cb) => cb(selection));
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(selection)).then(
    () => console.log('[TryOnSelection] persisted'),
    (err) => console.warn('[TryOnSelection] persist failed', err)
  );
}

export function consumeTryOnSelection(): TryOnSelection | null {
  const next = pending;
  pending = null;
  if (next) console.log('[TryOnSelection] consume in-memory', next);
  return next;
}

export async function consumeStoredTryOnSelection(): Promise<TryOnSelection | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    await AsyncStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as TryOnSelection;
    console.log('[TryOnSelection] consume stored', parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function subscribeTryOnSelection(cb: Listener) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const normalize = (value?: string | null) => String(value || '').toLowerCase();

export function buildSelectionFromProduct(product?: ProductLike | null): TryOnSelection | null {
  if (!product) return null;
  const image = product.images?.[0] || product.image || product.photos?.[0]?.uri || null;
  if (!image) return null;

  const category = normalize(product.category);
  const text = [
    product.title,
    product.description,
    product.category,
    ...(product.tags || []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let key: keyof GarmentMap | null = null;

  if (category.includes('shoe') || /\b(shoe|sneaker|boot|footwear)\b/.test(text)) key = 'shoes';
  else if (category.includes('dress') || category.includes('mono') || /\b(dress|gown|one-piece|onesie)\b/.test(text)) key = 'mono';
  else if (category.includes('bottom') || /\b(jean|pant|trouser|short|skirt)\b/.test(text)) key = 'bottom';
  else if (category.includes('top') || category.includes('outer') || /\b(tee|shirt|hoodie|jacket|coat|sweater|top)\b/.test(text)) key = 'top';

  if (!key) key = 'top';

  return { garments: { [key]: image }, openSelector: true };
}

export function buildSelectionFromOutfit(garments: Partial<GarmentMap>): TryOnSelection | null {
  if (!garments || Object.values(garments).every((v) => !v)) return null;
  return { garments, openSelector: true };
}
