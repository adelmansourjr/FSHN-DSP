import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { db } from './firebase';

const KEY_SEP = '__';

type SetCommentLikeInput = {
  uid: string;
  postId: string;
  commentId: string;
  liked: boolean;
};

type SetReplyLikeInput = {
  uid: string;
  postId: string;
  commentId: string;
  replyId: string;
  liked: boolean;
};

export class CommentLikeService {
  makeCommentLikeKey(postId: string, commentId: string) {
    return `${postId}${KEY_SEP}${commentId}`;
  }

  makeReplyLikeKey(postId: string, commentId: string, replyId: string) {
    return `${postId}${KEY_SEP}${commentId}${KEY_SEP}${replyId}`;
  }

  subscribeUserCommentLikeKeys(uid: string, cb: (keys: Set<string>) => void) {
    const ref = collection(db, 'users', uid, 'commentLikes');
    return onSnapshot(
      ref,
      (snap) => cb(new Set(snap.docs.map((d) => d.id))),
      () => cb(new Set())
    );
  }

  subscribeUserReplyLikeKeys(uid: string, cb: (keys: Set<string>) => void) {
    const ref = collection(db, 'users', uid, 'replyLikes');
    return onSnapshot(
      ref,
      (snap) => cb(new Set(snap.docs.map((d) => d.id))),
      () => cb(new Set())
    );
  }

  async setCommentLike(params: SetCommentLikeInput) {
    const { uid, postId, commentId, liked } = params;
    const key = this.makeCommentLikeKey(postId, commentId);
    const userLikeRef = doc(db, 'users', uid, 'commentLikes', key);
    const likerRef = doc(db, 'posts', postId, 'comments', commentId, 'likers', uid);

    if (liked) {
      await Promise.all([
        setDoc(userLikeRef, { postId, commentId, createdAt: serverTimestamp() }),
        setDoc(likerRef, { createdAt: serverTimestamp() }),
      ]);
      return;
    }

    await Promise.all([deleteDoc(userLikeRef), deleteDoc(likerRef)]);
  }

  async setReplyLike(params: SetReplyLikeInput) {
    const { uid, postId, commentId, replyId, liked } = params;
    const key = this.makeReplyLikeKey(postId, commentId, replyId);
    const userLikeRef = doc(db, 'users', uid, 'replyLikes', key);
    const likerRef = doc(db, 'posts', postId, 'comments', commentId, 'replies', replyId, 'likers', uid);

    if (liked) {
      await Promise.all([
        setDoc(userLikeRef, { postId, commentId, replyId, createdAt: serverTimestamp() }),
        setDoc(likerRef, { createdAt: serverTimestamp() }),
      ]);
      return;
    }

    await Promise.all([deleteDoc(userLikeRef), deleteDoc(likerRef)]);
  }
}

export const commentLikeService = new CommentLikeService();

export function makeCommentLikeKey(postId: string, commentId: string) {
  return commentLikeService.makeCommentLikeKey(postId, commentId);
}

export function makeReplyLikeKey(postId: string, commentId: string, replyId: string) {
  return commentLikeService.makeReplyLikeKey(postId, commentId, replyId);
}

export function subscribeUserCommentLikeKeys(uid: string, cb: (keys: Set<string>) => void) {
  return commentLikeService.subscribeUserCommentLikeKeys(uid, cb);
}

export function subscribeUserReplyLikeKeys(uid: string, cb: (keys: Set<string>) => void) {
  return commentLikeService.subscribeUserReplyLikeKeys(uid, cb);
}

export async function setCommentLike(params: SetCommentLikeInput) {
  return commentLikeService.setCommentLike(params);
}

export async function setReplyLike(params: SetReplyLikeInput) {
  return commentLikeService.setReplyLike(params);
}
