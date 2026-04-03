import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { View, StyleSheet, ScrollView, Text, Animated, Pressable, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  collection,
  DocumentData,
  QueryDocumentSnapshot,
  query,
  where,
  onSnapshot,
  getDocs,
  documentId,
  doc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import MinimalHeader from '../components/MinimalHeader';
import { font, s } from '../theme/tokens';
import ProfileHeader from '../components/profile/ProfileHeader';
import FollowListModal from '../components/profile/FollowListModal';
import SegmentedTabs from '../components/ui/SegmentedTabs';
import SegmentedChips from '../components/ui/SegmentedChips';
import ProfileGrid, { GridItem } from '../components/profile/ProfileGrid';
import { FeedUser } from './FeedScreen';
import ProductModal, { type ProductLike } from '../components/ProductModal';
import PostCommentsScreen, { type CommentScreenPostPreview } from '../components/feed/PostCommentsScreen';
import { useTheme } from '../theme/ThemeContext';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useNav } from '../navigation/NavContext';
import type { SearchUser } from '../components/HeaderSearchOverlay';
import { useRightSwipeDismiss } from '../hooks/useRightSwipeDismiss';
import { blockUser, reportUser, unblockUser } from '../lib/postModeration';
import { useListingLikes } from '../lib/listingLikes';
import { subscribePostLikes } from '../lib/postLikes';
import { syncNotificationEvent } from '../lib/notifications';

const DOCK_BOTTOM_OFFSET = 28;
const DOCK_HEIGHT = 64;
const DOCK_CLEAR = DOCK_BOTTOM_OFFSET + DOCK_HEIGHT;

type PublicTab = 'listings' | 'posts' | 'likes' | 'sold';
type LikesTab = 'liked_listings' | 'liked_posts';

type Props = {
  user: FeedUser;
  onClose?: () => void;
};

type FollowMode = 'followers' | 'following';

const LISTING_PREFIX = 'listing:';
const REAL_LISTING_PREFIX = 'real-listing-';
const LIKED_LISTING_PREFIX = 'liked-listing:';

const isFirestoreDocId = (value: string) => /^[A-Za-z0-9_-]{20,}$/.test(value);

const parseListingLikeDocId = (rawId: string): string | null => {
  const value = String(rawId || '').trim();
  if (!value) return null;
  if (value.startsWith(LISTING_PREFIX)) return value.slice(LISTING_PREFIX.length);
  if (value.startsWith(REAL_LISTING_PREFIX)) return value.slice(REAL_LISTING_PREFIX.length);
  if (value.startsWith(LIKED_LISTING_PREFIX)) return value.slice(LIKED_LISTING_PREFIX.length);
  if (isFirestoreDocId(value)) return value;
  return null;
};

const extractListingImageFromData = (data: any): string | null => {
  return (
    data?.primeImage?.url ||
    data?.coverImage?.url ||
    data?.image?.url ||
    data?.imageUrl ||
    data?.thumbnailUrl ||
    data?.thumbnail ||
    data?.photos?.[0]?.url ||
    data?.photos?.[0] ||
    data?.images?.[0]?.url ||
    data?.images?.[0] ||
    (typeof data?.image === 'string' ? data.image : null) ||
    null
  );
};

const listingDocToProductLike = (
  docSnap: QueryDocumentSnapshot<DocumentData>,
  data: any,
  fallbackImage: string | null
): ProductLike => {
  const image = fallbackImage || extractListingImageFromData(data);
  const title = String(data?.title || data?.name || data?.productName || data?.itemName || 'Listing');
  const amount =
    typeof data?.price?.amount === 'number'
      ? data.price.amount
      : typeof data?.priceCents === 'number'
        ? data.priceCents
        : typeof data?.price === 'number'
          ? data.price * (data.price > 999 ? 1 : 100)
          : undefined;
  const price = typeof amount === 'number' ? `£${Math.max(0, Math.round(amount / 100))}` : null;
  const photos = Array.isArray(data?.photos) ? data.photos : [];
  const images = Array.isArray(data?.images) ? data.images : [];
  const mergedImages = [image, ...photos, ...images]
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      return entry?.url || entry?.downloadURL || entry?.downloadUrl || null;
    })
    .filter(Boolean) as string[];
  const uniqueImages = Array.from(new Set(mergedImages));
  const category = data?.category?.name || data?.categoryName || data?.category || null;
  const brand = data?.brand?.name || data?.brandName || data?.brand || null;
  return {
    id: `${LISTING_PREFIX}${docSnap.id}`,
    listingId: docSnap.id,
    sellerUid: typeof data?.sellerUid === 'string' ? data.sellerUid : null,
    likeCount:
      typeof data?.likeCount === 'number'
        ? Math.max(0, Math.round(data.likeCount))
        : typeof data?.likes === 'number'
          ? Math.max(0, Math.round(data.likes))
          : 0,
    title,
    description: data?.description || null,
    brand,
    price,
    images: uniqueImages,
    image: image || uniqueImages[0] || null,
    category,
    size: data?.size || null,
    condition: data?.condition || null,
    tags: Array.isArray(data?.tags) ? data.tags.map(String) : null,
  };
};

