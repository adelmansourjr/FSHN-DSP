import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { doc, onSnapshot } from 'firebase/firestore';
import type { ProductLike } from '../components/ProductModal';
import { db } from '../lib/firebase';
import { listingDataToProductLike } from '../lib/firestoreMappers';

export type CartItem = {
  id: string;
  listingId?: string;
  sellerUid?: string;
  title: string;
  price: number;
  uri?: string;
  qty?: number;
  product?: ProductLike;
};

type CartContextShape = {
  items: CartItem[];
  selectedIds: string[];
  add: (item: CartItem) => void;
  contains: (item: Pick<CartItem, 'id' | 'listingId' | 'product'>) => boolean;
  remove: (id: string) => void;
  removeMany: (ids: string[]) => void;
  clear: () => void;
  isSelected: (id: string) => boolean;
  toggleSelected: (id: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  total: () => number;
};

const CartContext = createContext<CartContextShape>({
  items: [],
  selectedIds: [],
  add: () => {},
  contains: () => false,
  remove: () => {},
  removeMany: () => {},
  clear: () => {},
  isSelected: () => false,
  toggleSelected: () => {},
  selectAll: () => {},
  clearSelection: () => {},
  total: () => 0,
});

export const useCart = () => useContext(CartContext);

const CART_STORAGE_KEY = 'fshn.cart.v1';

type CartState = {
  items: CartItem[];
  selectedIds: string[];
};

function getCartItemListingId(item: CartItem): string {
  const explicit = String(item.listingId || item.product?.listingId || '').trim();
  if (explicit) return explicit;

  const productId = String(item.product?.id || '').trim();
  if (productId.startsWith('listing:')) return productId.slice('listing:'.length);
  if (productId.startsWith('real-listing-')) return productId.slice('real-listing-'.length);

  const rawId = String(item.id || '').trim();
  if (!rawId) return '';
  if (rawId.startsWith('listing:')) return rawId.slice('listing:'.length);
  if (rawId.startsWith('real-listing-')) return rawId.slice('real-listing-'.length);
  return '';
}

function getCartIdentity(item: Pick<CartItem, 'id' | 'listingId' | 'product'>): string {
  const listingId = getCartItemListingId(item as CartItem);
  if (listingId) return `listing:${listingId}`;
  const rawId = String(item.id || '').trim();
  if (rawId) return `id:${rawId}`;
  return '';
}

function sanitizeCartItem(raw: any): CartItem | null {
  const id = String(raw?.id || '').trim();
  const title = String(raw?.title || '').trim();
  if (!id || !title) return null;

  const price = Number(raw?.price);
  const qty = Math.max(1, Math.round(Number(raw?.qty) || 1));
  const listingId = getCartItemListingId(raw as CartItem) || undefined;
  const sellerUid = String(raw?.sellerUid || raw?.product?.sellerUid || '').trim() || undefined;
  const uri = String(raw?.uri || raw?.product?.image || '').trim() || undefined;
  const product =
    raw?.product && typeof raw.product === 'object'
      ? (raw.product as ProductLike)
      : undefined;

  return {
    id,
    listingId,
    sellerUid,
    title,
    price: Number.isFinite(price) ? Math.max(0, price) : 0,
    uri,
    qty,
    product,
  };
}

function resolveListingPriceValue(data: any) {
  const amount = Number(data?.price?.amount);
  if (Number.isFinite(amount) && amount >= 0) {
    return Math.max(0, amount) / 100;
  }
  const fallback = Number(data?.price);
  if (Number.isFinite(fallback) && fallback >= 0) {
    return fallback > 999 ? fallback / 100 : fallback;
  }
  return 0;
}

function dedupeCartItems(items: CartItem[]) {
  const seen = new Set<string>();
  const next: CartItem[] = [];

  items.forEach((item) => {
    const identity = getCartIdentity(item);
    if (!identity || seen.has(identity)) return;
    seen.add(identity);
    next.push(item);
  });

  return next;
}

function normalizeSelectedIds(items: CartItem[], rawSelectedIds: unknown, fallbackToAll: boolean) {
  const itemIds = new Set(items.map((item) => item.id));
  const parsed = Array.isArray(rawSelectedIds)
    ? rawSelectedIds
        .map((value) => String(value || '').trim())
        .filter((value) => itemIds.has(value))
    : [];

  if (Array.isArray(rawSelectedIds)) {
    return Array.from(new Set(parsed));
  }

  return fallbackToAll ? items.map((item) => item.id) : [];
}

function sanitizeStoredCartState(raw: any): CartState {
  if (Array.isArray(raw)) {
    const items = dedupeCartItems(raw.map((entry) => sanitizeCartItem(entry)).filter(Boolean) as CartItem[]);
    return {
      items,
      selectedIds: items.map((item) => item.id),
    };
  }

  const items = Array.isArray(raw?.items)
    ? dedupeCartItems(raw.items.map((entry: any) => sanitizeCartItem(entry)).filter(Boolean) as CartItem[])
    : [];

  return {
    items,
    selectedIds: normalizeSelectedIds(items, raw?.selectedIds, !Array.isArray(raw?.selectedIds)),
  };
}

function mergeCartStates(base: CartState, incoming: CartState): CartState {
  const mergedItems = dedupeCartItems([...base.items, ...incoming.items]);
  const mergedSelectedIds = normalizeSelectedIds(
    mergedItems,
    [...base.selectedIds, ...incoming.selectedIds],
    false
  );
  return {
    items: mergedItems,
    selectedIds: mergedSelectedIds,
  };
}

export const CartProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [cartState, setCartState] = useState<CartState>({ items: [], selectedIds: [] });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let mounted = true;

    const loadStoredCart = async () => {
      try {
        const raw = await AsyncStorage.getItem(CART_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        const storedState = sanitizeStoredCartState(parsed);
        if (!mounted) return;
        setCartState((prev) => mergeCartStates(storedState, prev));
      } catch {
        // Ignore invalid persisted cart data.
      } finally {
        if (mounted) setHydrated(true);
      }
    };

    void loadStoredCart();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    void AsyncStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cartState));
  }, [cartState, hydrated]);

  const add = (item: CartItem) => {
    const nextItem = sanitizeCartItem(item);
    if (!nextItem) return;

    setCartState((prev) => {
      const prevItems = prev.items;
      const prevSelectedIds = prev.selectedIds;
      const incomingIdentity = getCartIdentity(nextItem);
      if (!incomingIdentity) return prev;

      const alreadyInCart = prevItems.some((p) => getCartIdentity(p) === incomingIdentity);
      if (alreadyInCart) return prev;

      const nextItems = [...prevItems, nextItem];
      const nextSelectedIds = normalizeSelectedIds(
        nextItems,
        [...prevSelectedIds, nextItem.id],
        false
      );
      return { items: nextItems, selectedIds: nextSelectedIds };
    });
  };

  const contains = (item: Pick<CartItem, 'id' | 'listingId' | 'product'>) => {
    const identity = getCartIdentity(item);
    if (!identity) return false;
    return cartState.items.some((it) => getCartIdentity(it) === identity);
  };

  const remove = (id: string) =>
    setCartState((prev) => {
      const nextItems = prev.items.filter((p) => p.id !== id);
      if (nextItems.length === prev.items.length) return prev;
      return {
        items: nextItems,
        selectedIds: normalizeSelectedIds(nextItems, prev.selectedIds.filter((entry) => entry !== id), false),
      };
    });

  const removeMany = (ids: string[]) => {
    const idSet = new Set(ids.filter(Boolean));
    if (!idSet.size) return;
    setCartState((prev) => {
      const nextItems = prev.items.filter((p) => !idSet.has(p.id));
      if (nextItems.length === prev.items.length) return prev;
      return {
        items: nextItems,
        selectedIds: normalizeSelectedIds(
          nextItems,
          prev.selectedIds.filter((entry) => !idSet.has(entry)),
          false
        ),
      };
    });
  };

  const clear = () => setCartState({ items: [], selectedIds: [] });

  const isSelected = (id: string) => cartState.selectedIds.includes(id);

  const toggleSelected = (id: string) => {
    setCartState((prev) => {
      if (!prev.items.some((item) => item.id === id)) return prev;
      const selected = prev.selectedIds.includes(id);
      const nextSelectedIds = selected
        ? prev.selectedIds.filter((entry) => entry !== id)
        : [...prev.selectedIds, id];
      return {
        items: prev.items,
        selectedIds: normalizeSelectedIds(prev.items, nextSelectedIds, false),
      };
    });
  };

  const selectAll = () =>
    setCartState((prev) => ({
      items: prev.items,
      selectedIds: prev.items.map((item) => item.id),
    }));

  const clearSelection = () =>
    setCartState((prev) => ({
      items: prev.items,
      selectedIds: [],
    }));

  const total = () => cartState.items.reduce((s, it) => s + (it.price || 0) * (it.qty || 1), 0);

  const listingIds = useMemo(
    () => Array.from(new Set(cartState.items.map(getCartItemListingId).filter(Boolean))),
    [cartState.items]
  );

  useEffect(() => {
    if (!listingIds.length) return;
    const unavailableStatuses = new Set(['sold', 'archived', 'removed', 'disabled', 'banned']);
    const unsubs = listingIds.map((listingId) =>
      onSnapshot(
        doc(db, 'listings', listingId),
        (snap) => {
          const status = String(snap.data()?.status || '').toLowerCase();
          const shouldRemove = !snap.exists() || unavailableStatuses.has(status);
          const data = snap.data() || {};
          const product = snap.exists() ? listingDataToProductLike(listingId, data) : null;

          setCartState((prev) => {
            if (shouldRemove) {
              const nextItems = prev.items.filter((item) => getCartItemListingId(item) !== listingId);
              if (nextItems.length === prev.items.length) return prev;
              return {
                items: nextItems,
                selectedIds: normalizeSelectedIds(nextItems, prev.selectedIds, false),
              };
            }

            let changed = false;
            const nextItems = prev.items.map((item) => {
              if (getCartItemListingId(item) !== listingId) return item;

              const nextTitle = String(product?.title || data?.title || item.title || '').trim() || item.title;
              const nextPrice = resolveListingPriceValue(data);
              const nextUri =
                String(product?.image || data?.primeImage?.url || item.uri || '').trim() || item.uri;
              const nextSellerUid =
                String(product?.sellerUid || data?.sellerUid || item.sellerUid || '').trim() || item.sellerUid;
              const nextProduct = product
                ? {
                    ...(item.product || {}),
                    ...product,
                  }
                : item.product;
              const sameProduct =
                !product ||
                (item.product?.listingId === nextProduct?.listingId &&
                  item.product?.title === nextProduct?.title &&
                  item.product?.price === nextProduct?.price &&
                  item.product?.image === nextProduct?.image &&
                  item.product?.parcelProfile === nextProduct?.parcelProfile);

              if (
                item.listingId === listingId &&
                item.title === nextTitle &&
                item.price === nextPrice &&
                item.uri === nextUri &&
                item.sellerUid === nextSellerUid &&
                sameProduct
              ) {
                return item;
              }

              changed = true;
              return {
                ...item,
                listingId,
                title: nextTitle,
                price: nextPrice,
                uri: nextUri,
                sellerUid: nextSellerUid,
                product: nextProduct,
              };
            });

            if (!changed) return prev;
            return {
              items: nextItems,
              selectedIds: normalizeSelectedIds(nextItems, prev.selectedIds, false),
            };
          });
        },
        (error) => {
          if (error?.code === 'permission-denied') return;
          console.warn('[Cart] listing listener error', { listingId, error });
        }
      )
    );
    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [listingIds]);

  return (
    <CartContext.Provider
      value={{
        items: cartState.items,
        selectedIds: cartState.selectedIds,
        add,
        contains,
        remove,
        removeMany,
        clear,
        isSelected,
        toggleSelected,
        selectAll,
        clearSelection,
        total,
      }}
    >
      {children}
    </CartContext.Provider>
  );
};

export default CartContext;
