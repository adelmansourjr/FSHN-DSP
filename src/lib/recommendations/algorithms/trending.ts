import type { RecommendationItem, RecommendationInput } from './shared';
import {
  affinityScore,
  buildTasteProfile,
  deterministicJitter,
  isItemLiked,
  popularityValue,
  toLikedSet,
} from './shared';

export function buildTrendingRecommendations({
  items,
  likedIds,
  limit = 120,
}: RecommendationInput): RecommendationItem[] {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const likedSet = toLikedSet(likedIds);
  const profile = buildTasteProfile(items, likedSet);

  const candidates = items.filter((item) => String(item?.id || '').trim() && String(item?.image || '').trim());
  const maxPopularity = Math.max(1, ...candidates.map((item) => popularityValue(item)));
  const maxPopularityLog = Math.log1p(maxPopularity);

  const ranked = candidates
    .map((item) => {
      const liked = isItemLiked(item, likedSet);
      const popNorm = maxPopularityLog > 0 ? Math.log1p(popularityValue(item)) / maxPopularityLog : 0;
      const affinity = affinityScore(item, profile);
      const jitter = deterministicJitter(item.id || item.image || '');

      const score =
        profile.likedCount > 0
          ? popNorm * 0.56 + affinity * 0.36 + jitter * 0.08 - (liked ? 0.24 : 0)
          : popNorm * 0.74 + jitter * 0.26 - (liked ? 0.2 : 0);

      return { item, score, liked };
    })
    .sort((a, b) => b.score - a.score);

  const unliked = ranked.filter((entry) => !entry.liked).map((entry) => entry.item);
  if (unliked.length >= Math.min(8, safeLimit)) {
    return unliked.slice(0, safeLimit);
  }
  return ranked.slice(0, safeLimit).map((entry) => entry.item);
}

