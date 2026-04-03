import Constants from 'expo-constants';
import type { ShippingAddress } from '../shippingAddress';
import { buildJsonHeaders } from '../apiAuth';
import { readExpoExtra, resolveBaseUrlWithFallback } from '../../config/runtime';
import type { ShippingQuoteResponse } from '../shippingCo';

const extra = readExpoExtra();

export const STRIPE_PUBLISHABLE_KEY = String(
  extra.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ||
    process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ||
    '',
).trim();

export const STRIPE_BACKEND_URL = String(
  extra.EXPO_PUBLIC_STRIPE_BACKEND_URL ||
    process.env.EXPO_PUBLIC_STRIPE_BACKEND_URL ||
    '',
).trim();

async function readBackendError(res: Response, fallback: string) {
  const raw = await res.text();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error) {
      return parsed?.details ? `${parsed.error} (${parsed.details})` : parsed.error;
    }
  } catch {
    // keep raw text
  }
  return raw || fallback;
}

export function resolveBackendUrl() {
  return resolveBaseUrlWithFallback({
    explicit: STRIPE_BACKEND_URL,
    developmentFallbackBase: 'http://localhost:4242',
  });
}

export type CreatePaymentIntentResponse = {
  clientSecret: string;
  paymentIntentId?: string;
};

export async function quoteShipping(params: {
  shippingAddress?: ShippingAddress;
  items?: Array<{
    id: string;
    listingId?: string;
    qty?: number;
    price?: number;
    unitAmount?: number;
    imageUrl?: string;
  }>;
}) {
  const backendUrl = resolveBackendUrl();
  if (!backendUrl) {
    throw new Error('Stripe backend URL is missing. Set EXPO_PUBLIC_STRIPE_BACKEND_URL in app config.');
  }

  const res = await fetch(`${backendUrl}/quote-shipping`, {
    method: 'POST',
    headers: await buildJsonHeaders({ required: true }),
    body: JSON.stringify({
      shippingAddress: params.shippingAddress || null,
      items: params.items ?? [],
    }),
  });

  if (!res.ok) {
    throw new Error(await readBackendError(res, `Failed to quote shipping (${res.status})`));
  }

  return (await res.json()) as ShippingQuoteResponse;
}

export async function createPaymentIntent(params: {
  amount: number; // in cents
  currency?: string;
  shippingAddress?: ShippingAddress;
  items?: Array<{
    id: string;
    listingId?: string;
    qty: number;
    price?: number;
    unitAmount?: number;
    imageUrl?: string;
  }>;
}) {
  const backendUrl = resolveBackendUrl();
  if (!backendUrl) {
    throw new Error('Stripe backend URL is missing. Set EXPO_PUBLIC_STRIPE_BACKEND_URL in app config.');
  }

  if (backendUrl.includes('localhost') && Constants.appOwnership === 'expo') {
    throw new Error('Stripe backend URL uses localhost. Use your machine IP instead for Expo Go.');
  }

  if (__DEV__) {
    console.log('[Stripe] createPaymentIntent request', {
      backendUrl,
      amount: params.amount,
      currency: params.currency || 'gbp',
      items: params.items?.length || 0,
    });
  }

  const res = await fetch(`${backendUrl}/create-payment-intent`, {
    method: 'POST',
    headers: await buildJsonHeaders({ required: true }),
    body: JSON.stringify({
      amount: params.amount,
      currency: params.currency || 'gbp',
      shippingAddress: params.shippingAddress || null,
      items: params.items ?? [],
    }),
  });

  if (!res.ok) {
    const msg = await readBackendError(res, `Failed to create payment intent (${res.status})`);
    if (__DEV__) {
      console.error('[Stripe] createPaymentIntent failed', {
        status: res.status,
        statusText: res.statusText,
        body: msg,
      });
    }
    throw new Error(msg || `Failed to create payment intent (${res.status})`);
  }

  const json = (await res.json()) as CreatePaymentIntentResponse;
  if (__DEV__) {
    console.log('[Stripe] createPaymentIntent success', {
      hasClientSecret: !!json.clientSecret,
    });
  }
  return json;
}

export type FinalizePaymentIntentResponse = {
  ok: boolean;
  paymentIntentId: string;
  processed: number;
  skipped: number;
  results: Array<{ listingId: string; ok: boolean; reason?: string }>;
};

export async function finalizePaymentIntent(params: {
  paymentIntentId: string;
  shippingAddress?: ShippingAddress;
  items?: Array<{
    id: string;
    listingId?: string;
    qty?: number;
    price?: number;
    unitAmount?: number;
    imageUrl?: string;
  }>;
}) {
  const backendUrl = resolveBackendUrl();
  if (!backendUrl) {
    throw new Error('Stripe backend URL is missing. Set EXPO_PUBLIC_STRIPE_BACKEND_URL in app config.');
  }

  const res = await fetch(`${backendUrl}/finalize-payment-intent`, {
    method: 'POST',
    headers: await buildJsonHeaders({ required: true }),
    body: JSON.stringify({
      paymentIntentId: params.paymentIntentId,
      shippingAddress: params.shippingAddress || null,
      items: params.items ?? [],
    }),
  });

  if (!res.ok) {
    throw new Error(
      await readBackendError(res, `Failed to finalize payment intent (${res.status})`)
    );
  }

  return (await res.json()) as FinalizePaymentIntentResponse;
}
