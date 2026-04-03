import type { RecommendationItem, RecommendationInput } from './shared';
import {
  affinityScore,
  buildTasteProfile,
  deterministicJitter,
  isItemLiked,
  itemCategoryKey,
  itemRoleKey,
  popularityValue,
  toLikedSet,
} from './shared';

export function buildDiscoverRecommendations({
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
      const longTail = 1 - popNorm;
      const affinity = affinityScore(item, profile);
      const role = itemRoleKey(item);
      const category = itemCategoryKey(item);
      const roleExplore = profile.topRoles.size && role && !profile.topRoles.has(role) ? 1 : 0;
      const categoryExplore =
        profile.topCategories.size && category && !profile.topCategories.has(category) ? 1 : 0;
      const novelty = longTail * 0.52 + roleExplore * 0.2 + categoryExplore * 0.18 + (1 - affinity) * 0.1;
      const jitter = deterministicJitter(item.id || item.image || '');

      const score =
        profile.likedCount > 0
          ? affinity * 0.34 + novelty * 0.58 + jitter * 0.08 - (liked ? 0.2 : 0)
          : longTail * 0.48 + popNorm * 0.18 + jitter * 0.34 - (liked ? 0.16 : 0);

      return { item, score, role, category, liked };
    })
    .sort((a, b) => b.score - a.score);

  // Keep early results diverse by rotating role buckets.
  const groups = new Map<string, RecommendationItem[]>();
  ranked.forEach((entry) => {
    const key = entry.role || entry.category || 'other';
    const bucket = groups.get(key) || [];
    bucket.push(entry.item);
    groups.set(key, bucket);
  });

  const orderedKeys = Array.from(groups.keys()).sort(
    (a, b) => (groups.get(b)?.length || 0) - (groups.get(a)?.length || 0)
  );
  const diversified: RecommendationItem[] = [];
  let index = 0;
  while (diversified.length < safeLimit) {
    let pushed = false;
    for (let i = 0; i < orderedKeys.length; i += 1) {
      const bucket = groups.get(orderedKeys[i]) || [];
      if (index >= bucket.length) continue;
      diversified.push(bucket[index]);
      pushed = true;
      if (diversified.length >= safeLimit) break;
    }
    if (!pushed) break;
    index += 1;
  }

  const unlikedDiversified = diversified.filter((item) => !isItemLiked(item, likedSet));
  if (unlikedDiversified.length >= Math.min(8, safeLimit)) {
    return unlikedDiversified.slice(0, safeLimit);
  }
  return diversified.slice(0, safeLimit);
}

