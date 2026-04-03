import {
  readExpoExtra,
  resolveBaseUrlWithFallback,
  resolveEndpointWithFallback,
} from './runtime';

const extra = readExpoExtra();

const explicit = String(
  extra.EXPO_PUBLIC_RECOMMENDER_ENDPOINT ?? process.env.EXPO_PUBLIC_RECOMMENDER_ENDPOINT ?? '',
).trim();
const base = String(extra.RECOMMENDER_BASE_URL ?? extra.RECOMMENDER_BASE ?? '').trim();

function resolveEndpoint(): string {
  return resolveEndpointWithFallback({
    explicit,
    base,
    path: '/recommend',
    developmentFallbackBase: 'http://localhost:8787',
  });
}

function resolveBaseUrl(): string {
  return resolveBaseUrlWithFallback({
    base,
    explicit,
    suffix: /\/recommend\/?$/i,
    developmentFallbackBase: 'http://localhost:8787',
  });
}

export const RECOMMENDER_ENDPOINT = resolveEndpoint();
export const RECOMMENDER_BASE_URL = resolveBaseUrl();
