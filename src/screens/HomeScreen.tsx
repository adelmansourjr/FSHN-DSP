import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { View, StyleSheet, ScrollView, Text, InteractionManager } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  collection,
  onSnapshot,
  limit,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  doc,
  startAt,
  endAt,
  documentId,
} from 'firebase/firestore';
import MinimalHeader from '../components/MinimalHeader';
import HeaderSearchOverlay from '../components/HeaderSearchOverlay';
import SearchResultsPage from '../components/SearchResultsPage';
import VisionSheet from '../components/Vision/VisionSheet';
import type { VisionPoolItem, VisionSlot } from '../components/Vision/visionEngine';
import { useNav } from '../navigation/NavContext';
import { buildSelectionFromOutfit, setTryOnSelection } from '../tryon/selection';
import { font, s } from '../theme/tokens';
import { mock, Item } from '../data/mock';
import OutfitGeneratorCard, { type TodaysPickCardData } from '../components/OutfitGeneratorCard';
import SectionRail from '../components/SectionRail';
import ProductModal, { ProductLike } from '../components/ProductModal';
import { useTheme } from '../theme/ThemeContext';
import { db } from '../lib/firebase';
import { listingDocToItem, listingItemToProduct, type ListingItem } from '../lib/firestoreMappers';
import type { SearchPost, SearchUser } from '../components/HeaderSearchOverlay';
import { useListingLikes } from '../lib/listingLikes';
import { useAuth } from '../context/AuthContext';
import { useAppStatus } from '../context/AppStatusContext';
import { warmImageCache } from '../lib/imageCache';
import { loadLocalCloset, type LocalClosetItem } from '../lib/localCloset';
import {
  buildDiscoverRecommendations,
  buildTrendingRecommendations,
  type RecommendationMode,
} from '../lib/recommendations';
import { generateTodaysPick, isCompleteTodaysPickOutfit, makeOutfitSignature } from '../processing/todaysPick/generateTodaysPick';
import {
  loadTodaysPickCache,
  saveTodaysPickCache,
  toStoredTodaysPick,
  type StoredTodaysPick,
  type TodaysPickCacheState,
} from '../processing/todaysPick/todaysPickCache';

type Props = {
  isActive?: boolean;
};

const ROLE_TO_CATEGORY: Record<Item['role'] extends never ? string : NonNullable<Item['role']>, string> = {
  top: 'Top',
  bottom: 'Bottom',
  dress: 'Dress',
  outer: 'Outerwear',
  shoes: 'Shoes',
  accessory: 'Accessory',
};

const SLOT_LABEL: Record<'top' | 'bottom' | 'mono' | 'shoes', string> = {
  top: 'Top',
  bottom: 'Bottom',
  mono: 'Mono',
  shoes: 'Shoes',
};
const SLOT_KEYS: Array<'top' | 'bottom' | 'mono' | 'shoes'> = ['top', 'bottom', 'mono', 'shoes'];
const TODAYS_PICK_MIN_QUEUE = 5;
const TODAYS_PICK_MAX_QUEUE = 16;

const normalizeImageKey = (value?: string | null) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .split('?')[0];

const toTitleCase = (value?: string | null) =>
  String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());

const sexPreferenceToGenderPref = (value?: string | null): 'any' | 'men' | 'women' => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'male') return 'men';
  if (raw === 'female') return 'women';
  return 'any';
};