const extractPostGarments = (data: any): ProductLike[] => {
  const rawItems = Array.isArray(data?.garments)
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
  return rawItems
    .map((raw: any, idx: number) => {
      const obj = typeof raw === 'object' && raw ? raw : {};
      const listingId = String(obj?.listingId || obj?.itemId || '').trim() || null;
      const image =
        (typeof raw === 'string' ? raw : null) ||
        obj?.image ||
        obj?.imageUrl ||
        obj?.imageURL ||
        obj?.photoURL ||
        obj?.thumbnail ||
        obj?.primeImage?.url ||
        obj?.coverImage?.url ||
        null;
      const title = obj?.title || obj?.name || obj?.role || 'Item';
      if (!image && !title) return null;
      return {
        id: String(obj?.id || obj?.itemId || `${idx}`),
        listingId,
        title: String(title),
        brand: obj?.brand || null,
        price: obj?.price || null,
        images: image ? [image] : [],
        image: image || null,
        category: obj?.category || obj?.role || null,
        size: obj?.size || null,
        condition: obj?.condition || null,
        tags: Array.isArray(obj?.tags) ? obj.tags.map(String) : null,
      } as ProductLike;
    })
    .filter(Boolean) as ProductLike[];
};

export default function UserProfileScreen({ user, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { user: authUser } = useAuth();
  const nav = useNav();
  const { isLiked: isListingLiked, setLiked: setListingLiked } = useListingLikes(authUser?.uid);
  const [isFollowing, setIsFollowing] = useState(false);
  const [profileUser, setProfileUser] = useState<FeedUser>(user);
  const [realListings, setRealListings] = useState<GridItem[]>([]);
  const [realSoldListings, setRealSoldListings] = useState<GridItem[]>([]);
  const [realPosts, setRealPosts] = useState<GridItem[]>([]);
  const [realLikedListings, setRealLikedListings] = useState<GridItem[]>([]);
  const [realLikedPosts, setRealLikedPosts] = useState<GridItem[]>([]);
  const [listingProductsByGridId, setListingProductsByGridId] = useState<Record<string, ProductLike>>({});
  const [likedListingProductsByGridId, setLikedListingProductsByGridId] = useState<Record<string, ProductLike>>({});
  const [postPreviewByGridId, setPostPreviewByGridId] = useState<Record<string, CommentScreenPostPreview>>({});
  const [likedPostPreviewByGridId, setLikedPostPreviewByGridId] = useState<Record<string, CommentScreenPostPreview>>({});
  const [activeProduct, setActiveProduct] = useState<ProductLike | null>(null);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [activeCommentsPost, setActiveCommentsPost] = useState<CommentScreenPostPreview | null>(null);
  const [viewerLikedPostIds, setViewerLikedPostIds] = useState<Set<string>>(new Set());
  const [followMode, setFollowMode] = useState<FollowMode | null>(null);
  const isOwner = authUser?.uid === user.id;
  const [isBlocked, setIsBlocked] = useState(false);
  const [moderationBusy, setModerationBusy] = useState(false);

  const extractPostImage = useCallback((data: any) => {
    const images = Array.isArray(data?.images) ? data.images : [];
    const first = images[0];
    const fromImages = typeof first === 'string' ? first : first?.url;
    return (
      fromImages ||
      (typeof data?.image === 'string' ? data.image : null) ||
      data?.image?.url ||
      data?.imageUrl ||
      data?.imageURL ||
      data?.photoURL ||
      data?.thumbnailUrl ||
      data?.thumbnail ||
      null
    );
  }, []);

  const {
    translateX,
    opacity,
    bgOpacity,
    panHandlers,
    isDraggingRef,
    closeWithSwipe,
  } = useRightSwipeDismiss({
    visible: true,
    onDismiss: () => onClose?.(),
  });

  const handleBack = useCallback(() => {
    closeWithSwipe();
  }, [closeWithSwipe]);

  const openFollowers = useCallback(() => setFollowMode('followers'), []);
  const openFollowing = useCallback(() => setFollowMode('following'), []);
  const closeFollowModal = useCallback(() => setFollowMode(null), []);

  const handleSelectUser = useCallback(
    (selected: SearchUser) => {
      nav.navigate({
        name: 'user',
        user: {
          id: selected.id,
          username: selected.username,
          avatarUri: selected.avatarUri || '',
          bio: selected.bio || undefined,
          source: 'real',
        },
      } as any);
      setFollowMode(null);
    },
    [nav]
  );

  // ─── mock data (fallback) ───
  const listings: GridItem[] = useMemo(
    () =>
      Array.from({ length: 9 }).map((_, i) => ({
        id: `u-${user.id}-list-${i}`,
        uri: `https://picsum.photos/seed/u-${user.id}-list-${i}/700/900`,
        price: 55 + (i % 5) * 7,
      })),
    [user.id]
  );
  const posts: GridItem[] = useMemo(
    () =>
      Array.from({ length: 8 }).map((_, i) => ({
        id: `u-${user.id}-post-${i}`,
        uri: `https://picsum.photos/seed/u-${user.id}-post-${i}/900/900`,
        meta: 'Post',
      })),
    [user.id]
  );
  const likedListings: GridItem[] = useMemo(
    () =>
      Array.from({ length: 7 }).map((_, i) => ({
        id: `u-${user.id}-liked-list-${i}`,
        uri: `https://picsum.photos/seed/u-${user.id}-liked-list-${i}/700/900`,
        price: 48 + i * 3,
      })),
    [user.id]
  );
  const soldListings: GridItem[] = useMemo(
    () =>
      Array.from({ length: 5 }).map((_, i) => ({
        id: `u-${user.id}-sold-list-${i}`,
        uri: `https://picsum.photos/seed/u-${user.id}-sold-list-${i}/700/900`,
        price: 42 + i * 4,
        sold: true,
      })),
    [user.id]
  );
  const likedPosts: GridItem[] = useMemo(
    () =>
      Array.from({ length: 8 }).map((_, i) => ({
        id: `u-${user.id}-liked-post-${i}`,
        uri: `https://picsum.photos/seed/u-${user.id}-liked-post-${i}/900/900`,
        meta: 'Post',
      })),
    [user.id]
  );

  const mergeGridItems = useCallback((primary: GridItem[], fallback: GridItem[]) => {
    const seen = new Set<string>();
    const out: GridItem[] = [];
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

  const combinedListings = useMemo(
    () => mergeGridItems(realListings, listings),
    [mergeGridItems, realListings, listings]
  );
  const combinedPosts = useMemo(
    () => mergeGridItems(realPosts, posts),
    [mergeGridItems, realPosts, posts]
  );
  const combinedLikedListings = useMemo(
    () => mergeGridItems(realLikedListings, likedListings),
    [mergeGridItems, realLikedListings, likedListings]
  );
  const combinedLikedPosts = useMemo(
    () => mergeGridItems(realLikedPosts, likedPosts),
    [mergeGridItems, realLikedPosts, likedPosts]
  );
  const combinedSold = useMemo(
    () => mergeGridItems(realSoldListings, soldListings),
    [mergeGridItems, realSoldListings, soldListings]
  );

  useEffect(() => {
    const userRef = doc(db, 'users', user.id);
    const unsubUser = onSnapshot(
      userRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as any;
        setProfileUser({
          id: snap.id,
          username: data?.username || user.username,
          displayName: data?.displayName || user.displayName || data?.username || user.username,
          avatarUri: data?.photoURL || user.avatarUri,
          bio: data?.bio || user.bio,
          followers: data?.followersCount ?? user.followers,
          following: data?.followingCount ?? user.following,
          source: 'real',
        });
      },
      (error) => {
        if (error?.code === 'permission-denied') {
          return;
        }
        console.warn('[UserProfileScreen] user listener error', error);
      }
    );
    return () => unsubUser();
  }, [user]);

  useEffect(() => {
    const listingsRef = collection(db, 'listings');
    const listingsQuery = query(listingsRef, where('sellerUid', '==', user.id));
    const unsubListings = onSnapshot(
      listingsQuery,
      (snap) => {
        const active: GridItem[] = [];
        const sold: GridItem[] = [];
        const nextProducts: Record<string, ProductLike> = {};
        snap.docs.forEach((docSnap) => {
          const data = docSnap.data() as any;
          const image = extractListingImageFromData(data);
          if (!image) return;
          const listingId = docSnap.id;
          const status = String(data?.status || '').toLowerCase();
          const gridId = `listing-${listingId}`;
          const soldFlag = status === 'sold';
          const price = typeof data?.price?.amount === 'number' ? Math.round(data.price.amount / 100) : undefined;
          const gridItem: GridItem = {
            id: gridId,
            listingId,
            uri: image,
            price,
            sold: soldFlag,
            title: String(data?.title || data?.name || 'Listing'),
          };
          if (soldFlag) sold.push(gridItem);
          else active.push({ ...gridItem, sold: false });
          nextProducts[gridId] = listingDocToProductLike(docSnap, data, image);
        });
        setRealListings(active);
        setRealSoldListings(sold);
        setListingProductsByGridId(nextProducts);
      },
      (error) => {
        if (error?.code === 'permission-denied') {
          setRealListings([]);
          setRealSoldListings([]);
          setListingProductsByGridId({});
          return;
        }
        console.warn('[UserProfileScreen] listings listener error', error);
      }
    );
    return () => unsubListings();
  }, [user.id]);

  useEffect(() => {
    const postsRef = collection(db, 'posts');
    const postsQuery = query(postsRef, where('authorUid', '==', user.id));
    const unsubPosts = onSnapshot(
      postsQuery,
      (snap) => {
        const items: GridItem[] = [];
        const previews: Record<string, CommentScreenPostPreview> = {};
        snap.docs.forEach((docSnap) => {
          const data = docSnap.data() as any;
          const uri = extractPostImage(data);
          if (!uri) return;
          const postId = docSnap.id;
          const gridId = `post-${postId}`;
          items.push({
            id: gridId,
            uri,
            meta: 'Post',
            title: String(data?.caption || data?.title || 'Post'),
          });
          previews[gridId] = {
            id: postId,
            user: {
              id: user.id,
              username: profileUser.username,
              avatarUri: profileUser.avatarUri,
              bio: profileUser.bio,
            },
            modelUri: uri,
            caption: typeof data?.caption === 'string' ? data.caption : null,
            likes: Number(data?.likeCount ?? 0) || 0,
            commentCount: Number(data?.commentCount ?? 0) || 0,
            garments: extractPostGarments(data),
          };
        });
        setRealPosts(items);
        setPostPreviewByGridId(previews);
      },
      (error) => {
        if (error?.code === 'permission-denied') {
          setRealPosts([]);
          setPostPreviewByGridId({});
          return;
        }
        console.warn('[UserProfileScreen] posts listener error', error);
      }
    );
    return () => unsubPosts();
  }, [extractPostImage, profileUser.avatarUri, profileUser.bio, profileUser.username, user.id]);

  useEffect(() => {
    const likesRef = collection(db, 'users', user.id, 'postLikes');
    let cancelled = false;
    const unsubLikes = onSnapshot(
      likesRef,
      (snap) => {
        const ids = snap.docs.map((d) => d.id);
        if (!ids.length) {
          setRealLikedPosts([]);
          setLikedPostPreviewByGridId({});
          return;
        }
        const load = async () => {
          const chunks: string[][] = [];
          for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
          const out: GridItem[] = [];
          const previews: Record<string, CommentScreenPostPreview> = {};
          for (const batch of chunks) {
            const postsRef = collection(db, 'posts');
            const postsQuery = query(postsRef, where(documentId(), 'in', batch));
            const result = await getDocs(postsQuery);
            result.docs.forEach((docSnap) => {
              const data = docSnap.data() as any;
              const uri = extractPostImage(data);
              if (!uri) return;
              const postId = docSnap.id;
              const gridId = `liked-post-${postId}`;
              const authorUid = String(data?.authorUid || user.id);
              const authorUsername = String(
                data?.authorUsername ||
                data?.username ||
                (authorUid === user.id ? profileUser.username : 'user')
              );
              const authorAvatar = data?.authorPhotoURL || data?.authorAvatar || (authorUid === user.id ? profileUser.avatarUri : null);
              out.push({ id: gridId, uri, meta: 'Post', title: String(data?.caption || data?.title || 'Post') });
              previews[gridId] = {
                id: postId,
                user: {
                  id: authorUid,
                  username: authorUsername,
                  avatarUri: authorAvatar,
                  bio: data?.authorBio || undefined,
                },
                modelUri: uri,
                caption: typeof data?.caption === 'string' ? data.caption : null,
                likes: Number(data?.likeCount ?? 0) || 0,
                commentCount: Number(data?.commentCount ?? 0) || 0,
                garments: extractPostGarments(data),
              };
            });
          }
          if (!cancelled) {
            setRealLikedPosts(out);
            setLikedPostPreviewByGridId(previews);
          }
        };
        void load();
      },
      (error) => {
        if (error?.code === 'permission-denied') {
          setRealLikedPosts([]);
          setLikedPostPreviewByGridId({});
          return;
        }
        console.warn('[UserProfileScreen] likes listener error', error);
      }
    );
    return () => {
      cancelled = true;
      unsubLikes();
    };
  }, [extractPostImage, profileUser.avatarUri, profileUser.username, user.id]);

  useEffect(() => {
    const likesRef = collection(db, 'users', user.id, 'listingLikes');
    let cancelled = false;
    const unsubLikes = onSnapshot(
      likesRef,
      (snap) => {
        const ids = snap.docs
          .map((docSnap) => parseListingLikeDocId(docSnap.id))
          .filter(Boolean) as string[];
        const uniqueIds = Array.from(new Set(ids));
        if (!uniqueIds.length) {
          setRealLikedListings([]);
          setLikedListingProductsByGridId({});
          return;
        }
        const load = async () => {
          const chunks: string[][] = [];
          for (let i = 0; i < uniqueIds.length; i += 10) chunks.push(uniqueIds.slice(i, i + 10));
          const out: GridItem[] = [];
          const products: Record<string, ProductLike> = {};
          for (const batch of chunks) {
            const listingsRef = collection(db, 'listings');
            const listingsQuery = query(listingsRef, where(documentId(), 'in', batch));
            const result = await getDocs(listingsQuery);
            result.docs.forEach((docSnap) => {
              const data = docSnap.data() as any;
              const image = extractListingImageFromData(data);
              if (!image) return;
              const gridId = `liked-listing-${docSnap.id}`;
              out.push({
                id: gridId,
                listingId: docSnap.id,
                uri: image,
                price: typeof data?.price?.amount === 'number' ? Math.round(data.price.amount / 100) : undefined,
                sold: String(data?.status || '').toLowerCase() === 'sold',
                title: String(data?.title || data?.name || 'Listing'),
              });
              products[gridId] = listingDocToProductLike(docSnap, data, image);
            });
          }
          if (!cancelled) {
            setRealLikedListings(out);
            setLikedListingProductsByGridId(products);
          }
        };
        void load();
      },
      (error) => {
        if (error?.code === 'permission-denied') {
          setRealLikedListings([]);
          setLikedListingProductsByGridId({});
          return;
        }
        console.warn('[UserProfileScreen] liked listings listener error', error);
      }
    );
    return () => {
      cancelled = true;
      unsubLikes();
    };
  }, [user.id]);

  useEffect(() => {
    if (!authUser?.uid) {
      setViewerLikedPostIds(new Set());
      return;
    }
    const unsub = subscribePostLikes(authUser.uid, (ids) => setViewerLikedPostIds(new Set(ids)));
    return () => unsub();
  }, [authUser?.uid]);

  useEffect(() => {
    if (!authUser || user.id === authUser.uid) return;
    const followRef = doc(db, 'users', authUser.uid, 'following', user.id);
    const unsub = onSnapshot(
      followRef,
      (snap) => setIsFollowing(snap.exists()),
      (error) => {
        if (error?.code === 'permission-denied') {
          setIsFollowing(false);
          return;
        }
        console.warn('[UserProfileScreen] follow listener error', error);
      }
    );
    return () => unsub();
  }, [authUser?.uid, user.id]);

  useEffect(() => {
    if (!authUser || user.id === authUser.uid) {
      setIsBlocked(false);
      return;
    }
    const blockedRef = doc(db, 'users', authUser.uid, 'blocked', user.id);
    const unsub = onSnapshot(
      blockedRef,
      (snap) => setIsBlocked(snap.exists()),
      (error) => {
        if (error?.code === 'permission-denied') {
          setIsBlocked(false);
          return;
        }
        console.warn('[UserProfileScreen] blocked listener error', error);
      }
    );
    return () => unsub();
  }, [authUser?.uid, user.id]);

  // ─── tabs ───
  const [tab, setTab] = useState<PublicTab>('listings');
  const [likesTab, setLikesTab] = useState<LikesTab>('liked_listings');
  const bottomPad = insets.bottom + DOCK_CLEAR + s(12);
  const knownUsers = useMemo(
    () => ({
      [profileUser.id]: {
        id: profileUser.id,
        username: profileUser.username,
        avatarUri: profileUser.avatarUri || '',
        bio: profileUser.bio,
      },
    }),
    [profileUser]
  );

  const mainTabs = useMemo(
    () => [
      { key: 'listings', label: 'Listings' },
      { key: 'posts', label: 'Posts' },
      { key: 'likes', label: 'Likes' },
      { key: 'sold', label: 'Sold' },
    ],
    []
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: 'transparent' },
        h2: { ...font.h2, color: colors.text, marginBottom: s(2) },
        followBtn: {
          minWidth: 180,
          paddingVertical: s(2.2),
          paddingHorizontal: s(6),
          borderRadius: 999,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? '#fff' : colors.text,
        },
        followText: { color: isDark ? colors.bg : '#fff', fontWeight: '800', letterSpacing: 0.2 },
        followingBtn: {
          backgroundColor: 'transparent',
          borderColor: colors.borderLight,
        },
        followingText: { color: colors.text },
        profileOptionsBtn: {
          width: 42,
          height: 42,
          borderRadius: 21,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.72)',
        },
      }),
    [colors, isDark]
  );

  const handleToggleFollow = useCallback(async () => {
    if (!authUser || user.id === authUser.uid) return;
    const followingRef = doc(db, 'users', authUser.uid, 'following', user.id);
    const followerRef = doc(db, 'users', user.id, 'followers', authUser.uid);
    const authUserRef = doc(db, 'users', authUser.uid);
    const targetUserRef = doc(db, 'users', user.id);
    const nextIsFollowing = !isFollowing;
    const delta = nextIsFollowing ? 1 : -1;
    setIsFollowing(nextIsFollowing);
    setProfileUser((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        followers: Math.max(0, (prev.followers || 0) + delta),
      };
    });
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
        actorUid: authUser.uid,
        targetUid: user.id,
      });
    } catch (error) {
      // rollback optimistic update on error
      setIsFollowing(!nextIsFollowing);
      setProfileUser((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          followers: Math.max(0, (prev.followers || 0) - delta),
        };
      });
      console.warn('[UserProfileScreen] follow transaction failed', error);
    }
  }, [authUser, isFollowing, user.id]);

  const submitUserReport = useCallback(async (reasonCode: string) => {
    if (!authUser || user.id === authUser.uid) return;
    setModerationBusy(true);
    try {
      await reportUser({
        reporterUid: authUser.uid,
        targetUid: user.id,
        reasonCode,
        note: 'reported from profile screen',
      });
      Alert.alert('Reported', 'Thanks. We will review this profile.');
    } catch (error: any) {
      Alert.alert('Report failed', error?.message || 'Unable to submit report right now.');
    } finally {
      setModerationBusy(false);
    }
  }, [authUser, user.id]);

  const confirmToggleBlock = useCallback(() => {
    if (!authUser || user.id === authUser.uid) return;
    const nextBlock = !isBlocked;
    Alert.alert(
      nextBlock ? `Block @${profileUser.username}?` : `Unblock @${profileUser.username}?`,
      nextBlock
        ? 'You will no longer see this user in feed and profile contexts.'
        : 'This user may appear in feed and profile contexts again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: nextBlock ? 'Block' : 'Unblock',
          style: nextBlock ? 'destructive' : 'default',
          onPress: async () => {
            setModerationBusy(true);
            setIsBlocked(nextBlock);
            try {
              if (nextBlock) {
                await blockUser({
                  viewerUid: authUser.uid,
                  targetUid: user.id,
                  reason: 'blocked from profile',
                });
              } else {
                await unblockUser({
                  viewerUid: authUser.uid,
                  targetUid: user.id,
                });
              }
            } catch (error: any) {
              setIsBlocked(!nextBlock);
              Alert.alert('Action failed', error?.message || 'Unable to update block state.');
            } finally {
              setModerationBusy(false);
            }
          },
        },
      ]
    );
  }, [authUser, isBlocked, profileUser.username, user.id]);

  const openProfileModeration = useCallback(() => {
    if (!authUser || user.id === authUser.uid) return;
    Alert.alert('Profile actions', `@${profileUser.username}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Report profile', onPress: () => void submitUserReport('profile') },
      { text: 'Report user', onPress: () => void submitUserReport('harassment') },
      {
        text: isBlocked ? 'Unblock user' : 'Block user',
        style: isBlocked ? 'default' : 'destructive',
        onPress: confirmToggleBlock,
      },
    ]);
  }, [authUser, confirmToggleBlock, isBlocked, profileUser.username, submitUserReport, user.id]);

  const openListingItem = useCallback((item: GridItem) => {
    const fromSeller = listingProductsByGridId[item.id];
    const fromLiked = likedListingProductsByGridId[item.id];
    const fallbackListingId = item.listingId || String(item.id || '').replace(/^listing-/, '').replace(/^liked-listing-/, '');
    const product = fromSeller || fromLiked || {
      id: fallbackListingId ? `${LISTING_PREFIX}${fallbackListingId}` : item.id,
      listingId: fallbackListingId || null,
      title: item.title || 'Listing',
      price: typeof item.price === 'number' ? `£${item.price}` : null,
      images: item.uri ? [item.uri] : [],
      image: item.uri,
    } as ProductLike;
    setActiveProduct(product);
    setActiveProductId(product.id || null);
    setProductModalOpen(true);
  }, [likedListingProductsByGridId, listingProductsByGridId]);

  const openPostItem = useCallback((item: GridItem) => {
    const preview = postPreviewByGridId[item.id] || likedPostPreviewByGridId[item.id] || {
      id: String(item.id || ''),
      user: {
        id: profileUser.id,
        username: profileUser.username,
        avatarUri: profileUser.avatarUri,
        bio: profileUser.bio,
      },
      modelUri: item.uri,
      caption: item.title || null,
      likes: 0,
      commentCount: 0,
      garments: [],
    };
    setActiveCommentsPost(preview);
  }, [
    likedPostPreviewByGridId,
    postPreviewByGridId,
    profileUser.avatarUri,
    profileUser.bio,
    profileUser.id,
    profileUser.username,
  ]);

  const handleCommentsCountChange = useCallback((count: number) => {
    setActiveCommentsPost((prev) => {
      if (!prev) return prev;
      if ((prev.commentCount ?? 0) === count) return prev;
      return { ...prev, commentCount: count };
    });
  }, []);

  const handleOpenUserFromComments = useCallback((selected: { id: string; username: string; avatarUri?: string | null; bio?: string }) => {
    if (!selected?.id) return;
    setActiveCommentsPost(null);
    nav.navigate({
      name: 'user',
      user: {
        id: selected.id,
        username: selected.username,
        avatarUri: selected.avatarUri || '',
        bio: selected.bio || undefined,
        source: 'real',
      },
    } as any);
  }, [nav]);

  return (
    <Animated.View
      {...panHandlers}
      style={[
        styles.root,
        { transform: [{ translateX }], opacity },
      ]}
    >
      {/* Solid background while viewing profile; fades as user swipes away */}
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg, opacity: bgOpacity }]} />
      <MinimalHeader
        title={`@${profileUser.username}`}
        leftIcon="chevron-back"
        onLeftPress={handleBack}
        leftA11yLabel="Back"
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        scrollEnabled={!isDraggingRef.current}
        contentContainerStyle={{ paddingBottom: bottomPad }}
      >
        {/* Profile Head */}
        <View style={{ paddingHorizontal: s(3), marginTop: s(3) }}>
          <ProfileHeader
            avatarUri={profileUser.avatarUri}
            name={profileUser.username}
            username={profileUser.username}
            displayName={profileUser.displayName || profileUser.username}
            bio={profileUser.bio || ' '}
            stats={{
              listings: combinedListings.length,
              sold: combinedSold.length,
              likes: combinedLikedListings.length + combinedLikedPosts.length,
            }}
            social={{ followers: profileUser.followers ?? 0, following: profileUser.following ?? 0 }}
            onPressFollowers={openFollowers}
            onPressFollowing={openFollowing}
            showEdit={false}
            showShare={false}
          />
        </View>

        {/* Follow action */}
        <View style={{ paddingHorizontal: s(3), marginTop: s(3), alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(2) }}>
            <Pressable
              onPress={handleToggleFollow}
              style={({ pressed }: { pressed: boolean }) => [
                styles.followBtn,
                isFollowing && styles.followingBtn,
                pressed && { transform: [{ scale: 0.98 }] },
              ]}
              accessibilityRole="button"
              accessibilityLabel={isFollowing ? 'Unfollow' : 'Follow'}
            >
              <Text style={[styles.followText, isFollowing && styles.followingText]}>
                {isFollowing ? 'Following' : 'Follow'}
              </Text>
            </Pressable>
            {!isOwner && (
              <Pressable
                onPress={openProfileModeration}
                disabled={moderationBusy}
                style={({ pressed }) => [
                  styles.profileOptionsBtn,
                  pressed && { transform: [{ scale: 0.97 }] },
                  moderationBusy && { opacity: 0.6 },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Profile actions"
              >
                <Ionicons name="ellipsis-horizontal" size={16} color={colors.text} />
              </Pressable>
            )}
          </View>
        </View>

        {/* Tabs */}
        <View style={{ paddingHorizontal: s(3), marginTop: s(4) }}>
          <SegmentedTabs
            tabs={mainTabs as any}
            activeKey={tab}
            onChange={(k) => setTab(k as PublicTab)}
            equalWidth
          />
        </View>

        {/* Content */}
        <View style={{ paddingHorizontal: s(3), marginTop: s(4) }}>
          {tab === 'listings' && (
            <>
              <Text style={styles.h2}>Active listings</Text>
              <ProfileGrid items={combinedListings} onPressItem={openListingItem} />
            </>
          )}
          {tab === 'posts' && (
            <>
              <Text style={styles.h2}>Posts</Text>
              <ProfileGrid items={combinedPosts} onPressItem={openPostItem} />
            </>
          )}
          {tab === 'likes' && (
            <>
              <View style={{ marginBottom: s(3) }}>
                <SegmentedChips
                  options={[
                    { key: 'liked_listings', label: 'Listings' },
                    { key: 'liked_posts', label: 'Posts' },
                  ] as any}
                  value={likesTab}
                  onChange={(k) => setLikesTab(k as LikesTab)}
                />
              </View>
              {likesTab === 'liked_listings' ? (
                <>
                  <Text style={styles.h2}>Liked listings</Text>
                  <ProfileGrid items={combinedLikedListings} onPressItem={openListingItem} />
                </>
              ) : (
                <>
                  <Text style={styles.h2}>Liked posts</Text>
                  <ProfileGrid items={combinedLikedPosts} onPressItem={openPostItem} />
                </>
              )}
            </>
          )}
          {tab === 'sold' && (
            <>
              <Text style={styles.h2}>Sold listings</Text>
              <ProfileGrid items={combinedSold} onPressItem={openListingItem} />
            </>
          )}
        </View>
      </ScrollView>

      <PostCommentsScreen
        visible={Boolean(activeCommentsPost)}
        post={activeCommentsPost}
        viewerUid={authUser?.uid || null}
        viewerUsername={authUser?.displayName || ''}
        viewerPhotoURL={authUser?.photoURL || ''}
        viewerLikedPost={activeCommentsPost ? viewerLikedPostIds.has(activeCommentsPost.id) : false}
        followingIds={isFollowing && user.id ? [user.id] : []}
        knownUsers={knownUsers}
        onOpenUser={handleOpenUserFromComments}
        onToggleFollowUser={(targetUid) => {
          if (targetUid !== user.id) return;
          void handleToggleFollow();
        }}
        onOpenProduct={(product) => {
          setActiveProduct(product);
          setActiveProductId(product.id || null);
          setProductModalOpen(true);
        }}
        onCountChange={handleCommentsCountChange}
        onClose={() => setActiveCommentsPost(null)}
      />

      <ProductModal
        visible={productModalOpen}
        onClose={() => setProductModalOpen(false)}
        product={activeProduct}
        initialLiked={isListingLiked(activeProductId, activeProduct?.listingId)}
        onLikeChange={(liked, product) => {
          if (product?.id) setListingLiked(product.id, liked, product.listingId);
        }}
      />

      <FollowListModal
        visible={!!followMode}
        mode={followMode || 'followers'}
        targetUid={profileUser.id}
        viewerUid={authUser?.uid}
        isOwner={isOwner}
        onClose={closeFollowModal}
        onSelectUser={handleSelectUser}
      />
    </Animated.View>
  );
}
