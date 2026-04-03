import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_PREFIX = 'feed.rank.cache.v1';
const MAX_POST_CACHE = 800;
const MAX_AUTHOR_CACHE = 400;
const IMPRESSION_COOLDOWN_MS = 3 * 60 * 1000;

type NumericMap<T> = Record<string, T>;

type FeedRankRecordInit = {
  impressions?: number;
  likesGiven?: number;
  lastShownAt?: number;
  lastInteractedAt?: number;
};

export class FeedRankPostRecord {
  impressions: number;
  likesGiven: number;
  lastShownAt: number;
  lastInteractedAt: number;

  constructor(init: FeedRankRecordInit = {}) {
    this.impressions = Number(init.impressions ?? 0) || 0;
    this.likesGiven = Number(init.likesGiven ?? 0) || 0;
    this.lastShownAt = Number(init.lastShownAt ?? 0) || 0;
    this.lastInteractedAt = Number(init.lastInteractedAt ?? 0) || 0;
  }

  static fromRaw(raw: any) {
    return new FeedRankPostRecord(raw);
  }
}

export class FeedRankAuthorRecord {
  impressions: number;
  likesGiven: number;
  lastShownAt: number;
  lastInteractedAt: number;

  constructor(init: FeedRankRecordInit = {}) {
    this.impressions = Number(init.impressions ?? 0) || 0;
    this.likesGiven = Number(init.likesGiven ?? 0) || 0;
    this.lastShownAt = Number(init.lastShownAt ?? 0) || 0;
    this.lastInteractedAt = Number(init.lastInteractedAt ?? 0) || 0;
  }

  static fromRaw(raw: any) {
    return new FeedRankAuthorRecord(raw);
  }
}

export class FeedRankCache {
  version: 1;
  updatedAt: number;
  posts: NumericMap<FeedRankPostRecord>;
  authors: NumericMap<FeedRankAuthorRecord>;

  constructor(init?: Partial<FeedRankCache>) {
    this.version = 1;
    this.updatedAt = Number(init?.updatedAt ?? 0) || 0;
    this.posts = init?.posts || {};
    this.authors = init?.authors || {};
  }

  static empty() {
    return new FeedRankCache({
      updatedAt: 0,
      posts: {},
      authors: {},
    });
  }
}

export type FeedRankablePost = {
  id: string;
  authorUid: string;
  likes: number;
  commentCount?: number;
  createdAtMs?: number | null;
};

type RankInput<T extends FeedRankablePost> = {
  posts: T[];
  followingIds: Set<string>;
  likedPostIds: Set<string>;
  cache: FeedRankCache;
  nowMs?: number;
};

export class FeedRankingService {
  private getCacheKey(uid?: string | null) {
    return `${CACHE_PREFIX}:${uid || 'anon'}`;
  }

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

  createEmptyFeedRankCache() {
    return FeedRankCache.empty();
  }

  sanitizeCache(raw: any) {
    const base = FeedRankCache.empty();
    if (!raw || typeof raw !== 'object') return base;

    const rawPosts = raw.posts && typeof raw.posts === 'object' ? raw.posts : {};
    const rawAuthors = raw.authors && typeof raw.authors === 'object' ? raw.authors : {};

    const postsEntries = Object.entries(rawPosts)
      .map(([id, value]) => [id, FeedRankPostRecord.fromRaw(value)] as [string, FeedRankPostRecord])
      .filter(([id]) => Boolean(id));

    const authorEntries = Object.entries(rawAuthors)
      .map(([id, value]) => [id, FeedRankAuthorRecord.fromRaw(value)] as [string, FeedRankAuthorRecord])
      .filter(([id]) => Boolean(id));

    return new FeedRankCache({
      updatedAt: Number(raw.updatedAt ?? 0) || 0,
      posts: Object.fromEntries(this.trimByLastActive(postsEntries, MAX_POST_CACHE)),
      authors: Object.fromEntries(this.trimByLastActive(authorEntries, MAX_AUTHOR_CACHE)),
    });
  }

  async loadFeedRankCache(uid?: string | null) {
    try {
      const raw = await AsyncStorage.getItem(this.getCacheKey(uid));
      if (!raw) return FeedRankCache.empty();
      return this.sanitizeCache(JSON.parse(raw));
    } catch {
      return FeedRankCache.empty();
    }
  }

  async saveFeedRankCache(uid: string | null | undefined, cache: FeedRankCache) {
    const next = this.sanitizeCache(cache);
    await AsyncStorage.setItem(this.getCacheKey(uid), JSON.stringify(next));
  }

