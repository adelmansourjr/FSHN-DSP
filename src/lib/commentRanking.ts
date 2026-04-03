import AsyncStorage from '@react-native-async-storage/async-storage';
import { makeCommentLikeKey, makeReplyLikeKey } from './commentLikes';
import type { PostCommentRecord, PostReplyRecord } from './postComments';

const CACHE_PREFIX = 'comments.rank.cache.v1';
const MAX_COMMENT_CACHE = 900;
const MAX_REPLY_CACHE = 1800;
const MAX_AUTHOR_CACHE = 700;
const IMPRESSION_COOLDOWN_MS = 90 * 1000;

type NumericMap<T> = Record<string, T>;

type RankRecordInit = {
  impressions?: number;
  likesGiven?: number;
  lastShownAt?: number;
  lastInteractedAt?: number;
};

export class CommentRankRecord {
  impressions: number;
  likesGiven: number;
  lastShownAt: number;
  lastInteractedAt: number;

  constructor(init: RankRecordInit = {}) {
    this.impressions = Number(init.impressions ?? 0) || 0;
    this.likesGiven = Number(init.likesGiven ?? 0) || 0;
    this.lastShownAt = Number(init.lastShownAt ?? 0) || 0;
    this.lastInteractedAt = Number(init.lastInteractedAt ?? 0) || 0;
  }

  static fromRaw(raw: any) {
    return new CommentRankRecord(raw);
  }
}

export class CommentRankAuthorRecord extends CommentRankRecord {}

export class CommentRankCache {
  version: 1;
  updatedAt: number;
  comments: NumericMap<CommentRankRecord>;
  replies: NumericMap<CommentRankRecord>;
  authors: NumericMap<CommentRankAuthorRecord>;

  constructor(init?: Partial<CommentRankCache>) {
    this.version = 1;
    this.updatedAt = Number(init?.updatedAt ?? 0) || 0;
    this.comments = init?.comments || {};
    this.replies = init?.replies || {};
    this.authors = init?.authors || {};
  }

  static empty() {
    return new CommentRankCache({
      updatedAt: 0,
      comments: {},
      replies: {},
      authors: {},
    });
  }
}

type CommentRankableBase = Pick<PostCommentRecord, 'id' | 'authorUid' | 'createdAtMs' | 'likeCount' | 'replyCount'>;
type ReplyRankableBase = Pick<PostReplyRecord, 'id' | 'authorUid' | 'createdAtMs' | 'likeCount'>;

type RankInputComment<T extends CommentRankableBase> = {
  postId: string;
  comments: T[];
  followingIds: Set<string>;
  likedCommentKeys: Set<string>;
  cache: CommentRankCache;
  nowMs?: number;
};

type RankInputReply<T extends ReplyRankableBase> = {
  postId: string;
  commentId: string;
  replies: T[];
  followingIds: Set<string>;
  likedReplyKeys: Set<string>;
  cache: CommentRankCache;
  nowMs?: number;
};

type ImpressionEntry = {
  kind: 'comment' | 'reply';
  key: string;
  authorId: string;
};

type LikeEntry = {
  kind: 'comment' | 'reply';
  key: string;
  authorId: string;
  liked: boolean;
  nowMs?: number;
};

