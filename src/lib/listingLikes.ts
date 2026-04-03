import { useCallback, useEffect, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import type { FirestoreError } from 'firebase/firestore';
import { db } from './firebase';
import { syncNotificationEvent } from './notifications';

const LISTING_PREFIX = 'listing:';
const REAL_LISTING_PREFIX = 'real-listing-';
const LIKED_LISTING_PREFIX = 'liked-listing:';

const isLikelyFirestoreDocId = (value: string) =>
  value.length >= 20 && /^[A-Za-z0-9_-]+$/.test(value);

const parseListingId = (id: string): string | null => {
  const raw = String(id || '').trim();
  if (!raw) return null;
  if (raw.startsWith(LISTING_PREFIX)) return raw.slice(LISTING_PREFIX.length);
  if (raw.startsWith(REAL_LISTING_PREFIX)) return raw.slice(REAL_LISTING_PREFIX.length);
  if (raw.startsWith(LIKED_LISTING_PREFIX)) return raw.slice(LIKED_LISTING_PREFIX.length);
  if (isLikelyFirestoreDocId(raw)) return raw;
  return null;
};

const canonicalizeListingLike = (id: string, listingIdHint?: string | null) => {
  const hint = String(listingIdHint || '').trim();
  const listingId = hint || parseListingId(id);
  if (!listingId) {
    return {
      likeDocId: String(id || '').trim(),
      listingId: null as string | null,
    };
  }
  return {
    likeDocId: `${LISTING_PREFIX}${listingId}`,
    listingId,
  };
};

const listingLikeDocCandidates = (listingId: string) => {
  const clean = String(listingId || '').trim();
  if (!clean) return [] as string[];
  const candidates = new Set<string>([
    `${LISTING_PREFIX}${clean}`,
    `${REAL_LISTING_PREFIX}${clean}`,
    `${LIKED_LISTING_PREFIX}${clean}`,
    clean,
  ]);
  return Array.from(candidates);
};

const isRetryableLikeFallbackError = (error: unknown) => {
  const code = (error as FirestoreError | undefined)?.code;
  return code === 'permission-denied' || code === 'failed-precondition' || code === 'not-found';
};

export function useListingLikes(uid?: string | null) {
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!uid) {
      setLikedIds(new Set());
      return;
    }
    setLikedIds(new Set());
    const likesRef = collection(db, 'users', uid, 'listingLikes');
    return onSnapshot(
      likesRef,
      (snap) => {
        const normalized = new Set<string>();
        snap.docs.forEach((d) => {
          const parsed = canonicalizeListingLike(d.id);
          normalized.add(parsed.likeDocId || d.id);
        });
        setLikedIds(normalized);
      },
      () => setLikedIds(new Set())
    );
  }, [uid]);

  const isLiked = useCallback((id?: string | null, listingIdHint?: string | null) => {
    if (!id) return false;
    const parsed = canonicalizeListingLike(id, listingIdHint);
    if (!parsed.likeDocId) return false;
    return likedIds.has(parsed.likeDocId);
  }, [likedIds]);

  const setLiked = useCallback((id: string, liked: boolean, listingIdHint?: string | null) => {
    if (!uid) return;
    const parsed = canonicalizeListingLike(id, listingIdHint);
    const likeDocId = parsed.likeDocId;
    if (!likeDocId) return;
    const listingId = parsed.listingId;

    setLikedIds((prev) => {
      const next = new Set(prev);
      if (liked) next.add(likeDocId);
      else next.delete(likeDocId);
      return next;
    });

    const userLikeRef = doc(db, 'users', uid, 'listingLikes', likeDocId);
    const legacyLikeRefs = listingId
      ? listingLikeDocCandidates(listingId)
          .filter((candidate) => candidate !== likeDocId)
          .map((candidate) => doc(db, 'users', uid, 'listingLikes', candidate))
      : [];
    const listingRef = listingId ? doc(db, 'listings', listingId) : null;
    const listingLikerRef = listingId ? doc(db, 'listings', listingId, 'likers', uid) : null;

    const persistWithoutCountUpdate = async () => {
      if (liked) {
        await Promise.all([
          setDoc(userLikeRef, { createdAt: serverTimestamp() }),
          ...(listingLikerRef ? [setDoc(listingLikerRef, { createdAt: serverTimestamp() })] : []),
          ...legacyLikeRefs.map((legacyRef) => deleteDoc(legacyRef)),
        ]);
        return;
      }
      await Promise.all([
        deleteDoc(userLikeRef),
        ...(listingLikerRef ? [deleteDoc(listingLikerRef)] : []),
        ...legacyLikeRefs.map((legacyRef) => deleteDoc(legacyRef)),
      ]);
    };

    const persist = async () => {
      if (listingRef && listingLikerRef) {
        try {
          await runTransaction(db, async (tx) => {
            const [listingSnap, likerSnap] = await Promise.all([
              tx.get(listingRef),
              tx.get(listingLikerRef),
            ]);
            if (!listingSnap.exists()) {
              throw new Error('listing-not-found');
            }

            const currentLikeCount = Number(listingSnap.data()?.likeCount ?? 0) || 0;
            if (liked) {
              tx.set(userLikeRef, { createdAt: serverTimestamp() });
              legacyLikeRefs.forEach((legacyRef) => tx.delete(legacyRef));
              if (!likerSnap.exists()) {
                tx.set(listingLikerRef, { createdAt: serverTimestamp() });
                tx.update(listingRef, { likeCount: Math.max(0, currentLikeCount + 1) });
              }
            } else {
              tx.delete(userLikeRef);
              legacyLikeRefs.forEach((legacyRef) => tx.delete(legacyRef));
              if (likerSnap.exists()) {
                tx.delete(listingLikerRef);
                tx.update(listingRef, { likeCount: Math.max(0, currentLikeCount - 1) });
              }
            }
          });
        } catch (error) {
          // If count update is blocked by rules or listing state changed, still persist like/unlike edges.
          if (!isRetryableLikeFallbackError(error) && (error as Error)?.message !== 'listing-not-found') {
            throw error;
          }
          await persistWithoutCountUpdate();
        }
        return;
      }
      await persistWithoutCountUpdate();
    };

    void persist()
      .then(() => {
        if (!listingId) return;
        return syncNotificationEvent({
          type: 'listing_like',
          enabled: liked,
          actorUid: uid,
          listingId,
        });
      })
      .catch((error) => {
        console.warn('[listingLikes] failed to persist like', {
          id,
          likeDocId,
          listingId,
          liked,
          error,
        });
        setLikedIds((prev) => {
          const next = new Set(prev);
          if (liked) next.delete(likeDocId);
          else next.add(likeDocId);
          return next;
        });
      });
  }, [uid]);

  const toggleLike = useCallback((id: string, listingIdHint?: string | null) => {
    const parsed = canonicalizeListingLike(id, listingIdHint);
    if (!parsed.likeDocId) return;
    setLiked(id, !likedIds.has(parsed.likeDocId), listingIdHint);
  }, [likedIds, setLiked]);

  return { likedIds, isLiked, setLiked, toggleLike };
}
