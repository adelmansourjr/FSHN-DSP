import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from './firebase';
import { syncNotificationEvent } from './notifications';

type PostCommentRecordInit = {
  id: string;
  authorUid: string;
  authorUsername?: string | null;
  authorPhotoURL?: string | null;
  text: string;
  createdAtMs: number;
  likeCount?: number;
  replyCount?: number;
};

type PostReplyRecordInit = {
  id: string;
  authorUid: string;
  authorUsername?: string | null;
  authorPhotoURL?: string | null;
  text: string;
  createdAtMs: number;
  likeCount?: number;
};

type CreatePostCommentInput = {
  postId: string;
  authorUid: string;
  text: string;
  authorUsername?: string | null;
  authorPhotoURL?: string | null;
};

type CreateCommentReplyInput = {
  postId: string;
  commentId: string;
  authorUid: string;
  text: string;
  authorUsername?: string | null;
  authorPhotoURL?: string | null;
};

type DeletePostCommentInput = {
  postId: string;
  commentId: string;
};

type DeleteCommentReplyInput = {
  postId: string;
  commentId: string;
  replyId: string;
};

export class PostCommentRecord {
  id: string;
  authorUid: string;
  authorUsername: string | null;
  authorPhotoURL: string | null;
  text: string;
  createdAtMs: number;
  likeCount: number;
  replyCount: number;

  constructor(init: PostCommentRecordInit) {
    this.id = init.id;
    this.authorUid = init.authorUid;
    this.authorUsername = init.authorUsername ?? null;
    this.authorPhotoURL = init.authorPhotoURL ?? null;
    this.text = init.text;
    this.createdAtMs = init.createdAtMs;
    this.likeCount = Number(init.likeCount ?? 0) || 0;
    this.replyCount = Number(init.replyCount ?? 0) || 0;
  }

  static fromSnapshot(docSnap: QueryDocumentSnapshot<DocumentData>) {
    const data = docSnap.data() as any;
    return new PostCommentRecord({
      id: docSnap.id,
      authorUid: data?.authorUid || '',
      authorUsername: data?.authorUsername || data?.username || null,
      authorPhotoURL: data?.authorPhotoURL || data?.photoURL || null,
      text: String(data?.text || ''),
      createdAtMs: CommentService.toMillis(data?.createdAt),
      likeCount: Number(data?.likeCount ?? 0) || 0,
      replyCount: Number(data?.replyCount ?? 0) || 0,
    });
  }
}

export class PostReplyRecord {
  id: string;
  authorUid: string;
  authorUsername: string | null;
  authorPhotoURL: string | null;
  text: string;
  createdAtMs: number;
  likeCount: number;

  constructor(init: PostReplyRecordInit) {
    this.id = init.id;
    this.authorUid = init.authorUid;
    this.authorUsername = init.authorUsername ?? null;
    this.authorPhotoURL = init.authorPhotoURL ?? null;
    this.text = init.text;
    this.createdAtMs = init.createdAtMs;
    this.likeCount = Number(init.likeCount ?? 0) || 0;
  }

  static fromSnapshot(docSnap: QueryDocumentSnapshot<DocumentData>) {
    const data = docSnap.data() as any;
    return new PostReplyRecord({
      id: docSnap.id,
      authorUid: data?.authorUid || '',
      authorUsername: data?.authorUsername || data?.username || null,
      authorPhotoURL: data?.authorPhotoURL || data?.photoURL || null,
      text: String(data?.text || ''),
      createdAtMs: CommentService.toMillis(data?.createdAt),
      likeCount: Number(data?.likeCount ?? 0) || 0,
    });
  }
}

export class CommentService {
  static toMillis(value: any) {
    if (!value) return Date.now();
    if (typeof value?.toMillis === 'function') return value.toMillis();
    if (typeof value === 'number') return value;
    if (typeof value?.seconds === 'number') return value.seconds * 1000;
    if (typeof value?._seconds === 'number') return value._seconds * 1000;
    return Date.now();
  }

