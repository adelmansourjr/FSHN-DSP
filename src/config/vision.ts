import { readExpoExtra, resolveEndpointWithFallback } from './runtime';

const extra = readExpoExtra();

const explicit = String(
  extra.EXPO_PUBLIC_VISION_SEARCH_ENDPOINT ??
    process.env.EXPO_PUBLIC_VISION_SEARCH_ENDPOINT ??
    ''
).trim();

const base = String(
  extra.TRYON_BASE_URL ??
    extra.RECOMMENDER_BASE_URL ??
    extra.RECOMMENDER_BASE ??
    process.env.TRYON_BASE_URL ??
    ''
).trim();

function resolveEndpoint() {
  return resolveEndpointWithFallback({
    explicit,
    base,
    path: '/vision/search',
    developmentFallbackBase: 'http://localhost:8787',
  });
}

export const VISION_SEARCH_ENDPOINT = resolveEndpoint();