  registerFeedImpressions(
    cache: FeedRankCache,
    impressions: Array<{ postId: string; authorId: string }>,
    nowMs = Date.now(),
    cooldownMs = IMPRESSION_COOLDOWN_MS
  ) {
    if (!impressions.length) return cache;

    let changed = false;
    const nextPosts: FeedRankCache['posts'] = { ...cache.posts };
    const nextAuthors: FeedRankCache['authors'] = { ...cache.authors };

    impressions.forEach(({ postId, authorId }) => {
      if (!postId || !authorId) return;

      const postPrev = nextPosts[postId] ?? new FeedRankPostRecord();
      if (nowMs - postPrev.lastShownAt < cooldownMs) return;
      changed = true;
      nextPosts[postId] = new FeedRankPostRecord({
        ...postPrev,
        impressions: postPrev.impressions + 1,
        lastShownAt: nowMs,
      });

      const authorPrev = nextAuthors[authorId] ?? new FeedRankAuthorRecord();
      nextAuthors[authorId] = new FeedRankAuthorRecord({
        ...authorPrev,
        impressions: authorPrev.impressions + 1,
        lastShownAt: nowMs,
      });
    });

    if (!changed) return cache;
    return this.sanitizeCache({
      ...cache,
      updatedAt: nowMs,
      posts: nextPosts,
      authors: nextAuthors,
    });
  }

  registerFeedLike(
    cache: FeedRankCache,
    params: { postId: string; authorId: string; liked: boolean; nowMs?: number }
  ) {
    const { postId, authorId, liked, nowMs = Date.now() } = params;
    if (!postId || !authorId) return cache;

    const nextPosts: FeedRankCache['posts'] = { ...cache.posts };
    const nextAuthors: FeedRankCache['authors'] = { ...cache.authors };

    const postPrev = nextPosts[postId] ?? new FeedRankPostRecord();
    nextPosts[postId] = new FeedRankPostRecord({
      ...postPrev,
      likesGiven: liked ? postPrev.likesGiven + 1 : Math.max(0, postPrev.likesGiven - 1),
      lastInteractedAt: nowMs,
    });

    const authorPrev = nextAuthors[authorId] ?? new FeedRankAuthorRecord();
    nextAuthors[authorId] = new FeedRankAuthorRecord({
      ...authorPrev,
      likesGiven: liked ? authorPrev.likesGiven + 1 : Math.max(0, authorPrev.likesGiven - 1),
      lastInteractedAt: nowMs,
    });

    return this.sanitizeCache({
      ...cache,
      updatedAt: nowMs,
      posts: nextPosts,
      authors: nextAuthors,
    });
  }

  private ageHours(createdAtMs: number | null | undefined, nowMs: number) {
    if (!createdAtMs || !Number.isFinite(createdAtMs)) return 72;
    return Math.max(0, (nowMs - createdAtMs) / 3600000);
  }

  private recencyScore(hours: number, halfLifeHours: number) {
    return Math.exp((-Math.log(2) * hours) / halfLifeHours);
  }

  private engagementScore(likes: number, comments: number) {
    return this.clamp01(Math.log1p(Math.max(0, likes) + Math.max(0, comments) * 2) / 8);
  }

  private trendVelocityScore(likes: number, comments: number, hours: number) {
    const velocity = (Math.max(0, likes) + Math.max(0, comments) * 2) / Math.pow(hours + 2, 0.65);
    return this.clamp01(Math.log1p(velocity) / 6);
  }

  private authorAffinityScore(authorRec?: FeedRankAuthorRecord) {
    if (!authorRec) return 0;
    return this.clamp01(authorRec.likesGiven * 0.35 + authorRec.impressions * 0.015);
  }

  private postAffinityScore(postRec?: FeedRankPostRecord) {
    if (!postRec) return 0;
    return this.clamp01(postRec.likesGiven * 0.4);
  }

  private repeatPenalty(postRec: FeedRankPostRecord | undefined, nowMs: number) {
    if (!postRec) return 0;
    const impressionsPenalty = Math.min(0.34, postRec.impressions * 0.035);
    const hoursSinceShown = this.ageHours(postRec.lastShownAt || null, nowMs);
    let recentPenalty = 0;
    if (hoursSinceShown < 1) recentPenalty = 0.24;
    else if (hoursSinceShown < 4) recentPenalty = 0.13;
    else if (hoursSinceShown < 12) recentPenalty = 0.07;
    return impressionsPenalty + recentPenalty;
  }

  private noveltyBoost(postRec?: FeedRankPostRecord) {
    if (!postRec) return 0.16;
    if (postRec.impressions <= 0) return 0.16;
    if (postRec.impressions === 1) return 0.1;
    if (postRec.impressions === 2) return 0.06;
    return 0;
  }

