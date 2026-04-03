// src/data/wishlist.ts
import AsyncStorage from '@react-native-async-storage/async-storage';

export type WishlistItem = {
  id: string;
  title?: string | null;
  brand?: string | null;
  price?: string | null;
  image?: string | null;
  productUrl?: string | null;
};

const STORAGE_KEY = '@fshn:wishlist';
let cache: Record<string, WishlistItem> = {};
let ready = false;
const subscribers = new Set<() => void>();

async function syncStorage() {
  try {
    const payload = Object.values(cache);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore write failures
  }
}

async function hydrate() {
  if (ready) return;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const list = JSON.parse(raw) as WishlistItem[];
      cache = list?.reduce((acc, item) => {
        if (item?.id) acc[item.id] = item;
        return acc;
      }, {} as Record<string, WishlistItem>) ?? {};
    }
  } catch {
    cache = {};
  }
  ready = true;
}

export async function warmWishlist(): Promise<void> {
  await hydrate();
}

export function isWishedSync(id: string | null) {
  if (!id) return false;
  return Boolean(cache[id]);
}

export async function toggleWishlist(item: WishlistItem): Promise<boolean> {
  const id = item.id;
  if (!id) return false;
  await hydrate();
  const has = Boolean(cache[id]);
  if (has) {
    delete cache[id];
  } else {
    cache[id] = { ...item };
  }
  subscribers.forEach((cb) => cb());
  await syncStorage();
  return !has;
}

export function subscribeWishlist(cb: () => void) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
