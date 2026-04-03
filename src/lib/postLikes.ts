import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  deleteDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import { syncNotificationEvent } from './notifications';

export function subscribePostLikes(uid: string, cb: (ids: string[]) => void) {
  const ref = collection(db, 'users', uid, 'postLikes');
  return onSnapshot(
    ref,
    (snap) => {
      cb(snap.docs.map((d) => d.id));
    },
    () => cb([])
  );
}

export async function setPostLike(uid: string, postId: string, liked: boolean) {
  const userLikeRef = doc(db, 'users', uid, 'postLikes', postId);
  const postLikeRef = doc(db, 'posts', postId, 'likers', uid);
  if (liked) {
    await Promise.all([
      setDoc(userLikeRef, { createdAt: serverTimestamp() }),
      setDoc(postLikeRef, { createdAt: serverTimestamp() }),
    ]);
  } else {
    await Promise.all([
      deleteDoc(userLikeRef),
      deleteDoc(postLikeRef),
    ]);
  }
  await syncNotificationEvent({
    type: 'post_like',
    enabled: liked,
    actorUid: uid,
    postId,
  });
}
