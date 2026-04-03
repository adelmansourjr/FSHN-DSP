import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  writeBatch,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { resolveBackendUrl } from './payments/stripe';

export type AppNotificationType =
  | 'sale'
  | 'listing_like'
  | 'post_like'
  | 'comment_like'
  | 'reply_like'
  | 'post_comment'
  | 'follow';

export type AppNotification = {
  id: string;
  type: AppNotificationType;
  read: boolean;
  title: string;
  body: string;
  imageUri: string | null;
  actorUid: string | null;
  actorUsername: string | null;
  actorDisplayName: string | null;
  actorPhotoURL: string | null;
  targetId: string | null;
  targetType: string | null;
  listingId: string | null;
  orderId: string | null;
  postId: string | null;
  commentId: string | null;
  createdAtMs: number;
};

const BACKFILL_MIN_INTERVAL_MS = 30_000;
const lastBackfillAtByUid = new Map<string, number>();

const toTimestampMs = (value: any) => {
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date.getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
};

const mapNotificationDoc = (docSnap: QueryDocumentSnapshot<DocumentData>): AppNotification => {
  const data = docSnap.data() || {};
  return {
    id: docSnap.id,
    type: String(data?.type || 'follow').trim() as AppNotificationType,
    read: Boolean(data?.read),
    title: String(data?.title || '').trim() || 'Notification',
    body: String(data?.body || '').trim() || '',
    imageUri: typeof data?.imageUri === 'string' ? data.imageUri : null,
    actorUid: typeof data?.actorUid === 'string' ? data.actorUid : null,
    actorUsername: typeof data?.actorUsername === 'string' ? data.actorUsername : null,
    actorDisplayName: typeof data?.actorDisplayName === 'string' ? data.actorDisplayName : null,
    actorPhotoURL: typeof data?.actorPhotoURL === 'string' ? data.actorPhotoURL : null,
    targetId: typeof data?.targetId === 'string' ? data.targetId : null,
    targetType: typeof data?.targetType === 'string' ? data.targetType : null,
    listingId: typeof data?.listingId === 'string' ? data.listingId : null,
    orderId: typeof data?.orderId === 'string' ? data.orderId : null,
    postId: typeof data?.postId === 'string' ? data.postId : null,
    commentId: typeof data?.commentId === 'string' ? data.commentId : null,
    createdAtMs: toTimestampMs(data?.createdAt),
  };
};

const cleanString = (value: unknown) => String(value || '').trim();

const makeSyntheticNotificationId = (...parts: Array<string | null | undefined>) =>
  parts
    .map((part) => cleanString(part))
    .filter(Boolean)
    .join('__')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 180);

const extractListingImage = (data: any) =>
  cleanString(data?.primeImage?.url) ||
  cleanString(data?.coverImage?.url) ||
  cleanString(data?.image?.url) ||
  cleanString(data?.listingImageUrl) ||
  cleanString(data?.imageUrl) ||
  cleanString(data?.thumbnailUrl) ||
  cleanString(data?.photos?.[0]?.url) ||
  cleanString(data?.images?.[0]?.url) ||
  cleanString(data?.items?.[0]?.image) ||
  cleanString(data?.items?.[0]?.imageUrl) ||
  null;

const extractPostImage = (data: any) => {
  const first = Array.isArray(data?.images) ? data.images[0] : null;
  return (
    cleanString(typeof first === 'string' ? first : first?.url) ||
    cleanString(data?.image?.url) ||
    cleanString(data?.imageUrl) ||
    cleanString(data?.thumbnailUrl) ||
    null
  );
};