export default function HomeScreen({ isActive = true }: Props) {
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { user, profile } = useAuth();
  const { reportError } = useAppStatus();
  const seenTodaysPickSignaturesRef = useRef<Set<string>>(new Set());
  const todaysPickCacheRef = useRef<TodaysPickCacheState>({ active: null, queue: [] });
  const todaysPickCacheLoadedRef = useRef(false);
  const todaysPickQueueFillRef = useRef(false);
  const { likedIds, isLiked, setLiked } = useListingLikes(user?.uid);
  const [screenReady, setScreenReady] = useState(false);

  const [activeProduct, setActiveProduct] = useState<ProductLike | null>(null);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [visionVisible, setVisionVisible] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<'users' | 'posts' | 'listings'>('listings');
  const [resultsOpen, setResultsOpen] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([
    'baggy jeans',
    'chelsea kit',
    'leather boots',
    'minimal hoodie',
  ]);

  const [realListings, setRealListings] = useState<ListingItem[]>([]);
  const [myListings, setMyListings] = useState<ListingItem[]>([]);
  const [realUsers, setRealUsers] = useState<SearchUser[]>([]);
  const [realPosts, setRealPosts] = useState<SearchPost[]>([]);
  const [remoteUserResults, setRemoteUserResults] = useState<SearchUser[]>([]);
  const [remotePostResults, setRemotePostResults] = useState<SearchPost[]>([]);
  const [closetStatus, setClosetStatus] = useState<'loading' | 'empty' | 'ready'>('loading');
  const activeAndReady = screenReady;

  const extractPostImage = useCallback((data: any) => {
    const images = Array.isArray(data?.images) ? data.images : [];
    const first = images[0];
    const fromImages = typeof first === 'string' ? first : first?.url;
    return (
      fromImages ||
      data?.image?.url ||
      data?.imageUrl ||
      data?.imageURL ||
      data?.photoURL ||
      data?.coverImage?.url ||
      data?.primeImage?.url ||
      (Array.isArray(data?.photos) ? data.photos[0]?.url || data.photos[0] : null) ||
      data?.thumbnailUrl ||
      data?.thumbnail ||
      null
    );
  }, []);

  const normalizeText = useCallback((value: string) => {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }, []);

  const tokenizeQuery = useCallback(
    (value: string) => normalizeText(value).split(' ').filter(Boolean),
    [normalizeText]
  );

  const normalizeUsernameQuery = useCallback((value: string) => {
    return String(value || '').trim().toLowerCase();
  }, []);

  const scoreText = useCallback(
    (hay: string, tokens: string[]) => {
      if (!tokens.length) return 0;
      const normalized = normalizeText(hay);
      if (!normalized) return 0;
      let score = 0;
      tokens.forEach((t) => {
        if (normalized.includes(t)) score += 1;
      });
      if (!score) return 0;
      if (normalized.startsWith(tokens[0])) score += 0.5;
      return score;
    },
    [normalizeText]
  );

  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => setScreenReady(true));
    return () => task.cancel?.();
  }, []);

  useEffect(() => {
    seenTodaysPickSignaturesRef.current.clear();
    todaysPickCacheRef.current = { active: null, queue: [] };
    todaysPickCacheLoadedRef.current = false;
    todaysPickQueueFillRef.current = false;
  }, [user?.uid]);

  useEffect(() => {
    let cancelled = false;
    const loadClosetState = async () => {
      if (!user?.uid) {
        setClosetStatus('empty');
        return;
      }
      setClosetStatus('loading');
      const closetItems = await loadLocalCloset(user.uid);
      if (cancelled) return;
      setClosetStatus(closetItems.length ? 'ready' : 'empty');
    };
    if (!isActive) return;
    void loadClosetState();
    return () => {
      cancelled = true;
    };
  }, [isActive, user?.uid]);

  useEffect(() => {
    if (!activeAndReady) return;
    const handleSnapshotError = (label: string, fallback: () => void) => (error: any) => {
      const code = error?.code || '';
      if (code === 'permission-denied') {
        fallback();
        return;
      }
      console.warn(`[HomeScreen] ${label} listener error`, error);
      reportError(error, {
        key: `home.${label}.listener`,
        fallbackTitle: 'Sync unavailable',
        fallbackMessage: 'Unable to reach Firebase right now. Showing available data.',
      });
    };

    const listingsRef = collection(db, 'listings');
    const listingsQuery = query(listingsRef, limit(80));
    const unsubListings = onSnapshot(
      listingsQuery,
      (snap) => {
        const items = snap.docs
          .map((doc) => listingDocToItem(doc))
          .filter(Boolean) as ListingItem[];
        setRealListings(items);
      },
      handleSnapshotError('listings', () => setRealListings([]))
    );

    const usersRef = collection(db, 'users');
    const usersQuery = query(usersRef, limit(120));
    const unsubUsers = onSnapshot(
      usersQuery,
      (snap) => {
        const users = snap.docs.map((doc) => {
          const data = doc.data() as any;
          return {
            id: doc.id,
            username: data?.username || 'user',
            displayName: data?.displayName || null,
            avatarUri: data?.photoURL || null,
            bio: data?.bio || null,
          } as SearchUser;
        });
        setRealUsers(users);
      },
      handleSnapshotError('users', () => setRealUsers([]))
    );

    const postsRef = collection(db, 'posts');
    const postsQuery = query(postsRef, orderBy('createdAt', 'desc'), limit(120));
    const unsubPosts = onSnapshot(
      postsQuery,
      (snap) => {
        const posts = snap.docs
          .map((doc) => {
            const data = doc.data() as any;
            const image = extractPostImage(data);
            if (!image) return null;
            return {
              id: doc.id,
              image,
              caption: data?.caption || null,
              authorId: data?.authorUid || data?.authorId || data?.uid || null,
              authorUsername: data?.authorUsername || data?.username || data?.authorName || null,
            } as SearchPost;
          })
          .filter(Boolean) as SearchPost[];
        setRealPosts(posts);
      },
      handleSnapshotError('posts', () => setRealPosts([]))
    );

    return () => {
      unsubListings();
      unsubUsers();
      unsubPosts();
    };
  }, [activeAndReady, extractPostImage, reportError]);

  useEffect(() => {
    if (!activeAndReady) return;
    if (!user) {
      setMyListings([]);
      return;
    }
    const listingsRef = collection(db, 'listings');
    const listingsQuery = query(listingsRef, where('sellerUid', '==', user.uid), limit(120));
    const unsub = onSnapshot(
      listingsQuery,
      (snap) => {
        const items = snap.docs
          .map((doc) => listingDocToItem(doc))
          .filter(Boolean) as ListingItem[];
        setMyListings(items);
      },
      (error) => {
        if (error?.code === 'permission-denied') {
          setMyListings([]);
          return;
        }
        console.warn('[HomeScreen] my listings listener error', error);
        reportError(error, {
          key: 'home.myListings.listener',
          fallbackTitle: 'Listings unavailable',
          fallbackMessage: 'Could not sync your listings. Please try again shortly.',
        });
      }
    );
    return () => unsub();
  }, [activeAndReady, reportError, user?.uid]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (searchScope !== 'users') {
        setRemoteUserResults([]);
        return;
      }
      const q = normalizeUsernameQuery(searchQuery);
      if (!q) {
        setRemoteUserResults([]);
        return;
      }
      if (!isActive) return;

      try {
        const usernamesRef = collection(db, 'usernames');
        const usernameSnap = await getDocs(
          query(usernamesRef, orderBy(documentId()), startAt(q), endAt(`${q}\uf8ff`), limit(25))
        );
        const uids = usernameSnap.docs
          .map((d) => d.data()?.uid)
          .filter(Boolean) as string[];

        const userDocs = await Promise.all(
          uids.map(async (uid) => {
            const snap = await getDoc(doc(db, 'users', uid));
            if (!snap.exists()) return null;
            const data = snap.data() as any;
            return {
              id: uid,
              username: data?.username || snap.id,
              displayName: data?.displayName || null,
              avatarUri: data?.photoURL || null,
              bio: data?.bio || null,
            } as SearchUser;
          })
        );
        const results = userDocs.filter(Boolean) as SearchUser[];
        if (!cancelled) setRemoteUserResults(results);
      } catch (err) {
        console.warn('[HomeScreen] remote user search failed', err);
        reportError(err, {
          key: 'home.search.users',
          fallbackTitle: 'User search unavailable',
          fallbackMessage: 'Could not reach search right now. Try again in a moment.',
        });
        if (!cancelled) setRemoteUserResults([]);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [isActive, normalizeUsernameQuery, reportError, searchQuery, searchScope]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (searchScope !== 'posts') {
        setRemotePostResults([]);
        return;
      }
      const tokens = tokenizeQuery(searchQuery);
      if (!tokens.length) {
        setRemotePostResults([]);
        return;
      }
      if (!isActive) return;
      const q = tokens.join(' ');
      try {
        const postsRef = collection(db, 'posts');
        const snap = await getDocs(
          query(postsRef, orderBy('caption'), startAt(q), endAt(`${q}\uf8ff`), limit(40))
        );
        const results = snap.docs
          .map((docSnap) => {
            const data = docSnap.data() as any;
            const image = extractPostImage(data);
            if (!image) return null;
            return {
              id: docSnap.id,
              image,
              caption: data?.caption || null,
              authorId: data?.authorUid || data?.authorId || data?.uid || null,
              authorUsername: data?.authorUsername || data?.username || data?.authorName || null,
            } as SearchPost;
          })
          .filter(Boolean) as SearchPost[];
        if (!cancelled) setRemotePostResults(results);
      } catch (err) {
        console.warn('[HomeScreen] remote post search failed', err);
        reportError(err, {
          key: 'home.search.posts',
          fallbackTitle: 'Post search unavailable',
          fallbackMessage: 'Could not reach search right now. Try again in a moment.',
        });
        if (!cancelled) setRemotePostResults([]);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [extractPostImage, isActive, reportError, searchQuery, searchScope, tokenizeQuery]);

  const mergeItems = useCallback((primary: Item[], fallback: Item[]) => {
    const seen = new Set<string>();
    const out: Item[] = [];
    primary.forEach((it) => {
      if (seen.has(it.id)) return;
      seen.add(it.id);
      out.push(it);
    });
    fallback.forEach((it) => {
      if (seen.has(it.id)) return;
      seen.add(it.id);
      out.push(it);
    });
    return out;
  }, []);

  const railCap = activeAndReady ? 24 : 8; // items per rail (3 rails)

  const allListingItems = useMemo(() => {
    const live = mergeItems(myListings, realListings);
    return mergeItems(live, mock.allItems || []);
  }, [mergeItems, myListings, realListings]);

  const partitionItems = useCallback((items: Item[]) => {
    const recentlyTried: Item[] = [];
    items.forEach((item, idx) => {
      if (idx % 3 === 0) recentlyTried.push(item);
    });
    return { recentlyTried };
  }, []);

  const railSeed = useMemo(
    () => allListingItems.slice(0, railCap * 3),
    [allListingItems, railCap]
  );
  const rails = useMemo(() => partitionItems(railSeed), [partitionItems, railSeed]);

  const recommendationLimit = activeAndReady ? 180 : 40;
  const trendingRecommendations = useMemo(
    () =>
      buildTrendingRecommendations({
        items: allListingItems,
        likedIds,
        limit: recommendationLimit,
      }),
    [allListingItems, likedIds, recommendationLimit]
  );
  const discoverRecommendations = useMemo(
    () =>
      buildDiscoverRecommendations({
        items: allListingItems,
        likedIds,
        limit: recommendationLimit,
      }),
    [allListingItems, likedIds, recommendationLimit]
  );
  const trendingPreview = useMemo(
    () => trendingRecommendations.slice(0, railCap),
    [trendingRecommendations, railCap]
  );
  const discoverPreview = useMemo(
    () => discoverRecommendations.slice(0, railCap),
    [discoverRecommendations, railCap]
  );
  const homeWarmupUris = useMemo(() => {
    const railImages = [
      ...rails.recentlyTried.slice(0, 24),
      ...trendingPreview.slice(0, 24),
      ...discoverPreview.slice(0, 24),
    ].map((item) => item.image);
    const hero = [
      mock.modelUri,
      mock.topUri,
      mock.bottomUri,
      mock.shoesUri,
      profile?.photoURL || user?.photoURL || '',
    ];
    return [...hero, ...railImages];
  }, [discoverPreview, profile?.photoURL, rails.recentlyTried, trendingPreview, user?.photoURL]);

  const listingByImageKey = useMemo(() => {
    const map = new Map<string, Item>();
    allListingItems.forEach((item) => {
      const key = normalizeImageKey(item.image);
      if (!key || map.has(key)) return;
      map.set(key, item);
    });
    return map;
  }, [allListingItems]);

  const itemToProduct = useCallback((it: Item): ProductLike => {
    const listingItem = it as ListingItem;
    if (listingItem?.source === 'listing') {
      return listingItemToProduct(listingItem);
    }
    return {
      id: it.id,
      title: it.title,
      brand: undefined,
      price: it.price ?? undefined,
      likeCount:
        typeof (it as any)?.likeCount === 'number'
          ? Math.max(0, Math.round((it as any).likeCount))
          : typeof (it as any)?.likes === 'number'
            ? Math.max(0, Math.round((it as any).likes))
            : null,
      images: [it.image],
      colorName: it.colorName ?? undefined,
      colorHex: it.colorHex ?? undefined,
      imagePath: (it as any).imagePath ?? undefined,
      originalPrice: undefined,
      description: undefined,
      category: it.role ? ROLE_TO_CATEGORY[it.role] : undefined,
      size: undefined,
      condition: undefined,
      tags: undefined,
    } as ProductLike;
  }, []);

  const listingResults = useMemo(() => {
    if (searchScope !== 'listings') return [];
    const tokens = tokenizeQuery(searchQuery);
    if (!tokens.length) return [];
    return (allListingItems || [])
      .map((item, idx) => {
        const listingItem = item as ListingItem;
        const hay = [
          item.title,
          item.colorName,
          item.role,
          listingItem.category,
          listingItem.brand,
          listingItem.description,
          ...(listingItem.tags || []),
          ...(listingItem.colors || []),
        ]
          .filter(Boolean)
          .join(' ');
        const score = scoreText(hay, tokens);
        if (!score) return null;
        return { item, score, idx };
      })
      .filter((r): r is { item: Item; score: number; idx: number } => Boolean(r))
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .map((r) => r.item);
  }, [allListingItems, scoreText, searchQuery, searchScope, tokenizeQuery]);

  const userResults = useMemo(() => {
    if (searchScope !== 'users') return [];
    const tokens = tokenizeQuery(searchQuery);
    if (!tokens.length) return [];
    const local = realUsers
      .map((u, idx) => {
        const hay = [u.username, u.displayName, u.bio].filter(Boolean).join(' ');
        const score = scoreText(hay, tokens);
        if (!score) return null;
        return { u, score, idx };
      })
      .filter((r): r is { u: SearchUser; score: number; idx: number } => Boolean(r))
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .map((r) => r.u);
    const merged = new Map<string, SearchUser>();
    remoteUserResults.forEach((u) => merged.set(u.id, u));
    local.forEach((u) => {
      if (!merged.has(u.id)) merged.set(u.id, u);
    });
    return Array.from(merged.values());
  }, [realUsers, remoteUserResults, scoreText, searchQuery, searchScope, tokenizeQuery]);

  const postResults = useMemo(() => {
    if (searchScope !== 'posts') return [];
    const tokens = tokenizeQuery(searchQuery);
    if (!tokens.length) return [];
    const local = realPosts
      .map((p, idx) => {
        const hay = [p.caption, p.authorUsername].filter(Boolean).join(' ');
        const score = scoreText(hay, tokens);
        if (!score) return null;
        return { p, score, idx };
      })
      .filter((r): r is { p: SearchPost; score: number; idx: number } => Boolean(r))
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .map((r) => r.p);
    const merged = new Map<string, SearchPost>();
    remotePostResults.forEach((p) => merged.set(p.id, p));
    local.forEach((p) => {
      if (!merged.has(p.id)) merged.set(p.id, p);
    });
    return Array.from(merged.values());
  }, [realPosts, remotePostResults, scoreText, searchQuery, searchScope, tokenizeQuery]);

  const rememberTodaysPickSignature = useCallback((signature?: string | null) => {
    const normalized = String(signature || '').trim();
    if (!normalized) return;
    seenTodaysPickSignaturesRef.current.add(normalized);
    if (seenTodaysPickSignaturesRef.current.size > 180) {
      const keep = Array.from(seenTodaysPickSignaturesRef.current).slice(-120);
      seenTodaysPickSignaturesRef.current = new Set(keep);
    }
  }, []);

  const ensureTodaysPickCacheLoaded = useCallback(async () => {
    if (!user?.uid) {
      todaysPickCacheRef.current = { active: null, queue: [] };
      todaysPickCacheLoadedRef.current = true;
      return todaysPickCacheRef.current;
    }
    if (todaysPickCacheLoadedRef.current) return todaysPickCacheRef.current;
    const stored = await loadTodaysPickCache(user.uid);
    const state: TodaysPickCacheState = {
      active: stored.active,
      queue: [...stored.queue].slice(0, TODAYS_PICK_MAX_QUEUE),
    };

    // Keep one preloaded active pick and rotate to a unique one on fresh app launches.
    if (state.active && state.queue.length) {
      const nextIdx = state.queue.findIndex((item) => item.signature !== state.active?.signature);
      if (nextIdx >= 0) {
        const [nextActive] = state.queue.splice(nextIdx, 1);
        state.queue.push(state.active);
        state.active = nextActive;
      }
    }
    if (!state.active && state.queue.length) {
      state.active = state.queue.shift() || null;
    }

    todaysPickCacheRef.current = state;
    todaysPickCacheLoadedRef.current = true;
    if (state.active?.signature) rememberTodaysPickSignature(state.active.signature);
    state.queue.forEach((entry) => {
      if (entry?.signature) rememberTodaysPickSignature(entry.signature);
    });
    await saveTodaysPickCache(user.uid, state);
    return state;
  }, [rememberTodaysPickSignature, user?.uid]);

  const persistTodaysPickCache = useCallback(
    async (state: TodaysPickCacheState) => {
      if (!user?.uid) return;
      await saveTodaysPickCache(user.uid, state);
    },
    [user?.uid]
  );

  const generateStoredTodaysPick = useCallback(
    async (closetItems: LocalClosetItem[], blockedSignatures: Set<string>) => {
      const result = await generateTodaysPick({
        closetItems,
        listingPool: allListingItems,
        genderPref: sexPreferenceToGenderPref((profile as any)?.sexPreference),
        seenSignatures: blockedSignatures,
      });
      if (!isCompleteTodaysPickOutfit(result.outfit)) return null;
      const stored = toStoredTodaysPick(result);
      if (!stored || blockedSignatures.has(stored.signature)) return null;
      blockedSignatures.add(stored.signature);
      rememberTodaysPickSignature(stored.signature);
      return stored;
    },
    [allListingItems, profile, rememberTodaysPickSignature]
  );

  const buildClosetProduct = useCallback((item: LocalClosetItem, slot: 'top' | 'bottom' | 'mono' | 'shoes'): ProductLike => {
    const title = toTitleCase(item.tags[0]) || `${SLOT_LABEL[slot]} closet item`;
    return {
      title,
      description: 'From your on-device closet',
      images: [item.uri],
      image: item.uri,
      category: toTitleCase(item.category) || SLOT_LABEL[slot],
      brand: item.brand || undefined,
      colorName: toTitleCase(item.color) || undefined,
      tags: item.tags,
    };
  }, []);

  const buildTodaysPickCardData = useCallback(
    async (entry: StoredTodaysPick): Promise<TodaysPickCardData> => {
      const closetItems = user?.uid ? await loadLocalCloset(user.uid) : [];
      const closetById = new Map<string, LocalClosetItem>();
      closetItems.forEach((item) => closetById.set(item.id, item));
      const slotProducts: Partial<Record<'top' | 'bottom' | 'mono' | 'shoes', ProductLike | null>> = {};

      SLOT_KEYS.forEach((slot) => {
        const uri = entry.outfit[slot];
        if (!uri) return;
        let product: ProductLike | null = null;
        const isAnchor = entry.anchor?.category === slot;
        const anchorItem = isAnchor && entry.anchor?.id ? closetById.get(entry.anchor.id) || null : null;
        if (anchorItem) {
          product = buildClosetProduct(anchorItem, slot);
        }
        if (!product) {
          const matched = listingByImageKey.get(normalizeImageKey(uri));
          if (matched) product = itemToProduct(matched);
        }
        if (!product) {
          product = {
            title: `${SLOT_LABEL[slot]} pick`,
            images: [uri],
            image: uri,
            category: SLOT_LABEL[slot],
          };
        }
        slotProducts[slot] = product;
      });

      const anchorItem = entry.anchor?.id ? closetById.get(entry.anchor.id) || null : null;
      const anchorDetailRaw = anchorItem
        ? (anchorItem.tags[0] || anchorItem.brand || anchorItem.color || null)
        : null;
      const anchorDetail = anchorDetailRaw ? toTitleCase(anchorDetailRaw) : null;

      return {
        outfit: entry.outfit,
        anchor: entry.anchor
          ? {
              id: entry.anchor.id,
              category: entry.anchor.category,
              uri: entry.anchor.uri,
              detail: anchorDetail,
            }
          : null,
        slotProducts,
      };
    },
    [buildClosetProduct, itemToProduct, listingByImageKey, user?.uid]
  );

  const ensureTodaysPickQueue = useCallback(
    async (minimumQueue = TODAYS_PICK_MIN_QUEUE) => {
      if (!user?.uid || todaysPickQueueFillRef.current) return;
      todaysPickQueueFillRef.current = true;
      try {
        await ensureTodaysPickCacheLoaded();
        const closetItems = await loadLocalCloset(user.uid);
        if (!closetItems.length) return;
        const state = todaysPickCacheRef.current;
        const blocked = new Set<string>([
          ...seenTodaysPickSignaturesRef.current,
          ...(state.active?.signature ? [state.active.signature] : []),
          ...state.queue.map((pick) => pick.signature),
        ]);
        if (!state.active) {
          state.active = state.queue.shift() || null;
        }
        if (!state.active) {
          const preload = await generateStoredTodaysPick(closetItems, blocked);
          if (preload) state.active = preload;
        }
        if (state.active?.signature) {
          blocked.add(state.active.signature);
          rememberTodaysPickSignature(state.active.signature);
        }
        let attempts = 0;
        while (state.queue.length < minimumQueue && attempts < minimumQueue * 6) {
          attempts += 1;
          const next = await generateStoredTodaysPick(closetItems, blocked);
          if (!next) continue;
          state.queue.push(next);
        }
        if (state.queue.length > TODAYS_PICK_MAX_QUEUE) {
          state.queue = state.queue.slice(0, TODAYS_PICK_MAX_QUEUE);
        }
        todaysPickCacheRef.current = state;
        await persistTodaysPickCache(state);
      } finally {
        todaysPickQueueFillRef.current = false;
      }
    },
    [ensureTodaysPickCacheLoaded, generateStoredTodaysPick, persistTodaysPickCache, rememberTodaysPickSignature, user?.uid]
  );

  const generateTodaysPickFromCloset = useCallback(
    async (options?: { refresh?: boolean }) => {
      if (!user?.uid) return null;
      const refresh = Boolean(options?.refresh);
      await ensureTodaysPickCacheLoaded();
      const closetItems = await loadLocalCloset(user.uid);
      if (!closetItems.length) return null;

      const state = todaysPickCacheRef.current;
      if (state.active && !isCompleteTodaysPickOutfit(state.active.outfit)) {
        state.active = null;
      }
      const blocked = new Set<string>([
        ...seenTodaysPickSignaturesRef.current,
        ...(state.active?.signature ? [state.active.signature] : []),
        ...state.queue.map((pick) => pick.signature),
      ]);

      if (!state.active) {
        state.active = state.queue.shift() || null;
        if (!state.active) {
          state.active = await generateStoredTodaysPick(closetItems, blocked);
        }
      }

      if (refresh) {
        let next = state.queue.shift() || null;
        if (!next) {
          next = await generateStoredTodaysPick(closetItems, blocked);
        }
        if (next) {
          state.active = next;
        }
      }

      if (state.queue.length > TODAYS_PICK_MAX_QUEUE) {
        state.queue = state.queue.slice(0, TODAYS_PICK_MAX_QUEUE);
      }
      todaysPickCacheRef.current = state;
      await persistTodaysPickCache(state);
      void ensureTodaysPickQueue(TODAYS_PICK_MIN_QUEUE);

      if (!state.active) return null;
      const signature = makeOutfitSignature(state.active.outfit);
      if (signature) rememberTodaysPickSignature(signature);
      return buildTodaysPickCardData(state.active);
    },
    [
      buildTodaysPickCardData,
      ensureTodaysPickCacheLoaded,
      ensureTodaysPickQueue,
      generateStoredTodaysPick,
      persistTodaysPickCache,
      rememberTodaysPickSignature,
      user?.uid,
    ]
  );

  const onPressItem = useCallback((it: Item) => {
    const product = itemToProduct(it);
    setActiveProduct(product);
    setActiveProductId(product.id || null);
    setModalOpen(true);
  }, [itemToProduct]);

  const openListingModal = useCallback((item: Item) => {
    setTimeout(() => onPressItem(item), 180);
  }, [onPressItem]);

  const addRecent = useCallback((value: string) => {
    const next = value.trim();
    if (!next) return;
    setRecentSearches((prev) => [next, ...prev.filter((v) => v.toLowerCase() !== next.toLowerCase())].slice(0, 8));
  }, []);

  const openResults = useCallback(
    (item?: Item | SearchUser | SearchPost) => {
      addRecent(searchQuery);
      setSearchOpen(false);
      setResultsOpen(true);
      if (item && searchScope === 'listings') {
        setTimeout(() => openListingModal(item as Item), 260);
      }
    },
    [addRecent, openListingModal, searchQuery, searchScope]
  );

  const closeResults = useCallback(() => {
    setResultsOpen(false);
    setTimeout(() => setSearchOpen(true), 220);
  }, []);

  const closeSearchOverlay = useCallback(() => {
    setSearchOpen(false);
    setTimeout(() => setSearchQuery(''), 240);
  }, []);

  const onTry = useCallback((p: ProductLike) => {
    setModalOpen(false);
  }, []);

  const onSelectTodaysPickProduct = useCallback((product: ProductLike) => {
    setActiveProduct(product);
    setActiveProductId(product.id || null);
    setModalOpen(true);
  }, []);

  const openClosetAddFromTodaysPick = useCallback(() => {
    nav.openProfileClosetAdd?.();
  }, [nav]);

  const onSelectVisionAppItem = useCallback((item: VisionPoolItem, _slot: VisionSlot) => {
    const product = itemToProduct(item as Item);
    setActiveProduct(product);
    setActiveProductId(product.id || null);
    setModalOpen(true);
    setVisionVisible(false);
  }, [itemToProduct]);

  const openRecommendationFeed = useCallback((mode: RecommendationMode) => {
    nav.navigate({
      name: 'recommendation',
      mode,
      trendingItems: trendingRecommendations,
      discoverItems: discoverRecommendations,
    } as any);
  }, [discoverRecommendations, nav, trendingRecommendations]);

  const handleSelectUser = useCallback(
    (user: SearchUser) => {
      nav.navigate({
        name: 'user',
        user: {
          id: user.id,
          username: user.username,
          avatarUri: user.avatarUri || '',
          bio: user.bio || undefined,
          source: 'real',
        },
      } as any);
      setSearchOpen(false);
      setResultsOpen(false);
    },
    [nav]
  );

  const handleSelectPost = useCallback(
    (post: SearchPost) => {
      const user = realUsers.find((u) => u.id === post.authorId);
      if (user) {
        handleSelectUser(user);
      }
    },
    [handleSelectUser, realUsers]
  );

  const onTryOutfit = useCallback((garments: { top?: string | null; bottom?: string | null; mono?: string | null; shoes?: string | null }) => {
    const selection = buildSelectionFromOutfit(garments);
    if (!selection) return;
    setTryOnSelection(selection);
    nav.goToTryOn?.();
  }, [nav]);

  useEffect(() => {
    if (!activeAndReady || !user?.uid) return;
    void ensureTodaysPickQueue(TODAYS_PICK_MIN_QUEUE);
  }, [activeAndReady, ensureTodaysPickQueue, user?.uid]);

  useEffect(() => {
    if (!screenReady) return;
    void warmImageCache(homeWarmupUris, {
      cachePolicy: 'memory-disk',
      chunkSize: 18,
    });
  }, [homeWarmupUris, screenReady]);

  const bottomClear = insets.bottom + 64 + s(6); // reserve space for floating dock (64) + a little breathing room
  const visionGenderPref = useMemo(
    () => sexPreferenceToGenderPref((profile as any)?.sexPreference),
    [(profile as any)?.sexPreference]
  );

  useEffect(() => {
    seenTodaysPickSignaturesRef.current.clear();
    todaysPickCacheRef.current = { active: null, queue: [] };
    todaysPickCacheLoadedRef.current = false;
    todaysPickQueueFillRef.current = false;
  }, [visionGenderPref]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, backgroundColor: colors.bg },
      }),
    [colors]
  );

  return (
    <View style={styles.screen}>
      <MinimalHeader
        onSearch={() => setSearchOpen((prev) => !prev)}
        rightSecondaryIcon="scan-outline"
        rightSecondaryLabel="Vision"
        rightSecondaryA11yLabel="Open vision finder"
        onSecondaryPress={() => setVisionVisible(true)}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: s(3), paddingBottom: bottomClear }}
      >
        {/* Minimal generator (model inside) */}
        <View style={{ marginTop: s(3) }}>
          <OutfitGeneratorCard
            profileUri={profile?.photoURL || user?.photoURL || null}
            modelUri={mock.modelUri}
            topUri={mock.topUri}
            bottomUri={mock.bottomUri}
            onTryOutfit={onTryOutfit}
            onGenerateFromCloset={generateTodaysPickFromCloset}
            onSelectProduct={onSelectTodaysPickProduct}
            autoGenerateOnMount
            closetStatus={closetStatus}
            emptyStateMessage="Add an item to your closet to get a custom tailored outfit."
            onEmptyStatePress={openClosetAddFromTodaysPick}
          />
        </View>

        {/* Rails */}
        <Text style={[font.h1, { marginTop: s(4), color: colors.text }]}>For you</Text>
        <SectionRail
          title="Recently tried-on"
          items={rails.recentlyTried}
          loading={!screenReady}
          onPressItem={onPressItem}
        />
        <SectionRail
          title="Trending"
          items={trendingPreview}
          loading={!screenReady}
          onPressItem={onPressItem}
          onShowMore={() => openRecommendationFeed('trending')}
        />
        <SectionRail
          title="Discover"
          items={discoverPreview}
          loading={!screenReady}
          onPressItem={onPressItem}
          onShowMore={() => openRecommendationFeed('discover')}
        />
      </ScrollView>

      <HeaderSearchOverlay
        visible={searchOpen}
        value={searchQuery}
        onChangeText={setSearchQuery}
        scope={searchScope}
        onScopeChange={setSearchScope}
        onClose={closeSearchOverlay}
        recent={recentSearches}
        listingResults={listingResults}
        userResults={userResults}
        postResults={postResults}
        onOpenResults={openResults}
        onSelectUser={handleSelectUser}
        onSelectPost={handleSelectPost}
      />

      <SearchResultsPage
        visible={resultsOpen}
        query={searchQuery}
        onChangeQuery={setSearchQuery}
        scope={searchScope}
        listingResults={listingResults}
        userResults={userResults}
        postResults={postResults}
        onBack={closeResults}
        onSelectItem={openListingModal}
        onSelectUser={handleSelectUser}
        onSelectPost={handleSelectPost}
      />

      <ProductModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        product={activeProduct}
        onTry={onTry}
        initialLiked={isLiked(activeProductId, activeProduct?.listingId)}
        onLikeChange={(liked, product) => {
          if (product?.id) setLiked(product.id, liked, product.listingId);
        }}
      />

      <VisionSheet
        visible={visionVisible}
        onClose={() => setVisionVisible(false)}
        pool={allListingItems}
        genderPref={visionGenderPref}
        onApplyItem={onSelectVisionAppItem}
      />
    </View>
  );
}
