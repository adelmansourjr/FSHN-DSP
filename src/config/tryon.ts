// src/config/tryon.ts
import { readExpoExtra, resolveEndpointWithFallback } from './runtime';

const extra = readExpoExtra();

const endpointFromExtra = String(extra.EXPO_PUBLIC_GOOGLE_TRYON_ENDPOINT ?? '').trim();
const baseFromExtra = String(extra.TRYON_BASE_URL ?? '').trim();

function ensureEndpoint(): string {
  return resolveEndpointWithFallback({
    explicit: endpointFromExtra || String(process.env.EXPO_PUBLIC_TRYON_API || '').trim(),
    base: baseFromExtra,
    path: '/tryon',
    developmentFallbackBase: 'http://localhost:8787',
  });
}

export const TRYON_ENDPOINT = ensureEndpoint();
