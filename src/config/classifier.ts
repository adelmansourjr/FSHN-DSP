import { readExpoExtra, resolveEndpointWithFallback } from './runtime';

const extra = readExpoExtra();

const explicit = String(
  extra.EXPO_PUBLIC_CLASSIFIER_ENDPOINT ?? process.env.EXPO_PUBLIC_CLASSIFIER_ENDPOINT ?? '',
).trim();
const base = String(
  extra.CLASSIFIER_BASE_URL ??
    extra.CLASSIFIER_BASE ??
    extra.TRYON_BASE_URL ??
    extra.RECOMMENDER_BASE_URL ??
    '',
).trim();

function resolveEndpoint(): string {
  return resolveEndpointWithFallback({
    explicit,
    base,
    path: '/classify',
    developmentFallbackBase: 'http://localhost:8787',
  });
}

export const CLASSIFIER_ENDPOINT = resolveEndpoint();