  subscribePostComments(
    postId: string,
    onData: (comments: PostCommentRecord[]) => void,
    onError?: (error: any) => void
  ) {
    const ref = collection(db, 'posts', postId, 'comments');
    const commentsQuery = query(ref, orderBy('createdAt', 'asc'), limit(120));
    return onSnapshot(
      commentsQuery,
      (snap) => onData(snap.docs.map((docSnap) => PostCommentRecord.fromSnapshot(docSnap))),
      (error) => onError?.(error)
    );
  }

  subscribeCommentReplies(
    postId: string,
    commentId: string,
    onData: (replies: PostReplyRecord[]) => void,
    onError?: (error: any) => void
  ) {
    const ref = collection(db, 'posts', postId, 'comments', commentId, 'replies');
    const repliesQuery = query(ref, orderBy('createdAt', 'asc'), limit(120));
    return onSnapshot(
      repliesQuery,
      (snap) => onData(snap.docs.map((docSnap) => PostReplyRecord.fromSnapshot(docSnap))),
      (error) => onError?.(error)
    );
  }

  async createPostComment(input: CreatePostCommentInput) {
    const text = String(input.text || '').trim().slice(0, 800);
    if (!text) return;
    const created = await addDoc(collection(db, 'posts', input.postId, 'comments'), {
      authorUid: input.authorUid,
      authorUsername: input.authorUsername || '',
      authorPhotoURL: input.authorPhotoURL || '',
      createdAt: serverTimestamp(),
      text,
      state: 'ok',
      removedAt: null,
      removedReason: null,
      likeCount: 0,
      replyCount: 0,
    });
    void syncNotificationEvent({
      type: 'post_comment',
      enabled: true,
      actorUid: input.authorUid,
      postId: input.postId,
      commentText: text,
      commentEventId: created.id,
    });
  }

  async createCommentReply(input: CreateCommentReplyInput) {
    const text = String(input.text || '').trim().slice(0, 800);
    if (!text) return;
    const created = await addDoc(collection(db, 'posts', input.postId, 'comments', input.commentId, 'replies'), {
      authorUid: input.authorUid,
      authorUsername: input.authorUsername || '',
      authorPhotoURL: input.authorPhotoURL || '',
      createdAt: serverTimestamp(),
      text,
      state: 'ok',
      removedAt: null,
      removedReason: null,
      likeCount: 0,
    });
    void syncNotificationEvent({
      type: 'post_comment',
      enabled: true,
      actorUid: input.authorUid,
      postId: input.postId,
      commentText: text,
      commentEventId: created.id,
      parentCommentId: input.commentId,
    });
  }

  async deletePostComment(input: DeletePostCommentInput) {
    await deleteDoc(doc(db, 'posts', input.postId, 'comments', input.commentId));
  }

  async deleteCommentReply(input: DeleteCommentReplyInput) {
    await deleteDoc(doc(db, 'posts', input.postId, 'comments', input.commentId, 'replies', input.replyId));
  }
}

export const commentService = new CommentService();

export function subscribePostComments(
  postId: string,
  onData: (comments: PostCommentRecord[]) => void,
  onError?: (error: any) => void
) {
  return commentService.subscribePostComments(postId, onData, onError);
}

export function subscribeCommentReplies(
  postId: string,
  commentId: string,
  onData: (replies: PostReplyRecord[]) => void,
  onError?: (error: any) => void
) {
  return commentService.subscribeCommentReplies(postId, commentId, onData, onError);
}

export async function createPostComment(input: CreatePostCommentInput) {
  return commentService.createPostComment(input);
}

export async function createCommentReply(input: CreateCommentReplyInput) {
  return commentService.createCommentReply(input);
}

export async function deletePostComment(input: DeletePostCommentInput) {
  return commentService.deletePostComment(input);
}

export async function deleteCommentReply(input: DeleteCommentReplyInput) {
  return commentService.deleteCommentReply(input);
}