const formatCommentSnippet = (text: unknown, maxLen = 72) => {
  const clean = cleanString(String(text || '').replace(/\s+/g, ' '));
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen).trimEnd()}...`;
};

type ActorSnapshot = {
  actorUid: string | null;
  actorUsername: string | null;
  actorDisplayName: string | null;
  actorPhotoURL: string | null;
};

const emptyActor = (uid?: string | null): ActorSnapshot => ({
  actorUid: cleanString(uid) || null,
  actorUsername: null,
  actorDisplayName: null,
  actorPhotoURL: null,
});

const loadActorSnapshots = async (uids: string[]) => {
  const unique = Array.from(new Set(uids.map(cleanString).filter(Boolean)));
  const entries = await Promise.all(
    unique.map(async (uid) => {
      try {
        const snap = await getDoc(doc(db, 'users', uid));
        const data = snap.exists() ? snap.data() : null;
        return [
          uid,
          {
            actorUid: uid,
            actorUsername: cleanString(data?.username) || null,
            actorDisplayName: cleanString(data?.displayName || data?.username) || null,
            actorPhotoURL: cleanString(data?.photoURL || data?.avatarUri || data?.avatarURL) || null,
          } satisfies ActorSnapshot,
        ] as const;
      } catch {
        return [uid, emptyActor(uid)] as const;
      }
    })
  );
  return Object.fromEntries(entries) as Record<string, ActorSnapshot>;
};

const parseCommentRefPath = (path: string) => {
  const parts = String(path || '').split('/').filter(Boolean);
  const postsIndex = parts.indexOf('posts');
  const commentsIndex = parts.indexOf('comments');
  if (postsIndex < 0 || commentsIndex < 0) return null;
  const postId = cleanString(parts[postsIndex + 1]);
  const commentId = cleanString(parts[commentsIndex + 1]);
  if (!postId || !commentId) return null;
  return { postId, commentId };
};

const parseReplyRefPath = (path: string) => {
  const parts = String(path || '').split('/').filter(Boolean);
  const postsIndex = parts.indexOf('posts');
  const commentsIndex = parts.indexOf('comments');
  const repliesIndex = parts.indexOf('replies');
  if (postsIndex < 0 || commentsIndex < 0 || repliesIndex < 0) return null;
  const postId = cleanString(parts[postsIndex + 1]);
  const commentId = cleanString(parts[commentsIndex + 1]);
  const replyId = cleanString(parts[repliesIndex + 1]);
  if (!postId || !commentId || !replyId) return null;
  return { postId, commentId, replyId };
};

const loadPostSnapshots = async (postIds: string[]) => {
  const unique = Array.from(new Set(postIds.map(cleanString).filter(Boolean)));
  const entries = await Promise.all(
    unique.map(async (postId) => {
      try {
        const snap = await getDoc(doc(db, 'posts', postId));
        return [postId, snap.exists() ? snap.data() || {} : {}] as const;
      } catch {
        return [postId, {}] as const;
      }
    })
  );
  return Object.fromEntries(entries) as Record<string, any>;
};

export async function loadDerivedNotifications(uid: string) {
  const cleanUid = cleanString(uid);
  if (!cleanUid) return [] as AppNotification[];

  const out: AppNotification[] = [];
  const actorUids = new Set<string>();

  const [followersSnap, ordersSnap, listingsSnap, postsSnap, ownedCommentsSnap, ownedRepliesSnap] = await Promise.all([
    getDocs(query(collection(db, 'users', cleanUid, 'followers'), limit(60))),
    getDocs(query(collection(db, 'orders'), where('sellerUid', '==', cleanUid), limit(60))),
    getDocs(query(collection(db, 'listings'), where('sellerUid', '==', cleanUid), limit(40))),
    getDocs(query(collection(db, 'posts'), where('authorUid', '==', cleanUid), limit(40))),
    getDocs(query(collectionGroup(db, 'comments'), where('authorUid', '==', cleanUid), limit(60))),
    getDocs(query(collectionGroup(db, 'replies'), where('authorUid', '==', cleanUid), limit(60))),
  ]);

  followersSnap.docs.forEach((followerDoc) => {
    const actorUid = cleanString(followerDoc.id);
    if (!actorUid || actorUid === cleanUid) return;
    actorUids.add(actorUid);
    out.push({
      id: makeSyntheticNotificationId('follow', actorUid),
      type: 'follow',
      read: true,
      title: '',
      body: 'started following you.',
      imageUri: null,
      actorUid,
      actorUsername: null,
      actorDisplayName: null,
      actorPhotoURL: null,
      targetId: cleanUid,
      targetType: 'user',
      listingId: null,
      orderId: null,
      postId: null,
      commentId: null,
      createdAtMs: toTimestampMs(followerDoc.data()?.createdAt),
    });
  });

  ordersSnap.docs.forEach((orderDoc) => {
    const data = orderDoc.data() || {};
    const actorUid = cleanString(data?.buyerUid);
    const status = cleanString(data?.status).toLowerCase();
    if (!actorUid || actorUid === cleanUid || status.startsWith('cancelled')) return;
    actorUids.add(actorUid);
    const listingTitle = cleanString(data?.listing?.title || data?.items?.[0]?.title || 'Listing');
    out.push({
      id: makeSyntheticNotificationId('sale', orderDoc.id),
      type: 'sale',
      read: true,
      title: '',
      body: `bought your item: ${listingTitle || 'Listing'}`,
      imageUri: extractListingImage(data?.listing || data),
      actorUid,
      actorUsername: null,
      actorDisplayName: null,
      actorPhotoURL: null,
      targetId: orderDoc.id,
      targetType: 'order',
      listingId: cleanString(data?.listingId || data?.listing?.id || data?.items?.[0]?.listingId) || null,
      orderId: orderDoc.id,
      postId: null,
      commentId: null,
      createdAtMs: toTimestampMs(data?.paidAt || data?.createdAt),
    });
  });

  for (const listingDoc of listingsSnap.docs) {
    const listing = listingDoc.data() || {};
    const listingTitle = cleanString(listing?.title || listing?.name || 'your listing');
    try {
      const likersSnap = await getDocs(query(collection(db, 'listings', listingDoc.id, 'likers'), limit(60)));
      likersSnap.docs.forEach((likerDoc) => {
        const actorUid = cleanString(likerDoc.id);
        if (!actorUid || actorUid === cleanUid) return;
        actorUids.add(actorUid);
        out.push({
          id: makeSyntheticNotificationId('listing_like', listingDoc.id, actorUid),
          type: 'listing_like',
          read: true,
          title: '',
          body: `liked your listing${listingTitle ? `: ${listingTitle}` : '.'}`,
          imageUri: extractListingImage(listing),
          actorUid,
          actorUsername: null,
          actorDisplayName: null,
          actorPhotoURL: null,
          targetId: listingDoc.id,
          targetType: 'listing',
          listingId: listingDoc.id,
          orderId: null,
          postId: null,
          commentId: null,
          createdAtMs: toTimestampMs(likerDoc.data()?.createdAt),
        });
      });
    } catch (error) {
      console.warn('[notifications] listing liker fallback skipped', { listingId: listingDoc.id, error });
    }
  }

  for (const postDoc of postsSnap.docs) {
    const post = postDoc.data() || {};
    const caption = cleanString(post?.caption);
    const postImage = extractPostImage(post);

    try {
      const likersSnap = await getDocs(query(collection(db, 'posts', postDoc.id, 'likers'), limit(60)));
      likersSnap.docs.forEach((likerDoc) => {
        const actorUid = cleanString(likerDoc.id);
        if (!actorUid || actorUid === cleanUid) return;
        actorUids.add(actorUid);
        out.push({
          id: makeSyntheticNotificationId('post_like', postDoc.id, actorUid),
          type: 'post_like',
          read: true,
          title: '',
          body: caption ? `liked your post: ${caption}` : 'liked your post.',
          imageUri: postImage,
          actorUid,
          actorUsername: null,
          actorDisplayName: null,
          actorPhotoURL: null,
          targetId: postDoc.id,
          targetType: 'post',
          listingId: null,
          orderId: null,
          postId: postDoc.id,
          commentId: null,
          createdAtMs: toTimestampMs(likerDoc.data()?.createdAt),
        });
      });
    } catch (error) {
      console.warn('[notifications] post liker fallback skipped', { postId: postDoc.id, error });
    }

    try {
      const commentsSnap = await getDocs(query(collection(db, 'posts', postDoc.id, 'comments'), limit(60)));
      for (const commentDoc of commentsSnap.docs) {
        const comment = commentDoc.data() || {};
        const actorUid = cleanString(comment?.authorUid);
        if (actorUid && actorUid !== cleanUid) {
          actorUids.add(actorUid);
          const snippet = formatCommentSnippet(comment?.text);
          out.push({
            id: makeSyntheticNotificationId('post_comment', postDoc.id, commentDoc.id),
            type: 'post_comment',
            read: true,
            title: '',
            body: snippet ? `commented on your post: ${snippet}` : 'commented on your post.',
            imageUri: postImage,
            actorUid,
            actorUsername: null,
            actorDisplayName: null,
            actorPhotoURL: null,
            targetId: postDoc.id,
            targetType: 'post',
            listingId: null,
            orderId: null,
            postId: postDoc.id,
            commentId: commentDoc.id,
            createdAtMs: toTimestampMs(comment?.createdAt),
          });
        }

        const commentAuthorUid = cleanString(comment?.authorUid);
        if (commentAuthorUid === cleanUid) {
          try {
            const repliesSnap = await getDocs(
              query(collection(db, 'posts', postDoc.id, 'comments', commentDoc.id, 'replies'), limit(60))
            );
            repliesSnap.docs.forEach((replyDoc) => {
              const reply = replyDoc.data() || {};
              const replyActorUid = cleanString(reply?.authorUid);
              if (!replyActorUid || replyActorUid === cleanUid) return;
              actorUids.add(replyActorUid);
              const snippet = formatCommentSnippet(reply?.text);
              out.push({
                id: makeSyntheticNotificationId('post_comment', postDoc.id, `reply_${replyDoc.id}`),
                type: 'post_comment',
                read: true,
                title: '',
                body: snippet ? `replied to your comment: ${snippet}` : 'replied to your comment.',
                imageUri: postImage,
                actorUid: replyActorUid,
                actorUsername: null,
                actorDisplayName: null,
                actorPhotoURL: null,
                targetId: postDoc.id,
                targetType: 'post',
                listingId: null,
                orderId: null,
                postId: postDoc.id,
                commentId: replyDoc.id,
                createdAtMs: toTimestampMs(reply?.createdAt),
              });
            });
          } catch (error) {
            console.warn('[notifications] reply fallback skipped', { postId: postDoc.id, commentId: commentDoc.id, error });
          }
        }
      }
    } catch (error) {
      console.warn('[notifications] comment fallback skipped', { postId: postDoc.id, error });
    }
  }

  const commentTargets = ownedCommentsSnap.docs
    .map((commentDoc) => ({
      ref: parseCommentRefPath(commentDoc.ref.path),
      data: commentDoc.data() || {},
    }))
    .filter((item): item is { ref: { postId: string; commentId: string }; data: any } => Boolean(item.ref));

  const replyTargets = ownedRepliesSnap.docs
    .map((replyDoc) => ({
      ref: parseReplyRefPath(replyDoc.ref.path),
      data: replyDoc.data() || {},
    }))
    .filter((item): item is { ref: { postId: string; commentId: string; replyId: string }; data: any } => Boolean(item.ref));

  const fallbackPostSnapshots = await loadPostSnapshots([
    ...commentTargets.map((item) => item.ref.postId),
    ...replyTargets.map((item) => item.ref.postId),
  ]);

  for (const target of commentTargets) {
    const { postId, commentId } = target.ref;
    const post = fallbackPostSnapshots[postId] || {};
    const postImage = extractPostImage(post);
    const snippet = formatCommentSnippet(target.data?.text);

    try {
      const commentLikersSnap = await getDocs(
        query(collection(db, 'posts', postId, 'comments', commentId, 'likers'), limit(60))
      );
      commentLikersSnap.docs.forEach((likerDoc) => {
        const actorUid = cleanString(likerDoc.id);
        if (!actorUid || actorUid === cleanUid) return;
        actorUids.add(actorUid);
        out.push({
          id: makeSyntheticNotificationId('comment_like', postId, commentId, actorUid),
          type: 'comment_like',
          read: true,
          title: '',
          body: snippet ? `liked your comment: ${snippet}` : 'liked your comment.',
          imageUri: postImage,
          actorUid,
          actorUsername: null,
          actorDisplayName: null,
          actorPhotoURL: null,
          targetId: commentId,
          targetType: 'comment',
          listingId: null,
          orderId: null,
          postId,
          commentId,
          createdAtMs: toTimestampMs(likerDoc.data()?.createdAt),
        });
      });
    } catch (error) {
      console.warn('[notifications] comment like fallback skipped', { postId, commentId, error });
    }

    try {
      const repliesSnap = await getDocs(
        query(collection(db, 'posts', postId, 'comments', commentId, 'replies'), limit(60))
      );
      repliesSnap.docs.forEach((replyDoc) => {
        const reply = replyDoc.data() || {};
        const actorUid = cleanString(reply?.authorUid);
        if (!actorUid || actorUid === cleanUid) return;
        actorUids.add(actorUid);
        const replySnippet = formatCommentSnippet(reply?.text);
        out.push({
          id: makeSyntheticNotificationId('post_comment', postId, `reply_${replyDoc.id}`),
          type: 'post_comment',
          read: true,
          title: '',
          body: replySnippet ? `replied to your comment: ${replySnippet}` : 'replied to your comment.',
          imageUri: postImage,
          actorUid,
          actorUsername: null,
          actorDisplayName: null,
          actorPhotoURL: null,
          targetId: postId,
          targetType: 'post',
          listingId: null,
          orderId: null,
          postId,
          commentId: replyDoc.id,
          createdAtMs: toTimestampMs(reply?.createdAt),
        });
      });
    } catch (error) {
      console.warn('[notifications] comment reply fallback skipped', { postId, commentId, error });
    }
  }

  for (const target of replyTargets) {
    const { postId, commentId, replyId } = target.ref;
    const post = fallbackPostSnapshots[postId] || {};
    const postImage = extractPostImage(post);
    const snippet = formatCommentSnippet(target.data?.text);
    try {
      const replyLikersSnap = await getDocs(
        query(collection(db, 'posts', postId, 'comments', commentId, 'replies', replyId, 'likers'), limit(60))
      );
      replyLikersSnap.docs.forEach((likerDoc) => {
        const actorUid = cleanString(likerDoc.id);
        if (!actorUid || actorUid === cleanUid) return;
        actorUids.add(actorUid);
        out.push({
          id: makeSyntheticNotificationId('reply_like', postId, commentId, replyId, actorUid),
          type: 'reply_like',
          read: true,
          title: '',
          body: snippet ? `liked your reply: ${snippet}` : 'liked your reply.',
          imageUri: postImage,
          actorUid,
          actorUsername: null,
          actorDisplayName: null,
          actorPhotoURL: null,
          targetId: replyId,
          targetType: 'reply',
          listingId: null,
          orderId: null,
          postId,
          commentId: replyId,
          createdAtMs: toTimestampMs(likerDoc.data()?.createdAt),
        });
      });
    } catch (error) {
      console.warn('[notifications] reply like fallback skipped', { postId, commentId, replyId, error });
    }
  }

  const actors = await loadActorSnapshots(Array.from(actorUids));
  const merged = out
    .map((item) => {
      const actor = item.actorUid ? actors[item.actorUid] || emptyActor(item.actorUid) : emptyActor();
      return {
        ...item,
        title: actor.actorDisplayName || actor.actorUsername || 'Someone',
        actorUsername: actor.actorUsername,
        actorDisplayName: actor.actorDisplayName,
        actorPhotoURL: actor.actorPhotoURL,
      };
    })
    .sort((a, b) => b.createdAtMs - a.createdAtMs);

  return merged.slice(0, 80);
}

export function subscribeNotifications(uid: string, cb: (items: AppNotification[]) => void): Unsubscribe {
  const cleanUid = String(uid || '').trim();
  if (!cleanUid) {
    cb([]);
    return () => {};
  }

  const ref = query(
    collection(db, 'users', cleanUid, 'notifications'),
    orderBy('createdAt', 'desc'),
    limit(60)
  );

  return onSnapshot(
    ref,
    (snap) => cb(snap.docs.map(mapNotificationDoc)),
    (error) => {
      console.warn('[notifications] subscribe failed', error);
      cb([]);
    }
  );
}

export function subscribeUnreadNotificationCount(uid: string, cb: (count: number) => void): Unsubscribe {
  const cleanUid = String(uid || '').trim();
  if (!cleanUid) {
    cb(0);
    return () => {};
  }

  const ref = collection(db, 'users', cleanUid, 'notifications');
  return onSnapshot(
    ref,
    (snap) => {
      let unread = 0;
      snap.docs.forEach((docSnap) => {
        if (!docSnap.data()?.read) unread += 1;
      });
      cb(unread);
    },
    (error) => {
      console.warn('[notifications] unread count subscribe failed', error);
      cb(0);
    }
  );
}

export async function markNotificationsRead(uid: string, ids: string[]) {
  const cleanUid = String(uid || '').trim();
  const cleanIds = Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
  if (!cleanUid || !cleanIds.length) return;

  const batch = writeBatch(db);
  cleanIds.forEach((id) => {
    batch.update(doc(db, 'users', cleanUid, 'notifications', id), {
      read: true,
    });
  });
  await batch.commit();
}

export async function syncNotificationEvent(input: {
  type: 'follow' | 'listing_like' | 'post_like' | 'post_comment';
  enabled: boolean;
  actorUid?: string | null;
  targetUid?: string | null;
  listingId?: string | null;
  postId?: string | null;
  commentText?: string | null;
  commentEventId?: string | null;
  parentCommentId?: string | null;
}) {
  const backendUrl = resolveBackendUrl();
  if (!backendUrl) {
    console.warn('[notifications] backend URL missing; notification event skipped', input);
    return false;
  }

  const currentUser = auth.currentUser;
  const idToken = currentUser ? await currentUser.getIdToken().catch(() => '') : '';

  try {
    const res = await fetch(`${backendUrl}/notifications/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify({
        type: input.type,
        enabled: input.enabled,
        targetUid: String(input.targetUid || '').trim(),
        listingId: String(input.listingId || '').trim(),
        postId: String(input.postId || '').trim(),
        commentText: String(input.commentText || '').trim(),
        commentEventId: String(input.commentEventId || '').trim(),
        parentCommentId: String(input.parentCommentId || '').trim(),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[notifications] event sync failed', {
        status: res.status,
        body: text,
        input,
      });
      return false;
    }
    return true;
  } catch {
    // Notification sync is best-effort; do not block the core action.
    console.warn('[notifications] event sync request failed', input);
    return false;
  }
}

export async function backfillNotifications(input: {
  actorUid?: string | null;
  force?: boolean;
} = {}) {
  const currentUser = auth.currentUser;
  const actorUid = String(input.actorUid || currentUser?.uid || '').trim();
  if (!actorUid) return false;

  const lastBackfillAt = lastBackfillAtByUid.get(actorUid) || 0;
  if (!input.force && Date.now() - lastBackfillAt < BACKFILL_MIN_INTERVAL_MS) {
    return true;
  }

  const backendUrl = resolveBackendUrl();
  if (!backendUrl) {
    console.warn('[notifications] backend URL missing; notification backfill skipped', { actorUid });
    return false;
  }

  const idToken = currentUser ? await currentUser.getIdToken().catch(() => '') : '';

  try {
    const res = await fetch(`${backendUrl}/notifications/backfill`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[notifications] backfill failed', {
        status: res.status,
        body: text,
        actorUid,
      });
      return false;
    }
    lastBackfillAtByUid.set(actorUid, Date.now());
    return true;
  } catch (error) {
    console.warn('[notifications] backfill request failed', { actorUid, error });
    return false;
  }
}