export class CommentRankingService {
  private clamp01(n: number) {
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  private hash01(input: string) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 10000) / 10000;
  }

  private getCacheKey(uid?: string | null) {
    return `${CACHE_PREFIX}:${uid || 'anon'}`;
  }

  private ageHours(createdAtMs: number | null | undefined, nowMs: number) {
    if (!createdAtMs || !Number.isFinite(createdAtMs)) return 72;
    return Math.max(0, (nowMs - createdAtMs) / 3600000);
  }

  private recencyScore(hours: number, halfLifeHours: number) {
    return Math.exp((-Math.log(2) * hours) / halfLifeHours);
  }

  private interactionScore(likes: number, secondary: number) {
    return this.clamp01(Math.log1p(Math.max(0, likes) + Math.max(0, secondary) * 1.8) / 8);
  }

  private authorAffinityScore(authorRec?: CommentRankAuthorRecord) {
    if (!authorRec) return 0;
    return this.clamp01(authorRec.likesGiven * 0.3 + authorRec.impressions * 0.012);
  }

  private itemAffinityScore(itemRec?: CommentRankRecord) {
    if (!itemRec) return 0;
    return this.clamp01(itemRec.likesGiven * 0.45);
  }

  private noveltyBoost(itemRec?: CommentRankRecord) {
    if (!itemRec || itemRec.impressions <= 0) return 0.16;
    if (itemRec.impressions === 1) return 0.1;
    if (itemRec.impressions === 2) return 0.06;
    return 0;
  }

  private repeatPenalty(itemRec: CommentRankRecord | undefined, nowMs: number) {
    if (!itemRec) return 0;
    const impressionsPenalty = Math.min(0.32, itemRec.impressions * 0.03);
    const hoursSinceShown = this.ageHours(itemRec.lastShownAt || null, nowMs);
    let recentPenalty = 0;
    if (hoursSinceShown < 0.5) recentPenalty = 0.2;
    else if (hoursSinceShown < 2) recentPenalty = 0.12;
    else if (hoursSinceShown < 8) recentPenalty = 0.06;
    return impressionsPenalty + recentPenalty;
  }

  private trimByLastActive<T extends { lastShownAt: number; lastInteractedAt: number }>(
    entries: Array<[string, T]>,
    max: number
  ) {
    return entries
      .sort((a, b) => {
        const aScore = Math.max(a[1].lastShownAt || 0, a[1].lastInteractedAt || 0);
        const bScore = Math.max(b[1].lastShownAt || 0, b[1].lastInteractedAt || 0);
        return bScore - aScore;
      })
      .slice(0, max);
  }

  createEmptyCommentRankCache() {
    return CommentRankCache.empty();
  }

  sanitizeCache(raw: any) {
    const base = CommentRankCache.empty();
    if (!raw || typeof raw !== 'object') return base;

    const commentEntries = Object.entries(raw.comments || {})
      .map(([id, value]) => [id, CommentRankRecord.fromRaw(value)] as [string, CommentRankRecord])
      .filter(([id]) => Boolean(id));

    const replyEntries = Object.entries(raw.replies || {})
      .map(([id, value]) => [id, CommentRankRecord.fromRaw(value)] as [string, CommentRankRecord])
      .filter(([id]) => Boolean(id));

    const authorEntries = Object.entries(raw.authors || {})
      .map(([id, value]) => [id, new CommentRankAuthorRecord(value as RankRecordInit)] as [string, CommentRankAuthorRecord])
      .filter(([id]) => Boolean(id));

    return new CommentRankCache({
      updatedAt: Number(raw.updatedAt ?? 0) || 0,
      comments: Object.fromEntries(this.trimByLastActive(commentEntries, MAX_COMMENT_CACHE)),
      replies: Object.fromEntries(this.trimByLastActive(replyEntries, MAX_REPLY_CACHE)),
      authors: Object.fromEntries(this.trimByLastActive(authorEntries, MAX_AUTHOR_CACHE)),
    });
  }

  async loadCommentRankCache(uid?: string | null) {
    try {
      const raw = await AsyncStorage.getItem(this.getCacheKey(uid));
      if (!raw) return CommentRankCache.empty();
      return this.sanitizeCache(JSON.parse(raw));
    } catch {
      return CommentRankCache.empty();
    }
  }

  async saveCommentRankCache(uid: string | null | undefined, cache: CommentRankCache) {
    await AsyncStorage.setItem(this.getCacheKey(uid), JSON.stringify(this.sanitizeCache(cache)));
  }

  registerCommentImpressions(
    cache: CommentRankCache,
    entries: ImpressionEntry[],
    nowMs = Date.now(),
    cooldownMs = IMPRESSION_COOLDOWN_MS
  ) {
    if (!entries.length) return cache;
    let changed = false;
    const comments = { ...cache.comments };
    const replies = { ...cache.replies };
    const authors = { ...cache.authors };

    entries.forEach((entry) => {
      if (!entry.key || !entry.authorId) return;
      const target = entry.kind === 'comment' ? comments : replies;
      const prev = target[entry.key] || new CommentRankRecord();
      if (nowMs - prev.lastShownAt < cooldownMs) return;

      changed = true;
      target[entry.key] = new CommentRankRecord({
        ...prev,
        impressions: prev.impressions + 1,
        lastShownAt: nowMs,
      });

      const authorPrev = authors[entry.authorId] || new CommentRankAuthorRecord();
      authors[entry.authorId] = new CommentRankAuthorRecord({
        ...authorPrev,
        impressions: authorPrev.impressions + 1,
        lastShownAt: nowMs,
      });
    });

    if (!changed) return cache;
    return this.sanitizeCache({
      ...cache,
      updatedAt: nowMs,
      comments,
      replies,
      authors,
    });
  }

  registerCommentLike(cache: CommentRankCache, entry: LikeEntry) {
    if (!entry.key || !entry.authorId) return cache;
    const nowMs = entry.nowMs ?? Date.now();
    const comments = { ...cache.comments };
    const replies = { ...cache.replies };
    const authors = { ...cache.authors };

    const target = entry.kind === 'comment' ? comments : replies;
    const itemPrev = target[entry.key] || new CommentRankRecord();
    target[entry.key] = new CommentRankRecord({
      ...itemPrev,
      likesGiven: entry.liked ? itemPrev.likesGiven + 1 : Math.max(0, itemPrev.likesGiven - 1),
      lastInteractedAt: nowMs,
    });

    const authorPrev = authors[entry.authorId] || new CommentRankAuthorRecord();
    authors[entry.authorId] = new CommentRankAuthorRecord({
      ...authorPrev,
      likesGiven: entry.liked ? authorPrev.likesGiven + 1 : Math.max(0, authorPrev.likesGiven - 1),
      lastInteractedAt: nowMs,
    });

    return this.sanitizeCache({
      ...cache,
      updatedAt: nowMs,
      comments,
      replies,
      authors,
    });
  }

  rankComments<T extends CommentRankableBase>(input: RankInputComment<T>) {
    const nowMs = input.nowMs ?? Date.now();
    const dayBucket = Math.floor(nowMs / 86400000);

    return [...input.comments]
      .map((comment) => {
        const key = makeCommentLikeKey(input.postId, comment.id);
        const itemRec = input.cache.comments[key];
        const authorRec = input.cache.authors[comment.authorUid];
        const hours = this.ageHours(comment.createdAtMs, nowMs);
        const recency = this.recencyScore(hours, 14);
        const interaction = this.interactionScore(comment.likeCount || 0, comment.replyCount || 0);
        const authorAffinity = this.authorAffinityScore(authorRec);
        const itemAffinity = this.itemAffinityScore(itemRec);
        const followedBoost = input.followingIds.has(comment.authorUid) ? 0.1 : 0;
        const likedBoost = input.likedCommentKeys.has(key) ? 0.13 : 0;
        const novelty = this.noveltyBoost(itemRec);
        const penalty = this.repeatPenalty(itemRec, nowMs);
        const jitter = (this.hash01(`${key}:${dayBucket}:comment`) - 0.5) * 0.04;
        const score =
          recency * 0.44 +
          interaction * 0.24 +
          authorAffinity * 0.15 +
          itemAffinity * 0.1 +
          novelty * 0.07 +
          followedBoost +
          likedBoost -
          penalty +
          jitter;
        return { comment, score };
      })
      .sort((a, b) => b.score - a.score || (b.comment.createdAtMs || 0) - (a.comment.createdAtMs || 0))
      .map((entry) => entry.comment);
  }

  rankReplies<T extends ReplyRankableBase>(input: RankInputReply<T>) {
    const nowMs = input.nowMs ?? Date.now();
    const dayBucket = Math.floor(nowMs / 86400000);

    return [...input.replies]
      .map((reply) => {
        const key = makeReplyLikeKey(input.postId, input.commentId, reply.id);
        const itemRec = input.cache.replies[key];
        const authorRec = input.cache.authors[reply.authorUid];
        const hours = this.ageHours(reply.createdAtMs, nowMs);
        const recency = this.recencyScore(hours, 12);
        const interaction = this.interactionScore(reply.likeCount || 0, 0);
        const authorAffinity = this.authorAffinityScore(authorRec);
        const itemAffinity = this.itemAffinityScore(itemRec);
        const followedBoost = input.followingIds.has(reply.authorUid) ? 0.08 : 0;
        const likedBoost = input.likedReplyKeys.has(key) ? 0.12 : 0;
        const novelty = this.noveltyBoost(itemRec);
        const penalty = this.repeatPenalty(itemRec, nowMs);
        const jitter = (this.hash01(`${key}:${dayBucket}:reply`) - 0.5) * 0.03;
        const score =
          recency * 0.48 +
          interaction * 0.2 +
          authorAffinity * 0.14 +
          itemAffinity * 0.1 +
          novelty * 0.06 +
          followedBoost +
          likedBoost -
          penalty +
          jitter;
        return { reply, score };
      })
      .sort((a, b) => b.score - a.score || (b.reply.createdAtMs || 0) - (a.reply.createdAtMs || 0))
      .map((entry) => entry.reply);
  }
}

export const commentRankingService = new CommentRankingService();

export function createEmptyCommentRankCache() {
  return commentRankingService.createEmptyCommentRankCache();
}

export async function loadCommentRankCache(uid?: string | null) {
  return commentRankingService.loadCommentRankCache(uid);
}

export async function saveCommentRankCache(uid: string | null | undefined, cache: CommentRankCache) {
  return commentRankingService.saveCommentRankCache(uid, cache);
}

export function registerCommentImpressions(
  cache: CommentRankCache,
  entries: ImpressionEntry[],
  nowMs = Date.now(),
  cooldownMs = IMPRESSION_COOLDOWN_MS
) {
  return commentRankingService.registerCommentImpressions(cache, entries, nowMs, cooldownMs);
}

export function registerCommentLike(cache: CommentRankCache, entry: LikeEntry) {
  return commentRankingService.registerCommentLike(cache, entry);
}

export function rankComments<T extends CommentRankableBase>(input: RankInputComment<T>) {
  return commentRankingService.rankComments(input);
}

export function rankReplies<T extends ReplyRankableBase>(input: RankInputReply<T>) {
  return commentRankingService.rankReplies(input);
}
