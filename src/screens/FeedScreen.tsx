// src/screens/FeedScreen.tsx
import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, InteractionManager, Alert, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  doc,
  runTransaction,
  serverTimestamp,
  getDocs,
  getDoc,
  startAt,
  endAt,
  documentId,
} from 'firebase/firestore';

import MinimalHeader from '../components/MinimalHeader';
import SegmentedTabs from '../components/ui/SegmentedTabs';
import ProductModal, { ProductLike } from '../components/ProductModal';
import HeaderSearchOverlay from '../components/HeaderSearchOverlay';
import SearchResultsPage from '../components/SearchResultsPage';
import PostCommentsScreen from '../components/feed/PostCommentsScreen';
import FeedPostCard from '../components/feed/FeedPostCard';
import PostOptionsSheet from '../components/feed/PostOptionsSheet';

import { s, hairline, font } from '../theme/tokens';
import { type Item } from '../data/mock';
import { useTheme } from '../theme/ThemeContext';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useAppStatus } from '../context/AppStatusContext';
import { warmImageCache } from '../lib/imageCache';
import { listingDocToItem, listingItemToProduct, type ListingItem } from '../lib/firestoreMappers';
import type { SearchPost, SearchUser } from '../components/HeaderSearchOverlay';
import { useListingLikes } from '../lib/listingLikes';
import { setPostLike, subscribePostLikes } from '../lib/postLikes';
import { syncNotificationEvent } from '../lib/notifications';
import { blockUser, reportPost, reportUser, unblockUser } from '../lib/postModeration';
import {
  createEmptyFeedRankCache,
  loadFeedRankCache,
  registerFeedImpressions,
  registerFeedLike,
  rankFollowingFeed,
  rankForYouFeed,
  saveFeedRankCache,
  type FeedRankCache,
} from '../lib/feedRanking';

const DEBUG_FEED = false;
const ROLE_TO_CATEGORY: Record<string, string> = {
  top: 'Top',
  bottom: 'Bottom',
  dress: 'Dress',
  outer: 'Outerwear',
  shoes: 'Shoes',
  accessory: 'Accessory',
};

/* ----------------------------- users ----------------------------- */
export type FeedUser = {
  id: string;
  username: string;
  displayName?: string;
  avatarUri: string;
  bio?: string;
  followers?: number;
  following?: number;
  source?: 'real';
};

/* ----------------------------- types ----------------------------- */
type FeedPost = {
  id: string;
  authorUid: string;
  user: FeedUser;
  modelUri: string;
  likes: number;
  commentCount: number;
  caption?: string | null;
  createdAtMs?: number | null;
  garments: ProductLike[]; // items tried-on in this look (1..n)
  source: 'real';
};

type FeedTab = 'for_you' | 'following';

const FEED_TABS: Array<{ key: FeedTab; label: string }> = [
  { key: 'for_you', label: 'For You' },
  { key: 'following', label: 'Following' },
];

const FIREBASE_STORAGE_BUCKET = (db as any)?.app?.options?.storageBucket || '';