  rankFollowingFeed<T extends FeedRankablePost>(input: RankInput<T>) {
    const nowMs = input.nowMs ?? Date.now();
    const dayBucket = Math.floor(nowMs / 86400000);

    return input.posts
      .filter((post) => input.followingIds.has(post.authorUid))
      .map((post) => {
        const postRec = input.cache.posts[post.id];
        const authorRec = input.cache.authors[post.authorUid];
        const hours = this.ageHours(post.createdAtMs, nowMs);
        const recency = this.recencyScore(hours, 18);
        const engagement = this.engagementScore(post.likes || 0, post.commentCount || 0);
        const affinity = this.authorAffinityScore(authorRec) * 0.75 + this.postAffinityScore(postRec) * 0.25;
        const likedBoost = input.likedPostIds.has(post.id) ? 0.1 : 0;
        const novelty = this.noveltyBoost(postRec);
        const penalty = this.repeatPenalty(postRec, nowMs);
        const jitter = (this.hash01(`${post.id}:${dayBucket}:following`) - 0.5) * 0.03;

        const score =
          recency * 0.5 +
          engagement * 0.18 +
          affinity * 0.16 +
          novelty * 0.08 +
          likedBoost -
          penalty +
          jitter;

        return { post, score };
      })
      .sort((a, b) => b.score - a.score || (b.post.createdAtMs || 0) - (a.post.createdAtMs || 0))
      .map((entry) => entry.post);
  }

  rankForYouFeed<T extends FeedRankablePost>(input: RankInput<T>) {
    const nowMs = input.nowMs ?? Date.now();
    const dayBucket = Math.floor(nowMs / 86400000);

    const likedAuthors = new Set(
      input.posts.filter((p) => input.likedPostIds.has(p.id)).map((p) => p.authorUid)
    );

    return [...input.posts]
      .map((post) => {
        const postRec = input.cache.posts[post.id];
        const authorRec = input.cache.authors[post.authorUid];
        const hours = this.ageHours(post.createdAtMs, nowMs);
        const recency = this.recencyScore(hours, 28);
        const trend = this.trendVelocityScore(post.likes || 0, post.commentCount || 0, hours);
        const popularity = this.engagementScore(post.likes || 0, post.commentCount || 0);
        const affinity =
          this.authorAffinityScore(authorRec) * 0.65 +
          this.postAffinityScore(postRec) * 0.2 +
          (likedAuthors.has(post.authorUid) ? 0.15 : 0);
        const followedBoost = input.followingIds.has(post.authorUid) ? 0.08 : 0;
        const likedBoost = input.likedPostIds.has(post.id) ? 0.12 : 0;
        const novelty = this.noveltyBoost(postRec);
        const penalty = this.repeatPenalty(postRec, nowMs);
        const stalePenalty = hours > 24 * 10 ? Math.min(0.24, (hours - 24 * 10) / (24 * 40)) : 0;
        const jitter = (this.hash01(`${post.id}:${dayBucket}:foryou`) - 0.5) * 0.05;

        const score =
          recency * 0.28 +
          trend * 0.26 +
          popularity * 0.16 +
          affinity * 0.2 +
          novelty * 0.08 +
          followedBoost +
          likedBoost -
          penalty -
          stalePenalty +
          jitter;

        return { post, score };
      })
      .sort((a, b) => b.score - a.score || (b.post.createdAtMs || 0) - (a.post.createdAtMs || 0))
      .map((entry) => entry.post);
  }
}

export const feedRankingService = new FeedRankingService();

export function createEmptyFeedRankCache() {
  return feedRankingService.createEmptyFeedRankCache();
}

export async function loadFeedRankCache(uid?: string | null) {
  return feedRankingService.loadFeedRankCache(uid);
}

export async function saveFeedRankCache(uid: string | null | undefined, cache: FeedRankCache) {
  return feedRankingService.saveFeedRankCache(uid, cache);
}

export function registerFeedImpressions(
  cache: FeedRankCache,
  impressions: Array<{ postId: string; authorId: string }>,
  nowMs = Date.now(),
  cooldownMs = IMPRESSION_COOLDOWN_MS
) {
  return feedRankingService.registerFeedImpressions(cache, impressions, nowMs, cooldownMs);
}

export function registerFeedLike(
  cache: FeedRankCache,
  params: { postId: string; authorId: string; liked: boolean; nowMs?: number }
) {
  return feedRankingService.registerFeedLike(cache, params);
}

export function rankFollowingFeed<T extends FeedRankablePost>(input: RankInput<T>) {
  return feedRankingService.rankFollowingFeed(input);
}

export function rankForYouFeed<T extends FeedRankablePost>(input: RankInput<T>) {
  return feedRankingService.rankForYouFeed(input);
}