function toStorageMediaUrl(value: any): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) {
    return raw;
  }
  if (raw.startsWith('gs://')) {
    const without = raw.replace('gs://', '');
    const [bucket, ...pathParts] = without.split('/');
    if (!bucket || !pathParts.length) return null;
    return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(pathParts.join('/'))}?alt=media`;
  }
  if (!FIREBASE_STORAGE_BUCKET) return null;
  if (!raw.includes('/')) return null;
  return `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_STORAGE_BUCKET}/o/${encodeURIComponent(raw)}?alt=media`;
}

/* ----------------------------- helpers --------------------------- */
function toProductLike(it: any): ProductLike {
  return {
    id: String(it.id ?? Math.random().toString(36).slice(2)),
    title: it.title ?? 'Item',
    brand: it.brand ?? null,
    price: it.price ?? null,
    originalPrice: it.originalPrice ?? null,
    images: it.images ?? (it.image ? [it.image] : []),
    image: it.image ?? null,
    imagePath: it.imagePath ?? null,
    colorName: it.colorName ?? null,
    colorHex: it.colorHex ?? null,
    description: it.description ?? null,
    category: it.category ?? (it.role ? ROLE_TO_CATEGORY[String(it.role)] : null),
    size: it.size ?? null,
    condition: it.condition ?? null,
    likeCount:
      typeof it?.likeCount === 'number'
        ? Math.max(0, Math.round(it.likeCount))
        : typeof it?.likes === 'number'
          ? Math.max(0, Math.round(it.likes))
          : null,
    tags: Array.isArray(it.tags) ? it.tags : null,
  };
}

/* --------------------------- components -------------------------- */
/* ----------------------------- screen ---------------------------- */
type Props = {
  onOpenUser?: (u: FeedUser) => void;
  isActive?: boolean;
};

export default function FeedScreen({ onOpenUser, isActive = true }: Props) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { user, profile } = useAuth();
  const { reportError } = useAppStatus();
  const { isLiked: isListingLiked, setLiked: setListingLiked } = useListingLikes(user?.uid);
  const [screenReady, setScreenReady] = useState(false);
  const [activeTab, setActiveTab] = useState<FeedTab>('for_you');
  const [followingIds, setFollowingIds] = useState<Set<string>>(new Set());
  const [likedPostIds, setLikedPostIds] = useState<Set<string>>(new Set());
  const [activeProduct, setActiveProduct] = useState<ProductLike | null>(null);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [activeCommentsPost, setActiveCommentsPost] = useState<FeedPost | null>(null);
  const [activeOptionsPost, setActiveOptionsPost] = useState<FeedPost | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<'users' | 'posts' | 'listings'>('posts');
  const [resultsOpen, setResultsOpen] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([
    'double denim',
    'layered hoodie',
    'shoe drops',
    'vintage tee',
  ]);
  const activeAndReady = screenReady;

  const [realListings, setRealListings] = useState<ListingItem[]>([]);
  const [realUsers, setRealUsers] = useState<Record<string, FeedUser>>({});
  const [realPosts, setRealPosts] = useState<FeedPost[]>([]);
  const [liveLikeCounts, setLiveLikeCounts] = useState<Record<string, number>>({});
  const [liveCommentCounts, setLiveCommentCounts] = useState<Record<string, number>>({});
  const [realSearchUsers, setRealSearchUsers] = useState<SearchUser[]>([]);
  const [realSearchPosts, setRealSearchPosts] = useState<SearchPost[]>([]);
  const [postsHydrated, setPostsHydrated] = useState(false);
  const [remoteUserResults, setRemoteUserResults] = useState<SearchUser[]>([]);
  const [remotePostResults, setRemotePostResults] = useState<SearchPost[]>([]);
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  const [moderationBusy, setModerationBusy] = useState(false);
  const [feedCache, setFeedCache] = useState<FeedRankCache>(createEmptyFeedRankCache());
  const [feedCacheReady, setFeedCacheReady] = useState(false);
  const realUsersRef = useRef<Record<string, FeedUser>>({});
  const lastPostLogAtRef = useRef(0);
  const lastRankLogAtRef = useRef(0);
  const lastFeedLogRef = useRef<{ total: number; following: number; tab: FeedTab } | null>(null);

  const listingById = useMemo(() => {
    const map: Record<string, ListingItem> = {};
    realListings.forEach((item) => {
      if (item.listingId) map[item.listingId] = item;
      if (item.id) map[item.id] = item;
    });
    return map;
  }, [realListings]);

  const toMillis = useCallback((value: any) => {
    if (!value) return null;
    if (typeof value?.toMillis === 'function') return value.toMillis();
    if (typeof value === 'number') return value;
    if (typeof value?.seconds === 'number') return value.seconds * 1000;
    if (typeof value?._seconds === 'number') return value._seconds * 1000;
    return null;
  }, []);

  const extractPostImage = useCallback((data: any) => {
    const images = Array.isArray(data?.images) ? data.images : [];
    const first = images[0];
    const fromImages =
      toStorageMediaUrl(typeof first === 'string' ? first : null) ||
      toStorageMediaUrl(first?.url) ||
      toStorageMediaUrl(first?.path) ||
      null;
    return (
      fromImages ||
      toStorageMediaUrl(typeof data?.image === 'string' ? data.image : null) ||
      toStorageMediaUrl(data?.image?.url) ||
      toStorageMediaUrl(data?.image?.path) ||
      toStorageMediaUrl(data?.imageUrl) ||
      toStorageMediaUrl(data?.imageURL) ||
      toStorageMediaUrl(data?.photoURL) ||
      toStorageMediaUrl(data?.coverImage?.url) ||
      toStorageMediaUrl(data?.coverImage?.path) ||
      toStorageMediaUrl(data?.primeImage?.url) ||
      toStorageMediaUrl(data?.primeImage?.path) ||
      toStorageMediaUrl(Array.isArray(data?.photos) ? data.photos[0]?.url || data.photos[0] : null) ||
      toStorageMediaUrl(data?.thumbnailUrl) ||
      toStorageMediaUrl(data?.thumbnail) ||
      null
    );
  }, []);

  const extractPostGarments = useCallback((postId: string, data: any) => {
    const rawList = Array.isArray(data?.garments)
      ? data.garments
      : Array.isArray(data?.triedItems)
        ? data.triedItems
        : Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data?.products)
            ? data.products
            : Array.isArray(data?.outfitItems)
              ? data.outfitItems
              : Array.isArray(data?.selectedItems)
                ? data.selectedItems
                : [];

    const mapped = rawList
      .map((raw: any, index: number) => {
        const rawObj = typeof raw === 'object' && raw ? raw : {};
        const listingId = String(rawObj?.listingId || rawObj?.itemId || '').trim();
        const itemId = String(rawObj?.itemId || rawObj?.id || '').trim();
        const lookupKey = listingId || itemId;
        const listing = lookupKey ? listingById[lookupKey] : null;

        const image =
          toStorageMediaUrl(typeof raw === 'string' ? raw : null) ||
          toStorageMediaUrl(rawObj?.image) ||
          toStorageMediaUrl(rawObj?.imageUrl) ||
          toStorageMediaUrl(rawObj?.imageURL) ||
          toStorageMediaUrl(rawObj?.photoURL) ||
          toStorageMediaUrl(rawObj?.thumbnail) ||
          toStorageMediaUrl(rawObj?.imagePath) ||
          toStorageMediaUrl(listing?.image) ||
          toStorageMediaUrl(listing?.images?.[0]) ||
          null;

        const id = itemId || listingId || `${postId}:garment:${index}`;
        const title = rawObj?.title || rawObj?.name || rawObj?.role || listing?.title || 'Tried item';
        if (!image && !title) return null;
        return {
          id: String(id),
          title,
          brand: rawObj?.brand || listing?.brand || null,
          price: rawObj?.price || listing?.price || null,
          likeCount:
            typeof rawObj?.likeCount === 'number'
              ? Math.max(0, Math.round(rawObj.likeCount))
              : typeof listing?.likeCount === 'number'
                ? Math.max(0, Math.round(listing.likeCount))
                : typeof rawObj?.likes === 'number'
                  ? Math.max(0, Math.round(rawObj.likes))
                  : null,
          images: image ? [image] : [],
          image: image || null,
          imagePath: rawObj?.imagePath || null,
          category: rawObj?.category || rawObj?.role || listing?.category || listing?.role || null,
          size: rawObj?.size || listing?.size || null,
          condition: rawObj?.condition || listing?.condition || null,
          tags: Array.isArray(rawObj?.tags)
            ? rawObj.tags
            : Array.isArray(listing?.tags)
              ? listing.tags
              : null,
        } as ProductLike;
      })
      .filter(Boolean) as ProductLike[];

    if (mapped.length) return mapped.slice(0, 4);

    const fallbackListing = (() => {
      const fallbackListingId = String(data?.listingId || data?.itemId || '').trim();
      if (!fallbackListingId) return null;
      return listingById[fallbackListingId] || null;
    })();
    const fallbackImage =
      toStorageMediaUrl(data?.garmentImage) ||
      toStorageMediaUrl(data?.itemImage) ||
      toStorageMediaUrl(data?.primeImage?.url) ||
      toStorageMediaUrl(fallbackListing?.image) ||
      toStorageMediaUrl(fallbackListing?.images?.[0]) ||
      null;
    const fallbackTitle =
      data?.garmentTitle ||
      data?.itemTitle ||
      data?.listingTitle ||
      fallbackListing?.title ||
      null;
    if (!fallbackImage && !fallbackTitle) return [];
    return [
      {
        id: `${postId}:garment:fallback`,
        title: fallbackTitle || 'Tried item',
        brand: null,
        price: null,
        images: fallbackImage ? [fallbackImage] : [],
        image: fallbackImage,
        category: data?.garmentCategory || fallbackListing?.category || null,
      } as ProductLike,
    ];
  }, [listingById]);

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
    let cancelled = false;
    const load = async () => {
      setFeedCacheReady(false);
      const cache = await loadFeedRankCache(user?.uid || null);
      if (!cancelled) {
        setFeedCache(cache);
        setFeedCacheReady(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  useEffect(() => {
    if (!feedCacheReady) return;
    const t = setTimeout(() => {
      void saveFeedRankCache(user?.uid || null, feedCache);
    }, 250);
    return () => clearTimeout(t);
  }, [feedCache, feedCacheReady, user?.uid]);

  useEffect(() => {
    if (!activeAndReady) return;
    const handleSnapshotError = (label: string, fallback: () => void) => (error: any) => {
      const code = error?.code || '';
      if (code === 'permission-denied') {
        fallback();
        return;
      }
      console.warn(`[FeedScreen] ${label} listener error`, error);
      reportError(error, {
        key: `feed.${label}.listener`,
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
        const map: Record<string, FeedUser> = {};
        const searchUsers: SearchUser[] = [];
        snap.docs.forEach((doc) => {
          const data = doc.data() as any;
          const userItem: FeedUser = {
            id: doc.id,
            username: data?.username || 'user',
            avatarUri: toStorageMediaUrl(data?.photoURL) || toStorageMediaUrl(data?.avatarUrl) || '',
            bio: data?.bio || undefined,
            followers: data?.followersCount ?? 0,
            following: data?.followingCount ?? 0,
            source: 'real',
          };
          map[doc.id] = userItem;
          searchUsers.push({
            id: doc.id,
            username: userItem.username,
            displayName: data?.displayName || null,
            avatarUri: userItem.avatarUri || null,
            bio: userItem.bio || null,
          });
        });
        realUsersRef.current = map;
        setRealUsers(map);
        setRealSearchUsers(searchUsers);
      },
      handleSnapshotError('users', () => {
        realUsersRef.current = {};
        setRealUsers({});
        setRealSearchUsers([]);
      })
    );

    return () => {
      unsubListings();
      unsubUsers();
    };
  }, [activeAndReady, reportError]);

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
              avatarUri: toStorageMediaUrl(data?.photoURL) || toStorageMediaUrl(data?.avatarUrl) || null,
              bio: data?.bio || null,
            } as SearchUser;
          })
        );
        const results = userDocs.filter(Boolean) as SearchUser[];
        if (!cancelled) setRemoteUserResults(results);
      } catch (err) {
        console.warn('[FeedScreen] remote user search failed', err);
        reportError(err, {
          key: 'feed.search.users',
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
            const state = data?.state ?? 'ok';
            if (state !== 'ok') return null;
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
        console.warn('[FeedScreen] remote post search failed', err);
        reportError(err, {
          key: 'feed.search.posts',
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

  useEffect(() => {
    if (!activeAndReady) return;
    const postsRef = collection(db, 'posts');
    const postsQuery = query(postsRef, orderBy('createdAt', 'desc'), limit(80));
    const postsFallbackQuery = query(postsRef, limit(80));

    const logPosts = (label: string, meta: any) => {
      if (!DEBUG_FEED) return;
      const now = Date.now();
      if (now - lastPostLogAtRef.current < 8000) return;
      lastPostLogAtRef.current = now;
      console.log('[FeedScreen][posts]', { label, ...meta });
    };

    const applySnapshot = (snap: any, label: string) => {
      const usersMap = realUsersRef.current;
      let missingImage = 0;
      const sample: Array<{ id: string; authorUid: string; hasImage: boolean; createdAt: any }> = [];

      const posts = snap.docs
        .map((doc: any) => {
          const data = doc.data() as any;
          const state = data?.state ?? 'ok';
          if (state !== 'ok') return null;
          const uri = extractPostImage(data);
          if (!uri) {
            missingImage += 1;
            if (sample.length < 3) {
              sample.push({
                id: doc.id,
                authorUid: data?.authorUid || data?.authorId || data?.uid || '',
                hasImage: false,
                createdAt: data?.createdAt || null,
              });
            }
            return null;
          }
          const authorUid = data?.authorUid || data?.authorId || data?.uid || '';
          const author = usersMap[authorUid] || {
            id: authorUid,
            username: data?.authorUsername || data?.username || 'user',
            avatarUri:
              toStorageMediaUrl(data?.authorPhotoURL) ||
              toStorageMediaUrl(data?.photoURL) ||
              toStorageMediaUrl(data?.authorAvatar) ||
              '',
            bio: undefined,
            followers: 0,
            following: 0,
            source: 'real',
          };
          if (sample.length < 3) {
            sample.push({
              id: doc.id,
              authorUid,
              hasImage: true,
              createdAt: data?.createdAt || null,
            });
          }
          return {
            id: doc.id,
            authorUid,
            user: author,
            modelUri: uri,
            likes: Number(data?.likeCount ?? 0) || 0,
            commentCount: Number(data?.commentCount ?? 0) || 0,
            caption: data?.caption || null,
            createdAtMs: toMillis(data?.createdAt),
            garments: extractPostGarments(doc.id, data),
            source: 'real',
          } as FeedPost;
        })
        .filter(Boolean) as FeedPost[];

      setRealPosts(posts);
      setActiveCommentsPost((prev) => {
        if (!prev) return prev;
        const latest = posts.find((p) => p.id === prev.id);
        if (!latest) return prev;
        return {
          ...prev,
          likes: latest.likes,
          commentCount: latest.commentCount,
          caption: latest.caption,
          garments: latest.garments,
          modelUri: latest.modelUri,
          user: latest.user,
        };
      });
      logPosts(label, {
        totalDocs: snap.size,
        withImage: posts.length,
        missingImage,
        sample,
      });

      const searchPosts = snap.docs
        .map((doc: any) => {
          const data = doc.data() as any;
          const state = data?.state ?? 'ok';
          if (state !== 'ok') return null;
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
      setRealSearchPosts(searchPosts);
      setPostsHydrated(true);
    };

    if (DEBUG_FEED) {
      console.log('[FeedScreen][posts] subscribe-start', {
        screenReady,
        viewerUid: user?.uid || null,
      });
    }

    let fallbackUnsub: (() => void) | null = null;
    const attachFallback = () => {
      if (fallbackUnsub) return;
      fallbackUnsub = onSnapshot(
        postsFallbackQuery,
        (snap) => applySnapshot(snap, 'snapshot-fallback'),
        (error: any) => {
          const code = error?.code || '';
          const message = error?.message || String(error);
          console.warn('[FeedScreen][posts] fallback subscribe failed', { code, message });
          reportError(error, {
            key: 'feed.posts.fallback',
            fallbackTitle: 'Feed unavailable',
            fallbackMessage: 'Could not sync posts from Firebase.',
          });
          if (code === 'permission-denied') {
            setRealPosts([]);
            setRealSearchPosts([]);
            setPostsHydrated(true);
          }
        }
      );
    };

    const primaryUnsub = onSnapshot(
      postsQuery,
      (snap) => applySnapshot(snap, 'snapshot-primary'),
      (error: any) => {
        const code = error?.code || '';
        const message = error?.message || String(error);
        console.warn('[FeedScreen][posts] subscribe failed', { code, message });
        reportError(error, {
          key: 'feed.posts.primary',
          fallbackTitle: 'Feed unavailable',
          fallbackMessage: 'Could not sync posts from Firebase.',
        });
        if (code === 'permission-denied') {
          setRealPosts([]);
          setRealSearchPosts([]);
          setPostsHydrated(true);
          return;
        }
        if (code === 'failed-precondition' || code === 'invalid-argument') {
          attachFallback();
        }
      }
    );

    return () => {
      primaryUnsub();
      fallbackUnsub?.();
    };
  }, [activeAndReady, extractPostGarments, extractPostImage, reportError, toMillis, user?.uid]);

  useEffect(() => {
    if (!DEBUG_FEED) return;
    const sourcePosts = realPosts;
    const total = sourcePosts.length;
    const followingCount = sourcePosts.filter((p) => followingIds.has(p.user.id)).length;
    const prev = lastFeedLogRef.current;
    if (!prev || prev.total !== total || prev.following !== followingCount || prev.tab !== activeTab) {
      lastFeedLogRef.current = { total, following: followingCount, tab: activeTab };
      console.log('[FeedScreen][feed]', {
        tab: activeTab,
        totalPosts: total,
        followingPosts: followingCount,
        followingIds: followingIds.size,
        viewerUid: user?.uid || null,
      });
    }
  }, [activeTab, followingIds, realPosts, user?.uid]);

  useEffect(() => {
    if (!activeAndReady) return;
    if (!user) {
      setFollowingIds(new Set());
      return;
    }
    const followingRef = collection(db, 'users', user.uid, 'following');
    const unsub = onSnapshot(
      followingRef,
      (snap) => {
        setFollowingIds(new Set(snap.docs.map((d) => d.id)));
      },
      (error) => {
        if (error?.code === 'permission-denied') {
          setFollowingIds(new Set());
          return;
        }
        console.warn('[FeedScreen] following listener error', error);
        reportError(error, {
          key: 'feed.following.listener',
          fallbackTitle: 'Following unavailable',
          fallbackMessage: 'Could not sync your following list.',
        });
      }
    );
    return () => unsub();
  }, [activeAndReady, reportError, user?.uid]);

  useEffect(() => {
    if (!activeAndReady) return;
    if (!user) {
      setBlockedIds(new Set());
      return;
    }
    const blockedRef = collection(db, 'users', user.uid, 'blocked');
    const unsub = onSnapshot(
      blockedRef,
      (snap) => {
        setBlockedIds(new Set(snap.docs.map((d) => d.id)));
      },
      (error) => {
        if (error?.code === 'permission-denied') {
          setBlockedIds(new Set());
          return;
        }
        console.warn('[FeedScreen] blocked listener error', error);
        reportError(error, {
          key: 'feed.blocked.listener',
          fallbackTitle: 'Safety list unavailable',
          fallbackMessage: 'Could not sync blocked users.',
        });
      }
    );
    return () => unsub();
  }, [activeAndReady, reportError, user?.uid]);

  useEffect(() => {
    if (!activeAndReady) return;
    if (!user) {
      setLikedPostIds(new Set());
      return;
    }
    const unsub = subscribePostLikes(user.uid, (ids) => setLikedPostIds(new Set(ids)));
    return () => unsub();
  }, [activeAndReady, user?.uid]);

  const listingResults = useMemo(() => {
    if (searchScope !== 'listings') return [];
    const tokens = tokenizeQuery(searchQuery);
    if (!tokens.length) return [];
    const allItems = realListings;
    const merged = (() => {
      const seen = new Set<string>();
      const out: Item[] = [];
      allItems.forEach((it) => {
        if (seen.has(it.id)) return;
        seen.add(it.id);
        out.push(it);
      });
      return out;
    })();
    return merged
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
  }, [realListings, scoreText, searchQuery, searchScope, tokenizeQuery]);

  const userResults = useMemo(() => {
    if (searchScope !== 'users') return [];
    const tokens = tokenizeQuery(searchQuery);
    if (!tokens.length) return [];
    const local = realSearchUsers
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
  }, [realSearchUsers, remoteUserResults, scoreText, searchQuery, searchScope, tokenizeQuery]);

  const postResults = useMemo(() => {
    if (searchScope !== 'posts') return [];
    const tokens = tokenizeQuery(searchQuery);
    if (!tokens.length) return [];
    const local = realSearchPosts
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
  }, [realSearchPosts, remotePostResults, scoreText, searchQuery, searchScope, tokenizeQuery]);

  const openProduct = useCallback((p: ProductLike) => {
    if (!p) return;
    setActiveProduct(p);
    setActiveProductId(p.id || null);
    requestAnimationFrame(() => setModalOpen(true));
  }, []);

  const onSelectListing = useCallback(
    (item: Item) => {
      const listingItem = item as ListingItem;
      const product = listingItem?.source === 'listing'
        ? listingItemToProduct(listingItem)
        : toProductLike(item);
      setTimeout(() => openProduct(product), 180);
    },
    [openProduct]
  );

  const addRecent = useCallback((value: string) => {
    const next = value.trim();
    if (!next) return;
    setRecentSearches((prev) => [next, ...prev.filter((v) => v.toLowerCase() !== next.toLowerCase())].slice(0, 8));
  }, []);

  const toggleFollow = useCallback(async (userId: string, target?: FeedUser) => {
    if (!user) return;
    const followingRef = doc(db, 'users', user.uid, 'following', userId);
    const followerRef = doc(db, 'users', userId, 'followers', user.uid);
    const authUserRef = doc(db, 'users', user.uid);
    const targetUserRef = doc(db, 'users', userId);
    const isFollowing = followingIds.has(userId);
    const nextIsFollowing = !isFollowing;
    const delta = nextIsFollowing ? 1 : -1;
    if (target) {
      setRealUsers((prev) => {
        const next = { ...prev };
        const existing = next[userId];
        if (!existing) return next;
        next[userId] = {
          ...existing,
          followers: Math.max(0, (existing.followers || 0) + delta),
        };
        return next;
      });
    }
    try {
      await runTransaction(db, async (tx) => {
        const [authSnap, targetSnap] = await Promise.all([
          tx.get(authUserRef),
          tx.get(targetUserRef),
        ]);
        if (!authSnap.exists() || !targetSnap.exists()) {
          throw new Error('missing-user');
        }
        const currentFollowing = Number(authSnap.data()?.followingCount ?? 0);
        const targetFollowers = Number(targetSnap.data()?.followersCount ?? 0);
        if (nextIsFollowing) {
          tx.set(followingRef, { createdAt: serverTimestamp() });
          tx.set(followerRef, { createdAt: serverTimestamp() });
          tx.update(authUserRef, { followingCount: currentFollowing + 1 });
          tx.update(targetUserRef, { followersCount: targetFollowers + 1 });
        } else {
          tx.delete(followingRef);
          tx.delete(followerRef);
          tx.update(authUserRef, { followingCount: Math.max(0, currentFollowing - 1) });
          tx.update(targetUserRef, { followersCount: Math.max(0, targetFollowers - 1) });
        }
      });
      void syncNotificationEvent({
        type: 'follow',
        enabled: nextIsFollowing,
        actorUid: user.uid,
        targetUid: userId,
      });
    } catch (error) {
      if (target) {
        setRealUsers((prev) => {
          const next = { ...prev };
          const existing = next[userId];
          if (!existing) return next;
          next[userId] = {
            ...existing,
            followers: Math.max(0, (existing.followers || 0) - delta),
          };
          return next;
        });
      }
      console.warn('[FeedScreen] follow transaction failed', error);
      reportError(error, {
        key: 'feed.follow.toggle',
        fallbackTitle: 'Action failed',
        fallbackMessage: 'Could not update follow status. Please retry.',
      });
    }
  }, [followingIds, reportError, user]);

  const openResults = useCallback(
    (item?: Item | SearchUser | SearchPost) => {
      addRecent(searchQuery);
      setSearchOpen(false);
      setResultsOpen(true);
      if (item && searchScope === 'listings') {
        setTimeout(() => onSelectListing(item as Item), 260);
      }
    },
    [addRecent, onSelectListing, searchQuery, searchScope]
  );

  const closeResults = useCallback(() => {
    setResultsOpen(false);
    setTimeout(() => setSearchOpen(true), 220);
  }, []);

  const closeSearchOverlay = useCallback(() => {
    setSearchOpen(false);
    setTimeout(() => setSearchQuery(''), 240);
  }, []);

  const togglePostLike = useCallback(
    (post: FeedPost) => {
      if (!user) return;
      const nextLiked = !likedPostIds.has(post.id);
      const delta = nextLiked ? 1 : -1;
      setLikedPostIds((prev) => {
        const next = new Set(prev);
        if (nextLiked) next.add(post.id);
        else next.delete(post.id);
        return next;
      });
      setRealPosts((prev) =>
        prev.map((item) =>
          item.id === post.id ? { ...item, likes: Math.max(0, (item.likes || 0) + delta) } : item
        )
      );
      setLiveLikeCounts((prev) => {
        const current = typeof prev[post.id] === 'number' ? prev[post.id] : post.likes || 0;
        return {
          ...prev,
          [post.id]: Math.max(0, current + delta),
        };
      });
      setActiveCommentsPost((prev) => {
        if (!prev || prev.id !== post.id) return prev;
        return { ...prev, likes: Math.max(0, (prev.likes || 0) + delta) };
      });
      setFeedCache((prev) =>
        registerFeedLike(prev, {
          postId: post.id,
          authorId: post.authorUid,
          liked: nextLiked,
        })
      );
      void setPostLike(user.uid, post.id, nextLiked).catch((error) => {
        setLikedPostIds((prev) => {
          const next = new Set(prev);
          if (nextLiked) next.delete(post.id);
          else next.add(post.id);
          return next;
        });
        setRealPosts((prev) =>
          prev.map((item) =>
            item.id === post.id ? { ...item, likes: Math.max(0, (item.likes || 0) - delta) } : item
          )
        );
        setLiveLikeCounts((prev) => {
          const current = typeof prev[post.id] === 'number' ? prev[post.id] : Math.max(0, (post.likes || 0) + delta);
          return {
            ...prev,
            [post.id]: Math.max(0, current - delta),
          };
        });
        setActiveCommentsPost((prev) => {
          if (!prev || prev.id !== post.id) return prev;
          return { ...prev, likes: Math.max(0, (prev.likes || 0) - delta) };
        });
        setFeedCache((prev) =>
          registerFeedLike(prev, {
            postId: post.id,
            authorId: post.authorUid,
            liked: !nextLiked,
          })
        );
        console.warn('[FeedScreen] setPostLike failed', error);
        reportError(error, {
          key: 'feed.like.toggle',
          fallbackTitle: 'Like failed',
          fallbackMessage: 'Could not update like right now. Please retry.',
        });
      });
    },
    [likedPostIds, reportError, user]
  );

  const openPostOptions = useCallback((post: FeedPost) => {
    setActiveOptionsPost(post);
  }, []);

  const closePostOptions = useCallback(() => {
    setActiveOptionsPost(null);
  }, []);

  const openComments = useCallback((post: FeedPost) => {
    const liveLikes = liveLikeCounts[post.id];
    const liveComments = liveCommentCounts[post.id];
    const viewerLiked = likedPostIds.has(post.id);
    const baseLikes = typeof liveLikes === 'number' ? liveLikes : post.likes;
    setActiveCommentsPost({
      ...post,
      likes: Math.max(0, baseLikes || 0, viewerLiked ? 1 : 0),
      commentCount: typeof liveComments === 'number' ? liveComments : post.commentCount,
    });
  }, [likedPostIds, liveCommentCounts, liveLikeCounts]);

  const closeComments = useCallback(() => {
    setActiveCommentsPost(null);
  }, []);

  const handleCommentsCountChange = useCallback((count: number) => {
    if (!activeCommentsPost) return;
    setLiveCommentCounts((prev) => {
      if (prev[activeCommentsPost.id] === count) return prev;
      return { ...prev, [activeCommentsPost.id]: count };
    });
    setRealPosts((prev) =>
      prev.map((post) =>
        post.id === activeCommentsPost.id
          ? (post.commentCount === count ? post : { ...post, commentCount: count })
          : post
      )
    );
    setActiveCommentsPost((prev) => {
      if (!prev || prev.commentCount === count) return prev;
      return { ...prev, commentCount: count };
    });
  }, [activeCommentsPost]);

  useEffect(() => {
    if (!activeCommentsPost) return;
    const liveCount = liveCommentCounts[activeCommentsPost.id];
    const liveLikes = liveLikeCounts[activeCommentsPost.id];
    const nextCommentCount =
      typeof liveCount === 'number' ? liveCount : activeCommentsPost.commentCount;
    const nextLikeCount =
      typeof liveLikes === 'number' ? liveLikes : activeCommentsPost.likes;
    if (
      nextCommentCount === activeCommentsPost.commentCount &&
      nextLikeCount === activeCommentsPost.likes
    ) {
      return;
    }
    setActiveCommentsPost((prev) => {
      if (!prev || prev.id !== activeCommentsPost.id) return prev;
      if (prev.commentCount === nextCommentCount && prev.likes === nextLikeCount) return prev;
      return { ...prev, commentCount: nextCommentCount, likes: nextLikeCount };
    });
  }, [activeCommentsPost, liveCommentCounts, liveLikeCounts]);

  const submitPostReport = useCallback(async (reasonCode: string) => {
    if (!activeOptionsPost) return;
    if (!user) {
      Alert.alert('Sign in required', 'Please sign in to report posts.');
      return;
    }
    if (activeOptionsPost.authorUid === user.uid) {
      closePostOptions();
      return;
    }
    setModerationBusy(true);
    try {
      await reportPost({
        reporterUid: user.uid,
        postId: activeOptionsPost.id,
        reasonCode,
      });
      Alert.alert('Reported', 'Thanks. We will review this post.');
      closePostOptions();
    } catch (error: any) {
      Alert.alert('Report failed', error?.message || 'Unable to send report right now.');
    } finally {
      setModerationBusy(false);
    }
  }, [activeOptionsPost, closePostOptions, user]);

  const handleReportPost = useCallback(() => {
    if (!activeOptionsPost) return;
    if (!user) {
      Alert.alert('Sign in required', 'Please sign in to report posts.');
      return;
    }
    Alert.alert('Report post', 'Select a reason', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Spam', onPress: () => void submitPostReport('spam') },
      { text: 'Inappropriate', onPress: () => void submitPostReport('inappropriate') },
      { text: 'Harassment', onPress: () => void submitPostReport('harassment') },
    ]);
  }, [activeOptionsPost, submitPostReport, user]);

  const submitUserReport = useCallback(async (reasonCode: string) => {
    if (!activeOptionsPost) return;
    if (!user) {
      Alert.alert('Sign in required', 'Please sign in to report users.');
      return;
    }
    const targetUid = activeOptionsPost.authorUid;
    if (!targetUid || targetUid === user.uid) {
      closePostOptions();
      return;
    }
    setModerationBusy(true);
    try {
      await reportUser({
        reporterUid: user.uid,
        targetUid,
        reasonCode,
        note: `fromPost=${activeOptionsPost.id}`,
      });
      Alert.alert('Reported', 'Thanks. We will review this account.');
      closePostOptions();
    } catch (error: any) {
      Alert.alert('Report failed', error?.message || 'Unable to send report right now.');
    } finally {
      setModerationBusy(false);
    }
  }, [activeOptionsPost, closePostOptions, user]);

  const handleReportUser = useCallback(() => {
    if (!activeOptionsPost) return;
    if (!user) {
      Alert.alert('Sign in required', 'Please sign in to report users.');
      return;
    }
    Alert.alert('Report user', `@${activeOptionsPost.user.username}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Harassment', onPress: () => void submitUserReport('harassment') },
      { text: 'Impersonation', onPress: () => void submitUserReport('impersonation') },
      { text: 'Scam', onPress: () => void submitUserReport('scam') },
    ]);
  }, [activeOptionsPost, submitUserReport, user]);

  const applyBlockToggle = useCallback(async (targetUid: string, nextBlock: boolean) => {
    if (!user) return;
    setBlockedIds((prev) => {
      const next = new Set(prev);
      if (nextBlock) next.add(targetUid);
      else next.delete(targetUid);
      return next;
    });
    setModerationBusy(true);
    try {
      if (nextBlock) {
        await blockUser({
          viewerUid: user.uid,
          targetUid,
          reason: 'blocked from feed',
        });
      } else {
        await unblockUser({
          viewerUid: user.uid,
          targetUid,
        });
      }
      closePostOptions();
    } catch (error: any) {
      setBlockedIds((prev) => {
        const next = new Set(prev);
        if (nextBlock) next.delete(targetUid);
        else next.add(targetUid);
        return next;
      });
      Alert.alert('Action failed', error?.message || 'Unable to update block state.');
    } finally {
      setModerationBusy(false);
    }
  }, [closePostOptions, user]);

  const handleToggleBlock = useCallback(() => {
    if (!activeOptionsPost) return;
    if (!user) {
      Alert.alert('Sign in required', 'Please sign in to block users.');
      return;
    }
    const targetUid = activeOptionsPost.authorUid;
    if (!targetUid || targetUid === user.uid) {
      closePostOptions();
      return;
    }
    const nextBlock = !blockedIds.has(targetUid);
    Alert.alert(
      nextBlock ? `Block @${activeOptionsPost.user.username}?` : `Unblock @${activeOptionsPost.user.username}?`,
      nextBlock
        ? 'You will no longer see their posts.'
        : 'Their posts can appear in your feed again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: nextBlock ? 'Block' : 'Unblock',
          style: nextBlock ? 'destructive' : 'default',
          onPress: () => void applyBlockToggle(targetUid, nextBlock),
        },
      ]
    );
  }, [activeOptionsPost, applyBlockToggle, blockedIds, closePostOptions, user]);

  const handleOpenProfileFromOptions = useCallback(() => {
    if (!activeOptionsPost) return;
    onOpenUser?.(activeOptionsPost.user);
    closePostOptions();
  }, [activeOptionsPost, closePostOptions, onOpenUser]);

  const handleSelectUser = useCallback(
    (userResult: SearchUser) => {
      const feedUser: FeedUser = {
        id: userResult.id,
        username: userResult.username,
        avatarUri: userResult.avatarUri || '',
        bio: userResult.bio || undefined,
        followers: realUsers[userResult.id]?.followers ?? 0,
        following: realUsers[userResult.id]?.following ?? 0,
        source: 'real',
      };
      onOpenUser?.(feedUser);
      setSearchOpen(false);
      setResultsOpen(false);
    },
    [onOpenUser, realUsers]
  );

  const handleSelectPost = useCallback(
    (post: SearchPost) => {
      const author = post.authorId ? realUsers[post.authorId] : undefined;
      if (author) {
        onOpenUser?.(author);
      }
      setSearchOpen(false);
      setResultsOpen(false);
    },
    [onOpenUser, realUsers]
  );

  // Keep enough bottom space so cards clear the Dock (which is floating)
  const bottomPad = insets.bottom + 28 + 64 + s(18);

  const baseFeed = useMemo(() => {
    if (!blockedIds.size) return realPosts;
    return realPosts.filter((post) => !blockedIds.has(post.authorUid));
  }, [blockedIds, realPosts]);

  const combinedLikedIds = useMemo(() => {
    return new Set<string>(likedPostIds);
  }, [likedPostIds]);

  const rankedFollowingFeed = useMemo(() => {
    return rankFollowingFeed({
      posts: baseFeed,
      followingIds,
      likedPostIds: combinedLikedIds,
      cache: feedCache,
    });
  }, [baseFeed, combinedLikedIds, feedCache, followingIds]);

  const rankedForYouFeed = useMemo(() => {
    return rankForYouFeed({
      posts: baseFeed,
      followingIds,
      likedPostIds: combinedLikedIds,
      cache: feedCache,
    });
  }, [baseFeed, combinedLikedIds, feedCache, followingIds]);

  const filteredFeed = useMemo(() => {
    if (activeTab === 'following') {
      return rankedFollowingFeed;
    }
    return rankedForYouFeed;
  }, [activeTab, rankedFollowingFeed, rankedForYouFeed]);

  const feedCap = activeAndReady ? 18 : 6;
  const visibleFeed = useMemo(() => {
    if (activeAndReady) return filteredFeed;
    return filteredFeed.slice(0, feedCap);
  }, [activeAndReady, feedCap, filteredFeed]);
  const feedWarmupUris = useMemo(() => {
    const uris: string[] = [];
    visibleFeed.slice(0, 14).forEach((post) => {
      uris.push(post.modelUri, post.user.avatarUri || '');
      post.garments.slice(0, 4).forEach((garment) => {
        uris.push(garment.images?.[0] || garment.image || '');
      });
    });
    if (searchScope === 'posts') {
      postResults.slice(0, 20).forEach((post) => uris.push(post.image));
    } else if (searchScope === 'users') {
      userResults.slice(0, 20).forEach((u) => uris.push(u.avatarUri || ''));
    }
    return uris;
  }, [postResults, searchScope, userResults, visibleFeed]);

  const visibleRealPostIds = useMemo(() => visibleFeed.map((post) => post.id), [visibleFeed]);

  useEffect(() => {
    if (!screenReady) return;
    void warmImageCache(feedWarmupUris, {
      cachePolicy: 'memory-disk',
      chunkSize: 18,
    });
  }, [feedWarmupUris, screenReady]);

  useEffect(() => {
    if (!activeAndReady || !user || !visibleRealPostIds.length) return;
    const unsubs = visibleRealPostIds.map((postId) =>
      onSnapshot(
        collection(db, 'posts', postId, 'likers'),
        (snap) => {
          setLiveLikeCounts((prev) => {
            if (prev[postId] === snap.size) return prev;
            return { ...prev, [postId]: snap.size };
          });
        },
        (error) => {
          if (error?.code === 'permission-denied') return;
          console.warn('[FeedScreen] live like count listener failed', { postId, error });
          reportError(error, {
            key: 'feed.liveLikes.listener',
            fallbackTitle: 'Live updates paused',
            fallbackMessage: 'Like counts may be out of date until connection returns.',
          });
        }
      )
    );
    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [activeAndReady, reportError, user?.uid, visibleRealPostIds]);

  useEffect(() => {
    if (!activeAndReady || !user || !visibleRealPostIds.length) return;
    const unsubs = visibleRealPostIds.map((postId) =>
      onSnapshot(
        collection(db, 'posts', postId, 'comments'),
        (snap) => {
          setLiveCommentCounts((prev) => {
            if (prev[postId] === snap.size) return prev;
            return { ...prev, [postId]: snap.size };
          });
        },
        (error) => {
          if (error?.code === 'permission-denied') return;
          console.warn('[FeedScreen] live comment count listener failed', { postId, error });
          reportError(error, {
            key: 'feed.liveComments.listener',
            fallbackTitle: 'Live updates paused',
            fallbackMessage: 'Comment counts may be out of date until connection returns.',
          });
        }
      )
    );
    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [activeAndReady, reportError, user?.uid, visibleRealPostIds]);

  useEffect(() => {
    if (!activeAndReady || !feedCacheReady || !filteredFeed.length) return;
    const top = filteredFeed.slice(0, 8).map((post) => ({
      postId: post.id,
      authorId: post.authorUid,
    }));
    setFeedCache((prev) => registerFeedImpressions(prev, top));
  }, [activeAndReady, feedCacheReady, filteredFeed]);

  useEffect(() => {
    if (!DEBUG_FEED) return;
    const now = Date.now();
    if (now - lastRankLogAtRef.current < 8000) return;
    lastRankLogAtRef.current = now;
    console.log('[FeedScreen][rank]', {
      tab: activeTab,
      forYouTop: rankedForYouFeed.slice(0, 5).map((p) => p.id),
      followingTop: rankedFollowingFeed.slice(0, 5).map((p) => p.id),
      followingCount: followingIds.size,
      likedCount: combinedLikedIds.size,
      cachePosts: Object.keys(feedCache.posts).length,
      cacheAuthors: Object.keys(feedCache.authors).length,
    });
  }, [activeTab, combinedLikedIds, feedCache, followingIds, rankedFollowingFeed, rankedForYouFeed]);

  const renderFeedPostItem = useCallback(
    ({ item: post }: { item: FeedPost }) => {
      const viewerLiked = likedPostIds.has(post.id);
      const renderedPost = {
        ...post,
        likes:
          Math.max(
            0,
            typeof liveLikeCounts[post.id] === 'number'
              ? liveLikeCounts[post.id]
              : post.likes,
            viewerLiked ? 1 : 0
          ),
        commentCount:
          typeof liveCommentCounts[post.id] === 'number'
            ? liveCommentCounts[post.id]
            : post.commentCount,
      };
      return (
        <FeedPostCard
          post={renderedPost}
          onOpenProduct={openProduct}
          onOpenUser={(u) =>
            onOpenUser?.({
              ...u,
              avatarUri: u.avatarUri || '',
              source: 'real',
            })
          }
          isFollowing={followingIds.has(post.user.id)}
          canFollow={Boolean(user)}
          onToggleFollow={() => void toggleFollow(post.user.id, post.user)}
          isOwnPost={post.authorUid === user?.uid}
          onOpenOptions={() => openPostOptions(post)}
          onOpenComments={() => openComments(post)}
          liked={viewerLiked}
          onToggleLike={() => togglePostLike(post)}
        />
      );
    },
    [
      likedPostIds,
      liveCommentCounts,
      liveLikeCounts,
      onOpenUser,
      openComments,
      openPostOptions,
      openProduct,
      followingIds,
      toggleFollow,
      togglePostLike,
      user,
    ]
  );

  const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);

  return (
    <View style={styles.root}>
      <MinimalHeader title="Feed" onSearch={() => setSearchOpen((prev) => !prev)} />

      {/* Primary feed switcher */}
      <View style={styles.tabBarWrap}>
        <SegmentedTabs
          tabs={FEED_TABS}
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as FeedTab)}
        />
      </View>

      <FlatList
        data={visibleFeed}
        keyExtractor={(post) => post.id}
        renderItem={renderFeedPostItem}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={false}
        initialNumToRender={4}
        maxToRenderPerBatch={5}
        windowSize={7}
        contentContainerStyle={{ paddingHorizontal: s(3), paddingTop: s(2), paddingBottom: bottomPad, gap: s(4) }}
        ListEmptyComponent={
          <View style={styles.empty}>
            {!postsHydrated ? (
              <>
                <ActivityIndicator size="small" color={colors.textDim} />
                <Text style={[font.p, { color: colors.textDim, textAlign: 'center' }]}>Loading feed…</Text>
              </>
            ) : (
              <>
                <Ionicons name="sparkles-outline" size={18} color={colors.textDim} />
                <Text style={[font.p, { color: colors.textDim, textAlign: 'center' }]}>No posts to show yet.</Text>
                {activeTab === 'following' ? (
                  <Text style={[font.p, { color: colors.textDim, textAlign: 'center' }]}>Follow creators to see their looks here.</Text>
                ) : (
                  <Text style={[font.p, { color: colors.textDim, textAlign: 'center' }]}>Check back soon for new recommendations.</Text>
                )}
              </>
            )}
          </View>
        }
      />

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
        onSelectItem={onSelectListing}
        onSelectUser={handleSelectUser}
        onSelectPost={handleSelectPost}
      />

      <PostCommentsScreen
        visible={Boolean(activeCommentsPost)}
        post={activeCommentsPost}
        viewerUid={user?.uid || null}
        viewerUsername={profile?.username || ''}
        viewerPhotoURL={profile?.photoURL || ''}
        followingIds={[...followingIds]}
        knownUsers={realUsers}
        onCountChange={handleCommentsCountChange}
        viewerLikedPost={
          activeCommentsPost
            ? likedPostIds.has(activeCommentsPost.id)
            : false
        }
        onOpenProduct={(product) => openProduct(product)}
        onOpenUser={(u) => {
          const feedUser: FeedUser = {
            id: u.id,
            username: u.username,
            avatarUri: u.avatarUri || '',
            bio: u.bio || undefined,
            followers: realUsers[u.id]?.followers ?? 0,
            following: realUsers[u.id]?.following ?? 0,
            source: 'real',
          };
          onOpenUser?.(feedUser);
          closeComments();
        }}
        onToggleFollowUser={(userId) => {
          const target = activeCommentsPost?.user;
          if (!target) return;
          void toggleFollow(userId, target);
        }}
        onClose={closeComments}
      />

      <PostOptionsSheet
        visible={Boolean(activeOptionsPost)}
        isOwnPost={Boolean(
          user?.uid && activeOptionsPost?.authorUid && activeOptionsPost.authorUid === user.uid
        )}
        blocked={activeOptionsPost ? blockedIds.has(activeOptionsPost.authorUid) : false}
        busy={moderationBusy}
        onViewProfile={handleOpenProfileFromOptions}
        onReport={handleReportPost}
        onReportUser={handleReportUser}
        onToggleBlock={handleToggleBlock}
        onClose={closePostOptions}
      />

      <ProductModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        product={activeProduct}
        onTry={(p) => {
          setModalOpen(false);
        }}
        initialLiked={isListingLiked(activeProductId, activeProduct?.listingId)}
        onLikeChange={(liked, product) => {
          if (product?.id) setListingLiked(product.id, liked, product.listingId);
        }}
      />
    </View>
  );
}

/* ----------------------------- styles ---------------------------- */

const makeStyles = (colors: any, isDark: boolean) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  tabBarWrap: {
    paddingHorizontal: s(3),
    paddingTop: s(2),
    paddingBottom: s(1),
  },

  empty: {
    height: 140,
    borderRadius: 16,
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
});
