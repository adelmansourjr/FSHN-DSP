import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getServerRuntimeConfig, validateServerConfig } from './config.mjs';
import {
  createSandboxEvent,
  createSandboxSchedule,
  formatParcelProfileLabel,
  formatSandboxPhaseLabel,
  getShippingCoConfig,
  inferParcelProfileFromListing,
  isShippingCoAddressComplete,
  nextSandboxPhase,
  normalizeParcelProfile,
  phaseDueForSchedule,
  quoteShippingCoShipment,
  sanitizeShippingCoAddress,
} from './shippingCo.mjs';
import {
  createConfirmCheckoutSessionAndFulfill,
  orderDocId,
  validateFulfillmentOpportunity,
} from './paymentIntegrity.mjs';
import { registerPaymentRoutes } from './paymentRoutes.mjs';

dotenv.config();

const runtimeConfig = validateServerConfig(getServerRuntimeConfig());
const STRIPE_SECRET_KEY = runtimeConfig.stripeSecretKey;
const STRIPE_WEBHOOK_SECRET = runtimeConfig.stripeWebhookSecret;
const FIREBASE_PROJECT_ID = runtimeConfig.firebaseProjectId;
const FIREBASE_SERVICE_ACCOUNT_JSON = runtimeConfig.firebaseServiceAccountJson;
const FIREBASE_CREDENTIAL_PATH = runtimeConfig.googleApplicationCredentials;
const shippingCoConfig = getShippingCoConfig(process.env);

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

let firestoreDb = null;

function getDb() {
  if (firestoreDb) return firestoreDb;
  try {
    if (!getApps().length) {
      if (FIREBASE_SERVICE_ACCOUNT_JSON) {
        const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
        initializeApp({
          credential: cert(serviceAccount),
          projectId: serviceAccount.project_id || FIREBASE_PROJECT_ID,
        });
      } else {
        initializeApp({
          credential: applicationDefault(),
          projectId: FIREBASE_PROJECT_ID,
        });
      }
    }
    firestoreDb = getFirestore();
  } catch (err) {
    console.error('[firebase] admin init failed', err);
    firestoreDb = null;
  }
  return firestoreDb;
}

function cleanString(value, maxLen = 200) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.slice(0, maxLen);
}

function makeShortDisplayCode(value) {
  const raw = cleanString(value || '', 240);
  if (!raw) return 'PENDING';
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const compact = (hash >>> 0).toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return compact.slice(-6).padStart(6, '0');
}

function formatDisplayOrderNumber(value) {
  const raw = cleanString(value || '', 240);
  if (!raw) return '#PENDING';
  const base = raw.split('__')[0] || raw;
  return `#${makeShortDisplayCode(base)}`;
}

function normalizeOrderStatus(value) {
  const raw = cleanString(value || '', 80).toLowerCase();
  if (!raw) return 'paid';
  if (raw === 'paid' || raw === 'pending_delivery') return raw;
  if (raw === 'shipped') return 'shipped';
  if (raw === 'out_for_delivery' || raw === 'out-for-delivery') return 'out_for_delivery';
  if (raw === 'delivered') return 'delivered';
  if (raw === 'completed' || raw === 'complete') return 'completed';
  if (raw === 'cancelled' || raw === 'canceled') return 'cancelled';
  if (raw === 'cancelled_by_buyer' || raw === 'canceled_by_buyer') return 'cancelled_by_buyer';
  if (raw === 'cancelled_by_seller' || raw === 'canceled_by_seller') return 'cancelled_by_seller';
  return 'paid';
}

function orderHasShipmentProgress(order) {
  return Boolean(
    order?.shippedAt ||
      order?.outForDeliveryAt ||
      order?.deliveredAt ||
      order?.completedAt
  );
}

function getBearerToken(req) {
  const header = cleanString(req.headers?.authorization || '', 4000);
  if (!header) return '';
  const [scheme, token] = header.split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return '';
  return token.trim();
}

async function requireRequestAuthUid(req) {
  const token = getBearerToken(req);
  if (!token) {
    const error = new Error('Missing auth token.');
    error.statusCode = 401;
    throw error;
  }

  getDb();
  const decoded = await getAdminAuth().verifyIdToken(token);
  const uid = cleanString(decoded?.uid || '', 128);
  if (!uid) {
    const error = new Error('Invalid auth token.');
    error.statusCode = 401;
    throw error;
  }
  req.authUid = uid;
  return uid;
}

function toListingId(raw) {
  const normalize = (value) => {
    const clean = cleanString(value || '', 200);
    if (!clean) return '';
    if (clean.startsWith('listing:')) return clean.slice('listing:'.length);
    if (clean.startsWith('real-listing-')) return clean.slice('real-listing-'.length);
    if (clean.startsWith('liked-listing:')) return clean.slice('liked-listing:'.length);
    if (clean.startsWith('listings/')) return clean.slice('listings/'.length);
    return clean;
  };

  const explicit = normalize(raw?.listingId);
  if (explicit) return explicit;

  const id = normalize(raw?.id);
  if (!id) return '';
  return id;
}

function toUnitAmount(item) {
  const unitAmount = Number(item?.unitAmount);
  if (Number.isFinite(unitAmount) && unitAmount > 0) {
    return Math.round(unitAmount);
  }
  const price = Number(item?.price);
  if (Number.isFinite(price) && price > 0) {
    return Math.round(price * 100);
  }
  return 0;
}

function normalizeItems(rawItems = []) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((item) => {
      const listingId = toListingId(item);
      const qty = Math.max(1, Math.round(Number(item?.qty) || 1));
      const unitAmount = toUnitAmount(item);
      return {
        id: cleanString(item?.id || listingId || '', 200),
        listingId,
        title: cleanString(item?.title || 'Item', 120),
        qty,
        unitAmount,
        imageUrl: cleanString(item?.imageUrl || item?.uri || '', 2000),
      };
    });
}

function sanitizeShippingAddress(raw = {}) {
  return {
    name: cleanString(raw?.name || raw?.fullName || '', 120),
    line1: cleanString(raw?.line1 || raw?.addressLine1 || '', 180),
    line2: cleanString(raw?.line2 || raw?.addressLine2 || '', 180),
    city: cleanString(raw?.city || '', 120),
    region: cleanString(raw?.region || raw?.state || '', 120),
    postalCode: cleanString(raw?.postalCode || raw?.postal_code || '', 40),
    country: cleanString(raw?.country || '', 80),
  };
}

function buildMetadata({ buyerUid, items, source, shippingAddress, quoteId = '' }) {
  const listingIds = Array.from(
    new Set(
      items
        .map((it) => cleanString(it.listingId || '', 160))
        .filter(Boolean)
    )
  ).slice(0, 20);

  const shipping = sanitizeShippingAddress(shippingAddress);

  return {
    buyerUid: cleanString(buyerUid || '', 128),
    quoteId: cleanString(quoteId || '', 180),
    listingIds: listingIds.join(','),
    itemCount: String(items.length || 0),
    source: cleanString(source || 'unknown', 40),
    shipName: shipping.name,
    shipLine1: shipping.line1,
    shipLine2: shipping.line2,
    shipCity: shipping.city,
    shipRegion: shipping.region,
    shipPostal: shipping.postalCode,
    shipCountry: shipping.country,
  };
}

function logStructured(level, event, payload = {}) {
  const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  target(
    JSON.stringify({
      service: 'payments-api',
      event,
      appEnv: runtimeConfig.appEnv,
      timestamp: new Date().toISOString(),
      ...payload,
    }),
  );
}

function authResultForLog(req) {
  if (req.authUid) return 'verified';
  return getBearerToken(req) ? 'present_unverified' : 'missing';
}

function parseItemsFromMetadata(metadata = {}) {
  const csv = cleanString(metadata?.listingIds || '', 1000);
  if (csv) {
    return csv
      .split(',')
      .map((value) => cleanString(value, 160))
      .filter(Boolean)
      .map((listingId) => ({
        id: listingId,
        listingId,
        title: 'Listing',
        qty: 1,
        unitAmount: 0,
        imageUrl: '',
      }));
  }

  const legacy = cleanString(metadata?.items || '', 5000);
  if (!legacy) return [];
  try {
    return normalizeItems(JSON.parse(legacy));
  } catch {
    return [];
  }
}

function parseShippingFromMetadata(metadata = {}) {
  return sanitizeShippingAddress({
    name: metadata?.shipName,
    line1: metadata?.shipLine1,
    line2: metadata?.shipLine2,
    city: metadata?.shipCity,
    region: metadata?.shipRegion,
    postalCode: metadata?.shipPostal,
    country: metadata?.shipCountry,
  });
}

function parseQuoteIdFromMetadata(metadata = {}) {
  return cleanString(metadata?.quoteId || metadata?.shippingQuoteId || '', 180);
}

function makeHttpError(message, statusCode = 400, code = 'BAD_REQUEST') {
  const error = new Error(String(message || 'Request failed.'));
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function quoteDocId(quoteId) {
  return cleanString(quoteId || '', 180).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180);
}

function resolveListingUnitAmount(listing = {}, fallback = 0) {
  const listingAmount = Number(listing?.price?.amount);
  if (Number.isFinite(listingAmount) && listingAmount >= 0) {
    return Math.round(listingAmount);
  }
  const fallbackAmount = Number(fallback);
  if (Number.isFinite(fallbackAmount) && fallbackAmount >= 0) {
    return Math.round(fallbackAmount);
  }
  return 0;
}

function resolveListingCurrency(listing = {}, fallback = 'GBP') {
  return cleanString(listing?.price?.currency || fallback, 12).toUpperCase() || fallback;
}

function toShippingSnapshot(address, extra = {}) {
  const normalized = sanitizeShippingCoAddress(address || {});
  return {
    ...extra,
    name: normalized.name || null,
    line1: normalized.line1 || null,
    line2: normalized.line2 || null,
    city: normalized.city || null,
    region: normalized.region || null,
    postalCode: normalized.postalCode || null,
    country: normalized.country || null,
  };
}

function normalizeSandboxPhase(value) {
  const raw = cleanString(value || '', 80).toLowerCase();
  if (raw === 'label_created') return 'label_created';
  if (raw === 'in_transit' || raw === 'in-transit') return 'in_transit';
  if (raw === 'out_for_delivery' || raw === 'out-for-delivery') return 'out_for_delivery';
  if (raw === 'delivered') return 'delivered';
  return '';
}

function buildSandboxTrackingCode(orderId, accessToken) {
  return `SC-SBX-${makeShortDisplayCode(`${orderId}:${accessToken}`)}`;
}

function buildShippingCoTrackingUrl(req, accessToken) {
  const origin = resolvePublicOrigin(req);
  return origin
    ? `${origin}/shipping/sandbox/shippingco/track/${encodeURIComponent(accessToken)}`
    : '';
}

function extractOrderReceiverAddress(order = {}) {
  return sanitizeShippingCoAddress({
    name:
      order?.shipping?.receiver?.name ||
      order?.shipping?.name ||
      order?.shippingName ||
      order?.buyerName,
    line1:
      order?.shipping?.receiver?.line1 ||
      order?.shipping?.address?.line1 ||
      order?.shipping?.address?.address1,
    line2:
      order?.shipping?.receiver?.line2 ||
      order?.shipping?.address?.line2 ||
      order?.shipping?.address?.address2,
    city: order?.shipping?.receiver?.city || order?.shipping?.address?.city,
    region:
      order?.shipping?.receiver?.region ||
      order?.shipping?.address?.state ||
      order?.shipping?.address?.region,
    postalCode:
      order?.shipping?.receiver?.postalCode ||
      order?.shipping?.address?.postal_code ||
      order?.shipping?.address?.postalCode,
    country: order?.shipping?.receiver?.country || order?.shipping?.address?.country,
  });
}

function toPublicShippingQuote(quote = {}) {
  return {
    ok: true,
    currency: cleanString(quote.currency || 'GBP', 12).toUpperCase() || 'GBP',
    subtotalAmount: Math.max(0, Math.round(Number(quote.subtotalAmount) || 0)),
    shippingAmount: Math.max(0, Math.round(Number(quote.shippingAmount) || 0)),
    totalAmount: Math.max(0, Math.round(Number(quote.totalAmount) || 0)),
    items: Array.isArray(quote.items)
      ? quote.items.map((item) => ({
          listingId: cleanString(item?.listingId || '', 180),
          title: cleanString(item?.title || 'Listing', 160),
          parcelProfile:
            normalizeParcelProfile(item?.parcelProfile) || inferParcelProfileFromListing({}),
          amount: Math.max(0, Math.round(Number(item?.amount) || 0)),
          currency: cleanString(item?.currency || 'GBP', 12).toUpperCase() || 'GBP',
          provider: cleanString(item?.provider || 'fixed', 40) || 'fixed',
          providerMode: cleanString(item?.providerMode || 'fixed', 20) || 'fixed',
          carrier: cleanString(item?.carrier || 'ShippingCo', 80) || 'ShippingCo',
          service: cleanString(item?.service || 'ShippingCo', 120) || 'ShippingCo',
          displayLabel: cleanString(item?.displayLabel || 'ShippingCo', 80) || 'ShippingCo',
          isFallback: Boolean(item?.isFallback),
          rate: cleanString(item?.rate || '', 40) || null,
          itemAmount: Math.max(0, Math.round(Number(item?.itemAmount) || 0)),
          unitAmount: Math.max(0, Math.round(Number(item?.unitAmount) || 0)),
          qty: Math.max(1, Math.round(Number(item?.qty) || 1)),
          parcelLabel:
            cleanString(item?.parcelLabel || formatParcelProfileLabel(item?.parcelProfile), 80) || null,
        }))
      : [],
  };
}

async function buildShippingCoCheckoutQuote({ rawItems = [], shippingAddress = null }) {
  const db = getDb();
  if (!db) {
    throw new Error('Firestore Admin is not initialized.');
  }

  const receiverAddress = sanitizeShippingCoAddress(shippingAddress || {});
  if (!isShippingCoAddressComplete(receiverAddress)) {
    throw makeHttpError(
      'Add your delivery address in Settings before purchasing marketplace listings.',
      409,
      'BUYER_ADDRESS_INCOMPLETE',
    );
  }

  const normalizedItems = normalizeItems(rawItems);
  const listingItems = normalizedItems.filter((item) => item.listingId);
  if (!listingItems.length) {
    return {
      currency: 'GBP',
      shippingAddress: receiverAddress,
      subtotalAmount: 0,
      shippingAmount: 0,
      totalAmount: 0,
      items: [],
    };
  }

  const uniqueListingIds = Array.from(new Set(listingItems.map((item) => item.listingId).filter(Boolean)));
  const listingSnaps = await Promise.all(
    uniqueListingIds.map((listingId) => db.collection('listings').doc(listingId).get())
  );

  const listingById = new Map();
  const unavailable = [];
  const sellerIds = new Set();

  listingSnaps.forEach((snap) => {
    if (!snap.exists) {
      unavailable.push({ listingId: snap.id, reason: 'not-found' });
      return;
    }
    const listing = snap.data() || {};
    const status = cleanString(listing?.status || '', 40).toLowerCase();
    if (status && !['active', 'live', 'published'].includes(status)) {
      unavailable.push({ listingId: snap.id, reason: status });
      return;
    }
    const sellerUid = cleanString(listing?.sellerUid || '', 128);
    if (!sellerUid) {
      unavailable.push({ listingId: snap.id, reason: 'missing-seller-uid' });
      return;
    }
    listingById.set(snap.id, listing);
    sellerIds.add(sellerUid);
  });

  if (unavailable.length) {
    const labels = unavailable.map((it) => `${it.listingId}:${it.reason}`).join(',');
    throw new Error(`unavailable-listings:${labels}`);
  }

  const sellerSnaps = await Promise.all(
    Array.from(sellerIds).map((sellerUid) => db.collection('users').doc(sellerUid).get())
  );
  const sellerByUid = new Map();
  sellerSnaps.forEach((snap) => {
    if (!snap.exists) return;
    sellerByUid.set(snap.id, snap.data() || {});
  });

  const items = await Promise.all(
    listingItems.map(async (item) => {
      const listing = listingById.get(item.listingId) || {};
      const title = cleanString(listing?.title || item.title || 'Listing', 160) || 'Listing';
      const sellerUid = cleanString(listing?.sellerUid || '', 128);
      const seller = sellerByUid.get(sellerUid) || {};
      const senderAddress = sanitizeShippingCoAddress(seller?.shippingAddress || {});

      if (!isShippingCoAddressComplete(senderAddress)) {
        throw makeHttpError(
          `Seller address is incomplete for ${title}. Ask the seller to update their delivery address in Settings.`,
          409,
          'SELLER_ADDRESS_INCOMPLETE',
        );
      }

      const parcelProfile = inferParcelProfileFromListing(listing);
      const qty = Math.max(1, Math.round(Number(item?.qty) || 1));
      const unitAmount = resolveListingUnitAmount(listing, item?.unitAmount);
      const itemAmount = Math.max(0, unitAmount * qty);
      const quote = await quoteShippingCoShipment(
        shippingCoConfig,
        parcelProfile,
        senderAddress,
        receiverAddress,
      );

      return {
        listingId: item.listingId,
        title,
        qty,
        unitAmount,
        itemAmount,
        parcelProfile,
        parcelLabel: formatParcelProfileLabel(parcelProfile),
        amount: Math.max(0, Math.round(Number(quote?.amount) || 0)),
        rate: cleanString(quote?.rate || '', 40) || null,
        currency: cleanString(quote?.currency || 'GBP', 12).toUpperCase() || 'GBP',
        provider: cleanString(quote?.provider || 'fixed', 40) || 'fixed',
        providerMode: cleanString(quote?.providerMode || 'fixed', 20) || 'fixed',
        carrier: cleanString(quote?.carrier || 'ShippingCo', 80) || 'ShippingCo',
        service: cleanString(quote?.service || 'ShippingCo', 120) || 'ShippingCo',
        displayLabel: cleanString(quote?.displayLabel || 'ShippingCo', 80) || 'ShippingCo',
        isFallback: Boolean(quote?.isFallback),
      };
    })
  );

  const subtotalAmount = items.reduce((sum, item) => sum + item.itemAmount, 0);
  const shippingAmount = items.reduce((sum, item) => sum + item.amount, 0);

  return {
    currency: 'GBP',
    shippingAddress: receiverAddress,
    subtotalAmount,
    shippingAmount,
    totalAmount: subtotalAmount + shippingAmount,
    items,
  };
}

async function persistCheckoutQuoteRecord({
  quoteId,
  buyerUid,
  source,
  quote,
  stripePaymentIntentId = null,
  checkoutSessionId = null,
}) {
  const cleanQuoteId = quoteDocId(quoteId);
  if (!cleanQuoteId) return;

  const db = getDb();
  if (!db) {
    throw new Error('Firestore Admin is not initialized.');
  }

  const publicQuote = toPublicShippingQuote(quote);
  await db.collection('checkoutQuotes').doc(cleanQuoteId).set(
    {
      quoteId: cleanQuoteId,
      buyerUid: cleanString(buyerUid || '', 128) || null,
      source: cleanString(source || '', 80) || null,
      currency: publicQuote.currency,
      subtotalAmount: publicQuote.subtotalAmount,
      shippingAmount: publicQuote.shippingAmount,
      totalAmount: publicQuote.totalAmount,
      shippingAddress: toShippingSnapshot(quote?.shippingAddress || {}),
      items: publicQuote.items.map((item) => ({
        listingId: item.listingId,
        title: item.title,
        parcelProfile: item.parcelProfile,
        parcelLabel: item.parcelLabel || formatParcelProfileLabel(item.parcelProfile),
        qty: item.qty,
        unitAmount: item.unitAmount,
        itemAmount: item.itemAmount,
        shippingAmount: item.amount,
        amount: item.amount,
        currency: item.currency,
        carrier: item.carrier,
        service: item.service,
        rate: item.rate || null,
        provider: item.provider,
        providerMode: item.providerMode,
        displayLabel: item.displayLabel,
        isFallback: item.isFallback,
      })),
      stripePaymentIntentId: cleanString(stripePaymentIntentId || '', 120) || null,
      checkoutSessionId: cleanString(checkoutSessionId || '', 120) || null,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function loadCheckoutQuoteRecord(quoteId) {
  const cleanQuoteId = quoteDocId(quoteId);
  if (!cleanQuoteId) return null;

  const db = getDb();
  if (!db) {
    throw new Error('Firestore Admin is not initialized.');
  }

  const snap = await db.collection('checkoutQuotes').doc(cleanQuoteId).get();
  if (!snap.exists) return null;
  return snap.data() || null;
}

function buildSandboxStatusPatch(order = {}, phase = '') {
  const patch = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (phase === 'label_created') {
    return patch;
  }

  if (phase === 'in_transit') {
    if (!['shipped', 'out_for_delivery', 'delivered', 'completed'].includes(normalizeOrderStatus(order?.status))) {
      patch.status = 'shipped';
    }
    if (!order?.shippedAt) {
      patch.shippedAt = FieldValue.serverTimestamp();
    }
    return patch;
  }

  if (phase === 'out_for_delivery') {
    patch.status = 'out_for_delivery';
    if (!order?.shippedAt) patch.shippedAt = FieldValue.serverTimestamp();
    if (!order?.outForDeliveryAt) patch.outForDeliveryAt = FieldValue.serverTimestamp();
    return patch;
  }

  if (phase === 'delivered') {
    patch.status = 'delivered';
    if (!order?.shippedAt) patch.shippedAt = FieldValue.serverTimestamp();
    if (!order?.outForDeliveryAt) patch.outForDeliveryAt = FieldValue.serverTimestamp();
    if (!order?.deliveredAt) patch.deliveredAt = FieldValue.serverTimestamp();
    return patch;
  }

  return patch;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolvePublicOrigin(req) {
  const explicit = cleanString(runtimeConfig.publicBaseUrl || '', 300);
  if (explicit) return explicit.replace(/\/+$/, '');

  const proto =
    cleanString(req.headers['x-forwarded-proto'] || '', 16) ||
    (req.secure ? 'https' : 'http');
  const host = cleanString(req.headers['x-forwarded-host'] || req.headers.host || '', 260);
  if (!host) return '';
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function buildCheckoutRedirectUrls(req) {
  const baseOrigin = resolvePublicOrigin(req);
  const success = baseOrigin
    ? `${baseOrigin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`
    : 'https://example.com/success?session_id={CHECKOUT_SESSION_ID}';
  const cancel = baseOrigin ? `${baseOrigin}/checkout/cancel` : 'https://example.com/cancel';
  return { success, cancel };
}

const confirmCheckoutSessionAndFulfill = createConfirmCheckoutSessionAndFulfill({
  stripe,
  fulfillPaidListings,
  parseItemsFromMetadata,
  parseQuoteIdFromMetadata,
  parseShippingFromMetadata,
  formatDisplayOrderNumber,
  cleanString,
});

function resolveOrderListingId(order) {
  return cleanString(
    order?.listingId || order?.listing?.id || order?.items?.[0]?.listingId || '',
    180
  );
}

function notificationDocId(...parts) {
  return parts
    .map((part) => cleanString(part || '', 160))
    .filter(Boolean)
    .join('__')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 180);
}

function extractListingNotificationImage(data = {}) {
  return (
    cleanString(data?.primeImage?.url || '', 2000) ||
    cleanString(data?.coverImage?.url || '', 2000) ||
    cleanString(data?.image?.url || '', 2000) ||
    cleanString(data?.listingImageUrl || '', 2000) ||
    cleanString(data?.imageUrl || '', 2000) ||
    cleanString(data?.thumbnailUrl || '', 2000) ||
    cleanString(data?.photos?.[0]?.url || '', 2000) ||
    cleanString(data?.images?.[0]?.url || '', 2000) ||
    cleanString(data?.items?.[0]?.image || '', 2000) ||
    cleanString(data?.items?.[0]?.imageUrl || '', 2000) ||
    null
  );
}

function extractPostNotificationImage(data = {}) {
  const first = Array.isArray(data?.images) ? data.images[0] : null;
  return (
    cleanString(typeof first === 'string' ? first : first?.url || '', 2000) ||
    cleanString(data?.image?.url || '', 2000) ||
    cleanString(data?.imageUrl || '', 2000) ||
    cleanString(data?.thumbnailUrl || '', 2000) ||
    null
  );
}

function buildActorSnapshot(uid, data = {}) {
  return {
    actorUid: cleanString(uid || '', 128) || null,
    actorUsername: cleanString(data?.username || '', 80) || null,
    actorDisplayName:
      cleanString(data?.displayName || data?.username || '', 120) || null,
    actorPhotoURL:
      cleanString(data?.photoURL || data?.avatarUri || data?.avatarURL || '', 2000) || null,
  };
}

async function loadActorSnapshot(db, actorUid) {
  const cleanActorUid = cleanString(actorUid || '', 128);
  if (!cleanActorUid) return buildActorSnapshot('', {});
  try {
    const snap = await db.collection('users').doc(cleanActorUid).get();
    return buildActorSnapshot(cleanActorUid, snap.exists ? snap.data() || {} : {});
  } catch {
    return buildActorSnapshot(cleanActorUid, {});
  }
}

function notificationTextSnippet(text, maxLen = 84) {
  const clean = cleanString(String(text || '').replace(/\s+/g, ' '), maxLen + 1);
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen).trimEnd()}...` : clean;
}

async function ensureNotificationDoc(notifRef, payload) {
  const existing = await notifRef.get();
  if (existing.exists) {
    return { created: false, skipped: 'exists' };
  }
  await notifRef.set(payload);
  return { created: true };
}

async function cancelOrderAndReactivateListing({ orderId, actorUid, role }) {
  const db = getDb();
  if (!db) {
    throw new Error('Firestore Admin is not initialized.');
  }

  const cleanOrderId = cleanString(orderId || '', 180);
  const cleanActorUid = cleanString(actorUid || '', 128);
  const cleanRole = role === 'seller' ? 'seller' : 'buyer';

  if (!cleanOrderId) {
    const error = new Error('ORDER_ID_REQUIRED');
    error.code = 'ORDER_ID_REQUIRED';
    throw error;
  }

  if (!cleanActorUid) {
    const error = new Error('AUTH_REQUIRED');
    error.code = 'AUTH_REQUIRED';
    throw error;
  }

  return db.runTransaction(async (tx) => {
    const orderRef = db.collection('orders').doc(cleanOrderId);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) {
      const error = new Error('ORDER_NOT_FOUND');
      error.code = 'ORDER_NOT_FOUND';
      throw error;
    }

    const order = orderSnap.data() || {};
    const currentStatus = normalizeOrderStatus(order?.status);
    const buyerUid = cleanString(order?.buyerUid || '', 128);
    const sellerUid = cleanString(order?.sellerUid || '', 128);

    if (cleanRole === 'buyer' && buyerUid && buyerUid !== cleanActorUid) {
      const error = new Error('ORDER_ROLE_MISMATCH');
      error.code = 'ORDER_ROLE_MISMATCH';
      throw error;
    }

    if (cleanRole === 'seller' && sellerUid && sellerUid !== cleanActorUid) {
      const error = new Error('ORDER_ROLE_MISMATCH');
      error.code = 'ORDER_ROLE_MISMATCH';
      throw error;
    }

    if (!['paid', 'pending_delivery'].includes(currentStatus) || orderHasShipmentProgress(order)) {
      const error = new Error('ORDER_NOT_CANCELLABLE');
      error.code = 'ORDER_NOT_CANCELLABLE';
      throw error;
    }

    const nextStatus = cleanRole === 'seller' ? 'cancelled_by_seller' : 'cancelled_by_buyer';
    const now = FieldValue.serverTimestamp();

    const listingId = resolveOrderListingId(order);
    let listingReactivated = false;

    if (!listingId) {
      tx.update(orderRef, {
        status: nextStatus,
        cancelledAt: now,
        cancelledBy: cleanRole,
        cancelledByUid: cleanActorUid,
        updatedAt: now,
      });
      return {
        ok: true,
        status: nextStatus,
        orderId: cleanOrderId,
        listingId: null,
        listingReactivated: false,
      };
    }

    const listingRef = db.collection('listings').doc(listingId);
    const listingSnap = await tx.get(listingRef);

    if (listingSnap.exists) {
      const listing = listingSnap.data() || {};
      const listingStatus = cleanString(listing?.status || '', 40).toLowerCase();
      const listingSoldToUid = cleanString(listing?.soldToUid || '', 128);
      const listingSellerUid = cleanString(listing?.sellerUid || '', 128);
      const buyerMatches = !buyerUid || !listingSoldToUid || listingSoldToUid === buyerUid;
      const sellerMatches = !sellerUid || !listingSellerUid || listingSellerUid === sellerUid;

      if (listingStatus === 'sold' && buyerMatches && sellerMatches) {
        tx.update(listingRef, {
          status: 'active',
          updatedAt: now,
          soldAt: FieldValue.delete(),
          soldToUid: FieldValue.delete(),
          soldPaymentRef: FieldValue.delete(),
          soldSource: FieldValue.delete(),
        });
        listingReactivated = true;
      }
    }

    if (sellerUid) {
      const saleNotifRef = db
        .collection('users')
        .doc(sellerUid)
        .collection('notifications')
        .doc(notificationDocId('sale', cleanOrderId));
      tx.delete(saleNotifRef);
    }

    tx.update(orderRef, {
      status: nextStatus,
      cancelledAt: now,
      cancelledBy: cleanRole,
      cancelledByUid: cleanActorUid,
      updatedAt: now,
    });

    return {
      ok: true,
      status: nextStatus,
      orderId: cleanOrderId,
      listingId,
      listingReactivated,
    };
  });
}

async function upsertNotificationEvent({
  type,
  actorUid,
  enabled,
  targetUid = '',
  listingId = '',
  postId = '',
  commentText = '',
  commentEventId = '',
  parentCommentId = '',
}) {
  const db = getDb();
  if (!db) {
    throw new Error('Firestore Admin is not initialized.');
  }

  const cleanType = cleanString(type || '', 40).toLowerCase();
  const cleanActorUid = cleanString(actorUid || '', 128);

  if (!cleanActorUid) {
    const error = new Error('AUTH_REQUIRED');
    error.code = 'AUTH_REQUIRED';
    throw error;
  }

  const actor = await loadActorSnapshot(db, cleanActorUid);

  if (cleanType === 'follow') {
    const recipientUid = cleanString(targetUid || '', 128);
    if (!recipientUid || recipientUid === cleanActorUid) {
      return { ok: true, skipped: 'self-or-missing-recipient' };
    }
    const notifRef = db
      .collection('users')
      .doc(recipientUid)
      .collection('notifications')
      .doc(notificationDocId('follow', cleanActorUid));
    if (!enabled) {
      await notifRef.delete().catch(() => {});
      return { ok: true, deleted: true };
    }
    await notifRef.set({
      type: 'follow',
      read: false,
      createdAt: FieldValue.serverTimestamp(),
      title: actor.actorDisplayName || actor.actorUsername || 'Someone',
      body: 'started following you.',
      imageUri: actor.actorPhotoURL,
      targetId: recipientUid,
      targetType: 'user',
      ...actor,
    });
    return { ok: true };
  }

  if (cleanType === 'listing_like') {
    const cleanListingId = cleanString(listingId || '', 180);
    if (!cleanListingId) {
      const error = new Error('LISTING_ID_REQUIRED');
      error.code = 'LISTING_ID_REQUIRED';
      throw error;
    }
    const listingSnap = await db.collection('listings').doc(cleanListingId).get();
    if (!listingSnap.exists) return { ok: true, skipped: 'listing-not-found' };
    const listing = listingSnap.data() || {};
    const recipientUid = cleanString(listing?.sellerUid || '', 128);
    if (!recipientUid || recipientUid === cleanActorUid) {
      return { ok: true, skipped: 'self-or-missing-recipient' };
    }
    const notifRef = db
      .collection('users')
      .doc(recipientUid)
      .collection('notifications')
      .doc(notificationDocId('listing_like', cleanListingId, cleanActorUid));
    if (!enabled) {
      await notifRef.delete().catch(() => {});
      return { ok: true, deleted: true };
    }
    const listingTitle = cleanString(listing?.title || listing?.name || 'your listing', 160);
    await notifRef.set({
      type: 'listing_like',
      read: false,
      createdAt: FieldValue.serverTimestamp(),
      title: actor.actorDisplayName || actor.actorUsername || 'Someone',
      body: `liked your listing${listingTitle ? `: ${listingTitle}` : '.'}`,
      imageUri: extractListingNotificationImage(listing),
      targetId: cleanListingId,
      targetType: 'listing',
      listingId: cleanListingId,
      ...actor,
    });
    return { ok: true };
  }

  if (cleanType === 'post_like') {
    const cleanPostId = cleanString(postId || '', 180);
    if (!cleanPostId) {
      const error = new Error('POST_ID_REQUIRED');
      error.code = 'POST_ID_REQUIRED';
      throw error;
    }
    const postSnap = await db.collection('posts').doc(cleanPostId).get();
    if (!postSnap.exists) return { ok: true, skipped: 'post-not-found' };
    const post = postSnap.data() || {};
    const recipientUid = cleanString(post?.authorUid || '', 128);
    if (!recipientUid || recipientUid === cleanActorUid) {
      return { ok: true, skipped: 'self-or-missing-recipient' };
    }
    const notifRef = db
      .collection('users')
      .doc(recipientUid)
      .collection('notifications')
      .doc(notificationDocId('post_like', cleanPostId, cleanActorUid));
    if (!enabled) {
      await notifRef.delete().catch(() => {});
      return { ok: true, deleted: true };
    }
    const caption = cleanString(post?.caption || '', 120);
    await notifRef.set({
      type: 'post_like',
      read: false,
      createdAt: FieldValue.serverTimestamp(),
      title: actor.actorDisplayName || actor.actorUsername || 'Someone',
      body: caption ? `liked your post: ${caption}` : 'liked your post.',
      imageUri: extractPostNotificationImage(post),
      targetId: cleanPostId,
      targetType: 'post',
      postId: cleanPostId,
      ...actor,
    });
    return { ok: true };
  }

  if (cleanType === 'post_comment') {
    const cleanPostId = cleanString(postId || '', 180);
    const cleanCommentEventId = cleanString(commentEventId || '', 180);
    const cleanParentCommentId = cleanString(parentCommentId || '', 180);
    if (!cleanPostId) {
      const error = new Error('POST_ID_REQUIRED');
      error.code = 'POST_ID_REQUIRED';
      throw error;
    }
    if (!cleanCommentEventId) {
      const error = new Error('COMMENT_ID_REQUIRED');
      error.code = 'COMMENT_ID_REQUIRED';
      throw error;
    }
    const postSnap = await db.collection('posts').doc(cleanPostId).get();
    if (!postSnap.exists) return { ok: true, skipped: 'post-not-found' };
    const post = postSnap.data() || {};
    let recipientUid = cleanString(post?.authorUid || '', 128);
    let isReplyToComment = false;

    if (cleanParentCommentId) {
      const parentCommentSnap = await db
        .collection('posts')
        .doc(cleanPostId)
        .collection('comments')
        .doc(cleanParentCommentId)
        .get()
        .catch(() => null);
      const parentComment = parentCommentSnap?.exists ? parentCommentSnap.data() || {} : null;
      const parentAuthorUid = cleanString(parentComment?.authorUid || '', 128);
      if (parentAuthorUid && parentAuthorUid !== cleanActorUid) {
        recipientUid = parentAuthorUid;
        isReplyToComment = true;
      }
    }

    if (!recipientUid || recipientUid === cleanActorUid) {
      return { ok: true, skipped: 'self-or-missing-recipient' };
    }

    const notifRef = db
      .collection('users')
      .doc(recipientUid)
      .collection('notifications')
      .doc(notificationDocId('post_comment', cleanPostId, cleanCommentEventId));

    if (!enabled) {
      await notifRef.delete().catch(() => {});
      return { ok: true, deleted: true };
    }

    const snippet = notificationTextSnippet(commentText, 72);
    await notifRef.set({
      type: 'post_comment',
      read: false,
      createdAt: FieldValue.serverTimestamp(),
      title: actor.actorDisplayName || actor.actorUsername || 'Someone',
      body: isReplyToComment
        ? snippet
          ? `replied to your comment: ${snippet}`
          : 'replied to your comment.'
        : snippet
          ? `commented on your post: ${snippet}`
          : 'commented on your post.',
      imageUri: extractPostNotificationImage(post),
      targetId: cleanPostId,
      targetType: 'post',
      postId: cleanPostId,
      commentId: cleanCommentEventId,
      ...actor,
    });
    return { ok: true };
  }

  const error = new Error('UNSUPPORTED_NOTIFICATION_TYPE');
  error.code = 'UNSUPPORTED_NOTIFICATION_TYPE';
  throw error;
}

async function backfillNotificationsForUser(recipientUid) {
  const db = getDb();
  if (!db) {
    throw new Error('Firestore Admin is not initialized.');
  }

  const cleanRecipientUid = cleanString(recipientUid || '', 128);
  if (!cleanRecipientUid) {
    const error = new Error('AUTH_REQUIRED');
    error.code = 'AUTH_REQUIRED';
    throw error;
  }

  const actorCache = new Map();
  const loadCachedActor = async (uid) => {
    const cleanUid = cleanString(uid || '', 128);
    if (!cleanUid) return buildActorSnapshot('', {});
    if (actorCache.has(cleanUid)) return actorCache.get(cleanUid);
    const actor = await loadActorSnapshot(db, cleanUid);
    actorCache.set(cleanUid, actor);
    return actor;
  };

  const stats = {
    created: 0,
    follows: 0,
    sales: 0,
    listingLikes: 0,
    postLikes: 0,
    comments: 0,
  };

  const noteCreate = (bucket) => {
    stats.created += 1;
    stats[bucket] += 1;
  };

  const followersSnap = await db
    .collection('users')
    .doc(cleanRecipientUid)
    .collection('followers')
    .limit(80)
    .get();

  for (const followerDoc of followersSnap.docs) {
    const actorUid = cleanString(followerDoc.id || '', 128);
    if (!actorUid || actorUid === cleanRecipientUid) continue;
    const actor = await loadCachedActor(actorUid);
    const notifRef = db
      .collection('users')
      .doc(cleanRecipientUid)
      .collection('notifications')
      .doc(notificationDocId('follow', actorUid));
    const created = await ensureNotificationDoc(notifRef, {
      type: 'follow',
      read: false,
      createdAt: followerDoc.data()?.createdAt || FieldValue.serverTimestamp(),
      title: actor.actorDisplayName || actor.actorUsername || 'Someone',
      body: 'started following you.',
      imageUri: actor.actorPhotoURL,
      targetId: cleanRecipientUid,
      targetType: 'user',
      ...actor,
    });
    if (created.created) noteCreate('follows');
  }

  const soldOrdersSnap = await db
    .collection('orders')
    .where('sellerUid', '==', cleanRecipientUid)
    .limit(80)
    .get();

  for (const orderDoc of soldOrdersSnap.docs) {
    const order = orderDoc.data() || {};
    const status = normalizeOrderStatus(order?.status);
    if (status.startsWith('cancelled')) continue;
    const buyerUid = cleanString(order?.buyerUid || '', 128);
    if (!buyerUid || buyerUid === cleanRecipientUid) continue;
    const actor = await loadCachedActor(buyerUid);
    const listingTitle = cleanString(
      order?.listing?.title || order?.items?.[0]?.title || 'Listing',
      160
    );
    const listingId = resolveOrderListingId(order);
    const notifRef = db
      .collection('users')
      .doc(cleanRecipientUid)
      .collection('notifications')
      .doc(notificationDocId('sale', orderDoc.id));
    const created = await ensureNotificationDoc(notifRef, {
      type: 'sale',
      read: false,
      createdAt: order?.paidAt || order?.createdAt || FieldValue.serverTimestamp(),
      title: actor.actorDisplayName || actor.actorUsername || 'Someone',
      body: `bought your item: ${listingTitle}`,
      imageUri: extractListingNotificationImage(order?.listing || order),
      targetId: orderDoc.id,
      targetType: 'order',
      orderId: orderDoc.id,
      listingId: listingId || null,
      ...actor,
    });
    if (created.created) noteCreate('sales');
  }

  const ownedListingsSnap = await db
    .collection('listings')
    .where('sellerUid', '==', cleanRecipientUid)
    .limit(80)
    .get();

  for (const listingDoc of ownedListingsSnap.docs) {
    const listing = listingDoc.data() || {};
    const listingTitle = cleanString(listing?.title || listing?.name || 'your listing', 160);
    const likersSnap = await listingDoc.ref.collection('likers').limit(80).get();
    for (const likerDoc of likersSnap.docs) {
      const actorUid = cleanString(likerDoc.id || '', 128);
      if (!actorUid || actorUid === cleanRecipientUid) continue;
      const actor = await loadCachedActor(actorUid);
      const notifRef = db
        .collection('users')
        .doc(cleanRecipientUid)
        .collection('notifications')
        .doc(notificationDocId('listing_like', listingDoc.id, actorUid));
      const created = await ensureNotificationDoc(notifRef, {
        type: 'listing_like',
        read: false,
        createdAt: likerDoc.data()?.createdAt || FieldValue.serverTimestamp(),
        title: actor.actorDisplayName || actor.actorUsername || 'Someone',
        body: `liked your listing${listingTitle ? `: ${listingTitle}` : '.'}`,
        imageUri: extractListingNotificationImage(listing),
        targetId: listingDoc.id,
        targetType: 'listing',
        listingId: listingDoc.id,
        ...actor,
      });
      if (created.created) noteCreate('listingLikes');
    }
  }

  const authoredPostsSnap = await db
    .collection('posts')
    .where('authorUid', '==', cleanRecipientUid)
    .limit(80)
    .get();

  for (const postDoc of authoredPostsSnap.docs) {
    const post = postDoc.data() || {};
    const postCaption = cleanString(post?.caption || '', 120);
    const postImage = extractPostNotificationImage(post);

    const likersSnap = await postDoc.ref.collection('likers').limit(80).get();
    for (const likerDoc of likersSnap.docs) {
      const actorUid = cleanString(likerDoc.id || '', 128);
      if (!actorUid || actorUid === cleanRecipientUid) continue;
      const actor = await loadCachedActor(actorUid);
      const notifRef = db
        .collection('users')
        .doc(cleanRecipientUid)
        .collection('notifications')
        .doc(notificationDocId('post_like', postDoc.id, actorUid));
      const created = await ensureNotificationDoc(notifRef, {
        type: 'post_like',
        read: false,
        createdAt: likerDoc.data()?.createdAt || FieldValue.serverTimestamp(),
        title: actor.actorDisplayName || actor.actorUsername || 'Someone',
        body: postCaption ? `liked your post: ${postCaption}` : 'liked your post.',
        imageUri: postImage,
        targetId: postDoc.id,
        targetType: 'post',
        postId: postDoc.id,
        ...actor,
      });
      if (created.created) noteCreate('postLikes');
    }

    const commentsSnap = await postDoc.ref.collection('comments').limit(80).get();
    for (const commentDoc of commentsSnap.docs) {
      const comment = commentDoc.data() || {};
      const commentActorUid = cleanString(comment?.authorUid || '', 128);
      if (commentActorUid && commentActorUid !== cleanRecipientUid) {
        const actor = await loadCachedActor(commentActorUid);
        const snippet = notificationTextSnippet(comment?.text, 72);
        const notifRef = db
          .collection('users')
          .doc(cleanRecipientUid)
          .collection('notifications')
          .doc(notificationDocId('post_comment', postDoc.id, commentDoc.id));
        const created = await ensureNotificationDoc(notifRef, {
          type: 'post_comment',
          read: false,
          createdAt: comment?.createdAt || FieldValue.serverTimestamp(),
          title: actor.actorDisplayName || actor.actorUsername || 'Someone',
          body: snippet ? `commented on your post: ${snippet}` : 'commented on your post.',
          imageUri: postImage,
          targetId: postDoc.id,
          targetType: 'post',
          postId: postDoc.id,
          commentId: commentDoc.id,
          ...actor,
        });
        if (created.created) noteCreate('comments');
      }

      const repliesSnap = await commentDoc.ref.collection('replies').limit(80).get();
      for (const replyDoc of repliesSnap.docs) {
        const reply = replyDoc.data() || {};
        const replyActorUid = cleanString(reply?.authorUid || '', 128);
        if (!replyActorUid || replyActorUid === cleanRecipientUid) continue;
        const actor = await loadCachedActor(replyActorUid);
        const snippet = notificationTextSnippet(reply?.text, 72);
        const notifRef = db
          .collection('users')
          .doc(cleanRecipientUid)
          .collection('notifications')
          .doc(notificationDocId('post_comment', postDoc.id, `reply_${replyDoc.id}`));
        const created = await ensureNotificationDoc(notifRef, {
          type: 'post_comment',
          read: false,
          createdAt: reply?.createdAt || FieldValue.serverTimestamp(),
          title: actor.actorDisplayName || actor.actorUsername || 'Someone',
          body: snippet
            ? `replied on your post: ${snippet}`
            : 'replied on your post.',
          imageUri: postImage,
          targetId: postDoc.id,
          targetType: 'post',
          postId: postDoc.id,
          commentId: replyDoc.id,
          ...actor,
        });
        if (created.created) noteCreate('comments');
      }
    }
  }

  return { ok: true, ...stats };
}

async function assertListingsPurchasable(items) {
  const db = getDb();
  if (!db) return;

  const listingIds = Array.from(
    new Set(
      items
        .map((item) => cleanString(item?.listingId || '', 160))
        .filter(Boolean)
    )
  );
  if (!listingIds.length) return;

  const snaps = await Promise.all(
    listingIds.map((listingId) => db.collection('listings').doc(listingId).get())
  );

  const unavailable = [];
  snaps.forEach((snap) => {
    if (!snap.exists) {
      unavailable.push({ listingId: snap.id, reason: 'not-found' });
      return;
    }
    const status = cleanString(snap.data()?.status || '', 40).toLowerCase();
    if (status && !['active', 'live', 'published'].includes(status)) {
      unavailable.push({ listingId: snap.id, reason: status });
    }
  });

  if (unavailable.length) {
    const labels = unavailable.map((it) => `${it.listingId}:${it.reason}`).join(',');
    throw new Error(`unavailable-listings:${labels}`);
  }
}

async function fulfillPaidListings({
  paymentRef,
  stripePaymentIntentId = null,
  buyerUid,
  quoteId = null,
  rawItems,
  source,
  shippingAddress = null,
}) {
  const db = getDb();
  if (!db) {
    throw new Error('Firestore Admin is not initialized.');
  }

  const cleanBuyerUid = cleanString(buyerUid || '', 128) || 'guest_checkout';
  const quoteRecord = quoteId ? await loadCheckoutQuoteRecord(quoteId) : null;
  const shipping = sanitizeShippingAddress(
    quoteRecord?.shippingAddress || shippingAddress || {},
  );

  const normalized = normalizeItems(rawItems);
  const listingItems = normalized.filter((it) => it.listingId);
  if (!listingItems.length) {
    return {
      processed: 0,
      skipped: 0,
      results: [],
    };
  }

  const uniqueByListing = [];
  const seen = new Set();
  for (const item of listingItems) {
    if (seen.has(item.listingId)) continue;
    seen.add(item.listingId);
    uniqueByListing.push(item);
  }

  const quoteItemsByListingId = new Map(
    Array.isArray(quoteRecord?.items)
      ? quoteRecord.items
          .map((item) => [cleanString(item?.listingId || '', 180), item])
          .filter(([listingId]) => Boolean(listingId))
      : [],
  );

  const results = [];
  for (const item of uniqueByListing) {
    const listingId = item.listingId;
    const listingRef = db.collection('listings').doc(listingId);
    const orderRef = db.collection('orders').doc(orderDocId(paymentRef, listingId));
    const buyerRef =
      cleanBuyerUid && cleanBuyerUid !== 'guest_checkout'
        ? db.collection('users').doc(cleanBuyerUid)
        : null;
    try {
      await db.runTransaction(async (tx) => {
        const [orderSnap, listingSnap, buyerSnap] = await Promise.all([
          tx.get(orderRef),
          tx.get(listingRef),
          buyerRef ? tx.get(buyerRef) : Promise.resolve(null),
        ]);
        if (orderSnap.exists) {
          return;
        }
        if (!listingSnap.exists) {
          throw new Error('listing-not-found');
        }

        const listing = listingSnap.data() || {};
        const opportunity = validateFulfillmentOpportunity({
          orderExists: orderSnap.exists,
          listingExists: listingSnap.exists,
          listingStatus: listing?.status,
          sellerUid: listing?.sellerUid,
          cleanString,
        });
        if (opportunity.duplicate) {
          return;
        }

        const sellerUid = opportunity.sellerUid;

        const unitAmount =
          Number.isFinite(Number(listing?.price?.amount)) && Number(listing?.price?.amount) > 0
            ? Math.round(Number(listing.price.amount))
            : item.unitAmount;
        const currency = resolveListingCurrency(listing, 'GBP');
        const qty = Math.max(1, item.qty || 1);
        const quoteItem = quoteItemsByListingId.get(listingId) || null;
        const parcelProfile =
          normalizeParcelProfile(quoteItem?.parcelProfile) || inferParcelProfileFromListing(listing);
        const subtotalAmount = Math.max(
          0,
          Math.round(Number(quoteItem?.itemAmount) || unitAmount * qty),
        );
        const shippingAmount = Math.max(
          0,
          Math.round(Number(quoteItem?.shippingAmount ?? quoteItem?.amount) || 0),
        );
        const shippingCurrency =
          cleanString(quoteItem?.currency || currency, 12).toUpperCase() || currency;
        const totalAmount = subtotalAmount + shippingAmount;
        const now = FieldValue.serverTimestamp();
        const buyerActor = buildActorSnapshot(
          cleanBuyerUid,
          buyerSnap && buyerSnap.exists ? buyerSnap.data() || {} : {}
        );
        const saleNotifRef = db
          .collection('users')
          .doc(sellerUid)
          .collection('notifications')
          .doc(notificationDocId('sale', orderRef.id));

        tx.update(listingRef, {
          status: 'sold',
          updatedAt: now,
          soldAt: now,
          soldToUid: cleanBuyerUid,
          soldPaymentRef: paymentRef,
          soldSource: source || 'stripe',
        });

        tx.set(orderRef, {
          buyerUid: cleanBuyerUid,
          sellerUid,
          listingId,
          qty,
          status: 'paid',
          source: source || 'stripe',
          stripePaymentRef: paymentRef,
          stripePaymentIntentId: stripePaymentIntentId || null,
          checkoutQuoteId: cleanString(quoteId || '', 180) || null,
          subtotal: {
            amount: subtotalAmount,
            currency,
          },
          shippingTotal: {
            amount: shippingAmount,
            currency: shippingCurrency,
          },
          total: {
            amount: totalAmount,
            currency: currency || 'USD',
          },
          amount: totalAmount,
          shippingName: shipping.name || null,
          buyerName: shipping.name || null,
          shipping: {
            name: shipping.name || null,
            carrierName: cleanString(quoteItem?.carrier || 'ShippingCo', 80) || 'ShippingCo',
            parcelProfile,
            parcelLabel: formatParcelProfileLabel(parcelProfile) || null,
            quote: {
              carrier: cleanString(quoteItem?.carrier || 'ShippingCo', 80) || 'ShippingCo',
              service: cleanString(quoteItem?.service || 'ShippingCo', 120) || 'ShippingCo',
              rate: cleanString(quoteItem?.rate || '', 40) || null,
              currency: shippingCurrency,
              amount: shippingAmount,
              provider: cleanString(quoteItem?.provider || (shippingAmount ? 'fixed' : ''), 40) || null,
              providerMode: cleanString(quoteItem?.providerMode || 'fixed', 20) || 'fixed',
              displayLabel: cleanString(quoteItem?.displayLabel || '', 80) || null,
            },
            receiver: toShippingSnapshot(shipping, {
              source: 'order_checkout',
              uid: cleanBuyerUid === 'guest_checkout' ? null : cleanBuyerUid,
            }),
            address: {
              line1: shipping.line1 || null,
              line2: shipping.line2 || null,
              city: shipping.city || null,
              state: shipping.region || null,
              postal_code: shipping.postalCode || null,
              country: shipping.country || null,
            },
          },
          listingImageUrl:
            cleanString(listing?.primeImage?.url || item.imageUrl || '', 2000) || null,
          listing: {
            id: listingId,
            title: cleanString(listing?.title || item.title || 'Listing', 160),
            primeImage: listing?.primeImage || {
              url: cleanString(item.imageUrl || '', 2000) || null,
            },
            price: listing?.price || {
              amount: Math.max(0, unitAmount),
              currency: currency || 'USD',
            },
            parcelProfile,
          },
          items: [
            {
              listingId,
              title: cleanString(listing?.title || item.title || 'Listing', 160),
              image:
                cleanString(listing?.primeImage?.url || item.imageUrl || '', 2000) || null,
              imageUrl:
                cleanString(listing?.primeImage?.url || item.imageUrl || '', 2000) || null,
              amount: Math.max(0, unitAmount),
              subtotalAmount,
              shippingAmount,
              currency: currency || 'USD',
              qty,
              parcelProfile,
            },
          ],
          createdAt: now,
          updatedAt: now,
          paidAt: now,
        });

        if (sellerUid && sellerUid !== cleanBuyerUid) {
          tx.set(saleNotifRef, {
            type: 'sale',
            read: false,
            createdAt: now,
            title: buyerActor.actorDisplayName || buyerActor.actorUsername || 'Someone',
            body: `bought your item: ${cleanString(listing?.title || item.title || 'Listing', 160)}`,
            imageUri:
              cleanString(listing?.primeImage?.url || item.imageUrl || '', 2000) || null,
            targetId: orderRef.id,
            targetType: 'order',
            orderId: orderRef.id,
            listingId,
            ...buyerActor,
          });
        }
      });

      results.push({ listingId, ok: true });
    } catch (err) {
      const reason = cleanString(err?.message || 'unknown-error', 200);
      console.warn('[purchase] listing fulfillment skipped', {
        listingId,
        reason,
        paymentRef,
      });
      results.push({ listingId, ok: false, reason });
    }
  }

  const processed = results.filter((r) => r.ok).length;
  const skipped = results.length - processed;
  return { processed, skipped, results };
}

async function createShippingCoSandboxShipmentForOrder({ orderId, actorUid, req }) {
  const db = getDb();
  if (!db) {
    throw new Error('Firestore Admin is not initialized.');
  }

  const cleanOrderId = cleanString(orderId || '', 180);
  const cleanActorUid = cleanString(actorUid || '', 128);
  if (!cleanOrderId) throw makeHttpError('Missing orderId.', 400, 'ORDER_ID_REQUIRED');
  if (!cleanActorUid) throw makeHttpError('Authentication required.', 401, 'AUTH_REQUIRED');

  const orderRef = db.collection('orders').doc(cleanOrderId);
  const sellerRef = db.collection('users').doc(cleanActorUid);
  let result = null;

  await db.runTransaction(async (tx) => {
    const [orderSnap, sellerSnap] = await Promise.all([tx.get(orderRef), tx.get(sellerRef)]);
    if (!orderSnap.exists) {
      throw makeHttpError('Order not found.', 404, 'ORDER_NOT_FOUND');
    }

    const order = orderSnap.data() || {};
    const sellerUid = cleanString(order?.sellerUid || '', 128);
    if (!sellerUid || sellerUid !== cleanActorUid) {
      throw makeHttpError('You are not allowed to manage this shipment.', 403, 'ORDER_ROLE_MISMATCH');
    }

    const status = normalizeOrderStatus(order?.status);
    if (status.startsWith('cancelled') || status === 'delivered' || status === 'completed') {
      throw makeHttpError('This order cannot start a sandbox shipment anymore.', 409, 'ORDER_NOT_SHIPPABLE');
    }

    const existingSandbox = order?.shipping?.sandbox || null;
    if (existingSandbox?.trackingCode) {
      result = {
        ok: true,
        existing: true,
        orderId: cleanOrderId,
        sandbox: existingSandbox,
      };
      return;
    }

    const sender = sanitizeShippingCoAddress(sellerSnap.data()?.shippingAddress || {});
    if (!isShippingCoAddressComplete(sender)) {
      throw makeHttpError(
        'Complete your delivery address in Settings before creating a ShippingCo sandbox shipment.',
        409,
        'SELLER_ADDRESS_INCOMPLETE',
      );
    }

    const receiver = extractOrderReceiverAddress(order);
    if (!isShippingCoAddressComplete(receiver)) {
      throw makeHttpError(
        'This order is missing a complete buyer delivery snapshot and cannot create a sandbox shipment.',
        409,
        'RECEIVER_ADDRESS_INCOMPLETE',
      );
    }

    const accessToken = randomUUID();
    const createdAt = new Date().toISOString();
    const createdAtMs = Date.parse(createdAt) || Date.now();
    const trackingUrl = buildShippingCoTrackingUrl(req, accessToken);
    const trackingCode = buildSandboxTrackingCode(cleanOrderId, accessToken);
    const parcelProfile =
      normalizeParcelProfile(
        order?.shipping?.parcelProfile ||
          order?.listing?.parcelProfile ||
          order?.items?.[0]?.parcelProfile,
      ) || inferParcelProfileFromListing(order?.listing || order?.items?.[0] || {});

    const sandbox = {
      provider: 'internal',
      mode: 'sandbox',
      carrier: 'ShippingCo',
      autoProgress: true,
      accessToken,
      trackingCode,
      trackingUrl,
      trackingPhase: 'label_created',
      trackingPhaseLabel: formatSandboxPhaseLabel('label_created'),
      trackingEvents: [createSandboxEvent('label_created', createdAt)],
      schedule: createSandboxSchedule(shippingCoConfig, createdAtMs),
      createdAt,
      updatedAt: createdAt,
    };

    const patch = {
      updatedAt: FieldValue.serverTimestamp(),
      'shipping.sender': toShippingSnapshot(sender, {
        source: 'seller_account',
        uid: cleanActorUid,
      }),
      'shipping.receiver': toShippingSnapshot(receiver, {
        source: 'order_checkout',
        uid: cleanString(order?.buyerUid || '', 128) || null,
      }),
      'shipping.carrierName': 'ShippingCo',
      'shipping.parcelProfile': parcelProfile,
      'shipping.parcelLabel': formatParcelProfileLabel(parcelProfile) || null,
      'shipping.sandbox': sandbox,
    };

    Object.assign(patch, buildSandboxStatusPatch(order, 'label_created'));
    tx.update(orderRef, patch);

    result = {
      ok: true,
      created: true,
      orderId: cleanOrderId,
      sandbox,
      status: patch.status || status,
    };
  });

  return result;
}

async function advanceShippingCoSandboxShipmentForOrder({
  orderId,
  actorUid,
  requestedPhase = null,
  requireSeller = true,
}) {
  const db = getDb();
  if (!db) {
    throw new Error('Firestore Admin is not initialized.');
  }

  const cleanOrderId = cleanString(orderId || '', 180);
  const cleanActorUid = cleanString(actorUid || '', 128);
  if (!cleanOrderId) throw makeHttpError('Missing orderId.', 400, 'ORDER_ID_REQUIRED');
  if (!cleanActorUid) throw makeHttpError('Authentication required.', 401, 'AUTH_REQUIRED');

  const phaseRank = {
    label_created: 0,
    in_transit: 1,
    out_for_delivery: 2,
    delivered: 3,
  };

  const orderRef = db.collection('orders').doc(cleanOrderId);
  let result = null;

  await db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) {
      throw makeHttpError('Order not found.', 404, 'ORDER_NOT_FOUND');
    }

    const order = orderSnap.data() || {};
    const sellerUid = cleanString(order?.sellerUid || '', 128);
    const buyerUid = cleanString(order?.buyerUid || '', 128);
    const actorMatchesSeller = Boolean(sellerUid && sellerUid === cleanActorUid);
    const actorMatchesBuyer = Boolean(buyerUid && buyerUid === cleanActorUid);

    if (requireSeller && !actorMatchesSeller) {
      throw makeHttpError('You are not allowed to manage this shipment.', 403, 'ORDER_ROLE_MISMATCH');
    }
    if (!requireSeller && !actorMatchesSeller && !actorMatchesBuyer) {
      throw makeHttpError('You are not allowed to view this shipment.', 403, 'ORDER_ROLE_MISMATCH');
    }

    const status = normalizeOrderStatus(order?.status);
    if (status.startsWith('cancelled') || status === 'completed') {
      throw makeHttpError('This order can no longer update sandbox tracking.', 409, 'ORDER_NOT_SHIPPABLE');
    }

    const sandbox = order?.shipping?.sandbox || null;
    if (!sandbox?.trackingCode) {
      throw makeHttpError(
        'Create the ShippingCo sandbox shipment before advancing it.',
        409,
        'SANDBOX_NOT_CREATED',
      );
    }

    const currentPhase = normalizeSandboxPhase(sandbox?.trackingPhase) || 'label_created';
    const manualPhase = normalizeSandboxPhase(requestedPhase);
    const targetPhase = manualPhase || nextSandboxPhase(currentPhase) || '';

    if (!targetPhase) {
      result = {
        ok: true,
        advanced: false,
        orderId: cleanOrderId,
        sandbox,
      };
      return;
    }

    if (phaseRank[targetPhase] < phaseRank[currentPhase]) {
      throw makeHttpError('Sandbox tracking cannot move backwards.', 409, 'SANDBOX_PHASE_INVALID');
    }

    if (phaseRank[targetPhase] === phaseRank[currentPhase]) {
      result = {
        ok: true,
        advanced: false,
        orderId: cleanOrderId,
        sandbox,
      };
      return;
    }

    const updatedAt = new Date().toISOString();
    const nextEvents = Array.isArray(sandbox?.trackingEvents)
      ? [...sandbox.trackingEvents, createSandboxEvent(targetPhase, updatedAt)]
      : [createSandboxEvent('label_created', sandbox?.createdAt || updatedAt), createSandboxEvent(targetPhase, updatedAt)];
    const nextSandbox = {
      ...sandbox,
      trackingPhase: targetPhase,
      trackingPhaseLabel: formatSandboxPhaseLabel(targetPhase),
      trackingEvents: nextEvents,
      updatedAt,
    };
    const patch = {
      updatedAt: FieldValue.serverTimestamp(),
      'shipping.sandbox': nextSandbox,
    };

    Object.assign(patch, buildSandboxStatusPatch(order, targetPhase));
    tx.update(orderRef, patch);

    result = {
      ok: true,
      advanced: true,
      orderId: cleanOrderId,
      sandbox: nextSandbox,
      status: patch.status || status,
    };
  });

  return result;
}

async function reconcileShippingCoSandboxOrders({ orderIds = [], actorUid = '' }) {
  const cleanActorUid = cleanString(actorUid || '', 128);
  if (!cleanActorUid) throw makeHttpError('Authentication required.', 401, 'AUTH_REQUIRED');

  const uniqueOrderIds = Array.from(
    new Set(
      (Array.isArray(orderIds) ? orderIds : [])
        .map((orderId) => cleanString(orderId || '', 180))
        .filter(Boolean),
    ),
  ).slice(0, 40);

  if (!uniqueOrderIds.length) {
    return { ok: true, results: [] };
  }

  const db = getDb();
  if (!db) {
    throw new Error('Firestore Admin is not initialized.');
  }

  const nowMs = Date.now();
  const results = [];
  for (const orderId of uniqueOrderIds) {
    try {
      const snap = await db.collection('orders').doc(orderId).get();
      if (!snap.exists) {
        results.push({ orderId, ok: false, reason: 'not-found' });
        continue;
      }

      const order = snap.data() || {};
      const sellerUid = cleanString(order?.sellerUid || '', 128);
      const buyerUid = cleanString(order?.buyerUid || '', 128);
      if (sellerUid !== cleanActorUid && buyerUid !== cleanActorUid) {
        results.push({ orderId, ok: false, reason: 'forbidden' });
        continue;
      }

      const sandbox = order?.shipping?.sandbox || null;
      if (!sandbox?.trackingCode) {
        results.push({ orderId, ok: true, skipped: 'no-sandbox' });
        continue;
      }

      const duePhase = phaseDueForSchedule(sandbox, nowMs);
      if (!duePhase) {
        results.push({
          orderId,
          ok: true,
          skipped: 'up-to-date',
          phase: normalizeSandboxPhase(sandbox?.trackingPhase) || 'label_created',
        });
        continue;
      }

      const advanced = await advanceShippingCoSandboxShipmentForOrder({
        orderId,
        actorUid: cleanActorUid,
        requestedPhase: duePhase,
        requireSeller: false,
      });
      results.push({
        orderId,
        ok: true,
        advanced: Boolean(advanced?.advanced),
        phase: advanced?.sandbox?.trackingPhase || duePhase,
      });
    } catch (error) {
      results.push({
        orderId,
        ok: false,
        reason: cleanString(error?.code || error?.message || 'unknown-error', 120) || 'unknown-error',
      });
    }
  }

  return { ok: true, results };
}

const app = express();
app.use(cors());
app.use((req, res, next) => {
  const requestId = cleanString(req.headers['x-request-id'] || '', 120) || randomUUID();
  const startedAt = Date.now();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  res.on('finish', () => {
    const body =
      req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    logStructured('log', 'http_request', {
      requestId,
      method: req.method,
      route: cleanString(req.originalUrl || req.url || '', 240),
      status: res.statusCode,
      latencyMs: Date.now() - startedAt,
      authResult: authResultForLog(req),
      authUid: cleanString(req.authUid || '', 128) || undefined,
      paymentIntentId: cleanString(body?.paymentIntentId || '', 120) || undefined,
      orderId: cleanString(body?.orderId || '', 180) || undefined,
      listingId: cleanString(body?.listingId || '', 180) || undefined,
      targetUid: cleanString(body?.targetUid || '', 128) || undefined,
    });
  });
  next();
});

registerPaymentRoutes(app, {
  expressModule: express,
  stripe,
  webhookSecret: STRIPE_WEBHOOK_SECRET,
  parseItemsFromMetadata,
  parseQuoteIdFromMetadata,
  parseShippingFromMetadata,
  cleanString,
  fulfillPaidListings,
  requireRequestAuthUid,
  logStructured,
  logger: console,
});

app.post('/quote-shipping', async (req, res) => {
  try {
    await requireRequestAuthUid(req);
    const { shippingAddress = null, items = [] } = req.body || {};
    const quote = await buildShippingCoCheckoutQuote({
      rawItems: items,
      shippingAddress,
    });
    return res.json(toPublicShippingQuote(quote));
  } catch (err) {
    const message = String(err?.message || '');
    const code = String(err?.code || '');
    const statusCode = Number(err?.statusCode || 0);
    if (statusCode === 401) {
      return res.status(401).json({ error: message || 'Authentication required.' });
    }
    if (code === 'BUYER_ADDRESS_INCOMPLETE' || code === 'SELLER_ADDRESS_INCOMPLETE') {
      return res.status(409).json({ error: message || 'Shipping quote unavailable.' });
    }
    if (message.startsWith('unavailable-listings:')) {
      return res.status(409).json({
        error: 'One or more items are no longer available.',
        details: message.replace('unavailable-listings:', ''),
      });
    }
    logStructured('error', 'quote_shipping_failed', {
      requestId: req.requestId,
      message,
    });
    return res.status(500).json({ error: 'Failed to quote shipping.' });
  }
});

app.post(['/shipping/sandbox/shippingco/create', '/shipping/sandbox/royal-mail/create'], async (req, res) => {
  try {
    const actorUid = await requireRequestAuthUid(req);
    const { orderId = '' } = req.body || {};
    const result = await createShippingCoSandboxShipmentForOrder({
      orderId,
      actorUid,
      req,
    });
    return res.json(result);
  } catch (err) {
    const message = String(err?.message || '');
    const code = String(err?.code || '');
    const statusCode = Number(err?.statusCode || 0);
    if (statusCode) {
      return res.status(statusCode).json({ error: message || 'Failed to create shipment.' });
    }
    if (code === 'ORDER_NOT_FOUND') {
      return res.status(404).json({ error: 'Order not found.' });
    }
    logStructured('error', 'shippingco_sandbox_create_failed', {
      requestId: req.requestId,
      message,
    });
    return res.status(500).json({ error: 'Failed to create ShippingCo sandbox shipment.' });
  }
});

app.post(['/shipping/sandbox/shippingco/advance', '/shipping/sandbox/royal-mail/advance'], async (req, res) => {
  try {
    const actorUid = await requireRequestAuthUid(req);
    const { orderId = '', targetPhase = null } = req.body || {};
    const result = await advanceShippingCoSandboxShipmentForOrder({
      orderId,
      actorUid,
      requestedPhase: targetPhase,
      requireSeller: true,
    });
    return res.json(result);
  } catch (err) {
    const message = String(err?.message || '');
    const statusCode = Number(err?.statusCode || 0);
    if (statusCode) {
      return res.status(statusCode).json({ error: message || 'Failed to advance shipment.' });
    }
    logStructured('error', 'shippingco_sandbox_advance_failed', {
      requestId: req.requestId,
      message,
    });
    return res.status(500).json({ error: 'Failed to advance ShippingCo sandbox shipment.' });
  }
});

app.post(['/shipping/sandbox/shippingco/reconcile', '/shipping/sandbox/royal-mail/reconcile'], async (req, res) => {
  try {
    const actorUid = await requireRequestAuthUid(req);
    const { orderIds = [] } = req.body || {};
    const result = await reconcileShippingCoSandboxOrders({
      orderIds,
      actorUid,
    });
    return res.json(result);
  } catch (err) {
    const message = String(err?.message || '');
    const statusCode = Number(err?.statusCode || 0);
    if (statusCode) {
      return res.status(statusCode).json({ error: message || 'Failed to reconcile shipments.' });
    }
    logStructured('error', 'shippingco_sandbox_reconcile_failed', {
      requestId: req.requestId,
      message,
    });
    return res.status(500).json({ error: 'Failed to reconcile ShippingCo sandbox shipments.' });
  }
});

app.get(['/shipping/sandbox/shippingco/track/:token', '/shipping/sandbox/royal-mail/track/:token'], async (req, res) => {
  try {
    const token = cleanString(req.params?.token || '', 200);
    if (!token) {
      return res.status(404).send('Tracking token not found.');
    }

    const db = getDb();
    if (!db) {
      return res.status(500).send('Firestore Admin is not initialized.');
    }

    const snap = await db
      .collection('orders')
      .where('shipping.sandbox.accessToken', '==', token)
      .limit(1)
      .get();
    if (snap.empty) {
      return res.status(404).send('Tracking page not found.');
    }

    const orderDoc = snap.docs[0];
    const order = orderDoc.data() || {};
    const sandbox = order?.shipping?.sandbox || {};
    const receiver = order?.shipping?.receiver || extractOrderReceiverAddress(order);
    const sender = order?.shipping?.sender || {};
    const events = Array.isArray(sandbox?.trackingEvents) ? sandbox.trackingEvents : [];
    const timeline = events
      .map((event) => {
        const label = cleanString(event?.label || formatSandboxPhaseLabel(event?.status), 80) || 'Update';
        const at = cleanString(event?.at || '', 80) || 'Pending';
        return `<li><strong>${escapeHtml(label)}</strong><span>${escapeHtml(at)}</span></li>`;
      })
      .join('');

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ShippingCo Sandbox Tracking</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: linear-gradient(180deg, #fff7f7 0%, #f5f5f5 100%); color: #161616; }
    .wrap { max-width: 720px; margin: 0 auto; padding: 24px 18px 40px; }
    .hero { background: #fff; border: 1px solid #edd4d4; border-radius: 24px; padding: 22px; box-shadow: 0 18px 60px rgba(112, 23, 23, 0.08); }
    .eyebrow { margin: 0 0 10px 0; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #b11116; font-weight: 800; }
    h1 { margin: 0 0 8px 0; font-size: 30px; line-height: 1.1; }
    .sub { margin: 0; color: #5f5f68; line-height: 1.45; }
    .grid { display: grid; gap: 12px; margin-top: 18px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .card { background: #fff5f5; border: 1px solid #efdada; border-radius: 18px; padding: 14px 16px; }
    .label { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #8a8a93; font-weight: 800; }
    .value { margin: 0; font-size: 15px; line-height: 1.45; font-weight: 700; color: #18181b; white-space: pre-line; }
    .pill { display: inline-flex; align-items: center; gap: 8px; margin-top: 16px; padding: 9px 12px; border-radius: 999px; background: rgba(177, 17, 22, 0.08); border: 1px solid rgba(177, 17, 22, 0.14); color: #9f1216; font-weight: 800; }
    .timeline { margin-top: 22px; padding: 0; list-style: none; display: grid; gap: 12px; }
    .timeline li { background: #fff; border: 1px solid #ece6e6; border-radius: 18px; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .timeline span { color: #6b6b76; font-size: 13px; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <p class="eyebrow">ShippingCo Sandbox</p>
      <h1>${escapeHtml(cleanString(order?.listing?.title || order?.items?.[0]?.title || 'Parcel', 160) || 'Parcel')}</h1>
      <p class="sub">Tracking code ${escapeHtml(cleanString(sandbox?.trackingCode || '', 80) || 'Pending')} for order ${escapeHtml(formatDisplayOrderNumber(orderDoc.id))}.</p>
      <div class="pill">${escapeHtml(cleanString(sandbox?.trackingPhaseLabel || formatSandboxPhaseLabel(sandbox?.trackingPhase), 80) || 'Label created')}</div>
      <div class="grid">
        <div class="card">
          <p class="label">Tracking</p>
          <p class="value">${escapeHtml(cleanString(sandbox?.trackingCode || '', 80) || 'Pending')}</p>
        </div>
        <div class="card">
          <p class="label">Sender</p>
          <p class="value">${escapeHtml(
            [sender?.name, sender?.line1, sender?.line2, sender?.city, sender?.postalCode, sender?.country]
              .filter(Boolean)
              .join('\n'),
          )}</p>
        </div>
        <div class="card">
          <p class="label">Receiver</p>
          <p class="value">${escapeHtml(
            [receiver?.name, receiver?.line1, receiver?.line2, receiver?.city, receiver?.postalCode, receiver?.country]
              .filter(Boolean)
              .join('\n'),
          )}</p>
        </div>
      </div>
      <ul class="timeline">${timeline}</ul>
    </section>
  </main>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    logStructured('error', 'shippingco_track_page_failed', {
      requestId: req.requestId,
      message: String(err?.message || err),
    });
    return res.status(500).send('Failed to load tracking page.');
  }
});

app.get('/checkout/confirm', async (req, res) => {
  try {
    const result = await confirmCheckoutSessionAndFulfill(req.query?.session_id);
    if (!result.ok) {
      return res.status(409).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('[checkout-confirm] failed', err);
    return res.status(500).json({ ok: false, error: 'Failed to confirm checkout session.' });
  }
});

app.get(['/checkout/success', '/checkout/success/', '/success', '/success/'], async (req, res) => {
  const origin = resolvePublicOrigin(req);
  const sessionId = cleanString(req.query?.session_id || '', 120);
  let title = 'Purchase Successful';
  let subtitle = 'Your payment was received.';
  let confirmationNumber = formatDisplayOrderNumber(sessionId);
  let detailRows = '';
  let ctaText = 'Open App';
  let ctaHref = 'fshn://home';

  try {
    const confirmed = await confirmCheckoutSessionAndFulfill(sessionId);
    if (confirmed.ok) {
      confirmationNumber = confirmed.confirmationNumber || confirmationNumber;
      const processed = Number(confirmed.processed || 0);
      const skipped = Number(confirmed.skipped || 0);
      subtitle = 'Your order is confirmed and saved.';
      detailRows = `
        <p><strong>Items processed:</strong> ${processed}</p>
        <p><strong>Items already synced:</strong> ${skipped}</p>
      `;
      ctaHref = `fshn://checkout/success?confirmation=${encodeURIComponent(confirmationNumber)}`;
    } else if (confirmed.error) {
      title = 'Purchase Completed';
      subtitle = 'Payment is complete. Order sync may still be processing.';
      detailRows = `<p><strong>Sync status:</strong> ${escapeHtml(confirmed.error)}</p>`;
      ctaHref = `fshn://checkout/success?confirmation=${encodeURIComponent(confirmationNumber)}`;
      ctaText = 'Back To App';
    }
  } catch (err) {
    console.error('[checkout-success] confirm failed', err);
    title = 'Purchase Completed';
    subtitle = 'Payment is complete. We are finalizing your order.';
    detailRows = `<p><strong>Sync status:</strong> pending</p>`;
    ctaHref = `fshn://checkout/success?confirmation=${encodeURIComponent(confirmationNumber)}`;
    ctaText = 'Back To App';
  }

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FSHN Checkout</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f4f5; color: #111827; }
    .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { width: 100%; max-width: 480px; background: #fff; border-radius: 16px; border: 1px solid #e5e7eb; padding: 24px; box-sizing: border-box; }
    .eyebrow { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; margin: 0 0 8px 0; }
    h1 { margin: 0 0 8px 0; font-size: 28px; line-height: 1.15; }
    .sub { margin: 0 0 18px 0; color: #4b5563; }
    .conf { margin: 0 0 12px 0; padding: 12px 14px; border-radius: 10px; background: #f9fafb; border: 1px solid #e5e7eb; font-weight: 700; }
    .meta p { margin: 6px 0; color: #374151; }
    .btn { margin-top: 18px; display: inline-block; text-decoration: none; background: #111827; color: #fff; padding: 12px 16px; border-radius: 10px; font-weight: 700; }
    .hint { margin-top: 12px; font-size: 13px; color: #6b7280; }
    .link { color: #374151; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <p class="eyebrow">FSHN</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="sub">${escapeHtml(subtitle)}</p>
      <p class="conf">Order confirmation: ${escapeHtml(confirmationNumber)}</p>
      <div class="meta">${detailRows}</div>
      <a class="btn" href="${escapeHtml(ctaHref)}">${escapeHtml(ctaText)}</a>
      <p class="hint">If the app does not open, return manually. You can verify this order in your profile purchase history.</p>
      ${origin ? `<p class="hint"><a class="link" href="${escapeHtml(origin)}">${escapeHtml(origin)}</a></p>` : ''}
    </section>
  </main>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
});

app.get(['/checkout/cancel', '/checkout/cancel/', '/cancel', '/cancel/'], (_req, res) => {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FSHN Checkout</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f4f5; color: #111827; }
    .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { width: 100%; max-width: 480px; background: #fff; border-radius: 16px; border: 1px solid #e5e7eb; padding: 24px; box-sizing: border-box; }
    .btn { margin-top: 16px; display: inline-block; text-decoration: none; background: #111827; color: #fff; padding: 12px 16px; border-radius: 10px; font-weight: 700; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <h1>Checkout Cancelled</h1>
      <p>Your payment was not completed. You can return to the app and try again.</p>
      <a class="btn" href="fshn://basket">Back To App</a>
    </section>
  </main>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
});

app.post('/create-payment-intent', async (req, res) => {
  try {
    const buyerUid = await requireRequestAuthUid(req);
    const { amount, currency = 'gbp', shippingAddress = null, items = [] } = req.body || {};
    const normalizedItems = normalizeItems(items);
    const chargeableItems = normalizedItems.filter((item) => item.unitAmount > 0);
    const listingItems = normalizedItems.filter((item) => item.listingId);
    const checkoutQuote = listingItems.length
      ? await buildShippingCoCheckoutQuote({
          rawItems: normalizedItems,
          shippingAddress,
        })
      : null;
    const derivedAmount = checkoutQuote
      ? checkoutQuote.totalAmount
      : chargeableItems.reduce((sum, item) => sum + item.unitAmount * item.qty, 0);
    const requestedAmount = Math.round(Number(amount) || 0);
    const amountValue = derivedAmount > 0 ? derivedAmount : requestedAmount;
    if (!amountValue || amountValue <= 0) {
      return res.status(400).json({ error: 'Invalid amount.' });
    }
    if (derivedAmount > 0 && requestedAmount > 0 && requestedAmount !== derivedAmount) {
      logStructured('warn', 'stripe_amount_mismatch', {
        requestId: req.requestId,
        requestedAmount,
        derivedAmount,
      });
    }

    const quoteId = checkoutQuote ? randomUUID() : '';
    const metadata = buildMetadata({
      buyerUid,
      shippingAddress: checkoutQuote?.shippingAddress || shippingAddress,
      items: normalizedItems,
      source: 'mobile_payment_sheet',
      quoteId,
    });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountValue,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata,
    });

    if (checkoutQuote && quoteId) {
      await persistCheckoutQuoteRecord({
        quoteId,
        buyerUid,
        source: 'mobile_payment_sheet',
        quote: checkoutQuote,
        stripePaymentIntentId: paymentIntent.id,
      });
    }

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    const message = String(err?.message || '');
    const statusCode = Number(err?.statusCode || 0);
    if (statusCode === 401) {
      return res.status(401).json({ error: message || 'Authentication required.' });
    }
    if (String(err?.code || '') === 'BUYER_ADDRESS_INCOMPLETE' || String(err?.code || '') === 'SELLER_ADDRESS_INCOMPLETE') {
      return res.status(409).json({ error: message || 'Shipping quote unavailable.' });
    }
    if (String(err?.message || '').startsWith('unavailable-listings:')) {
      return res.status(409).json({
        error: 'One or more items are no longer available.',
        details: String(err.message).replace('unavailable-listings:', ''),
      });
    }
    if (message.includes('PERMISSION_DENIED') || message.includes('Missing or insufficient permissions')) {
      return res.status(500).json({
        error: 'Server cannot access Firestore.',
        details:
          'Configure Firebase Admin credentials (GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON) for project fshn-6a61b.',
      });
    }
    logStructured('error', 'create_payment_intent_failed', {
      requestId: req.requestId,
      message,
    });
    res.status(500).json({ error: 'Failed to create payment intent.' });
  }
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const buyerUid = await requireRequestAuthUid(req);
    const { items = [], shippingAddress = null } = req.body || {};
    const normalizedItems = normalizeItems(items);
    const chargeableItems = normalizedItems.filter((item) => item.unitAmount > 0);
    if (!chargeableItems.length) {
      return res.status(400).json({ error: 'Missing items.' });
    }

    const checkoutQuote = await buildShippingCoCheckoutQuote({
      rawItems: normalizedItems,
      shippingAddress,
    });
    const quoteId = randomUUID();
    const metadata = buildMetadata({
      buyerUid,
      shippingAddress: checkoutQuote.shippingAddress,
      items: normalizedItems,
      source: 'checkout_session',
      quoteId,
    });

    const redirects = buildCheckoutRedirectUrls(req);
    const quoteByListingId = new Map(
      (checkoutQuote.items || []).map((item) => [item.listingId, item]),
    );
    const lineItems = [];
    normalizedItems
      .filter((item) => item.listingId)
      .forEach((item) => {
        const quoteItem = quoteByListingId.get(item.listingId);
        const itemQty = Math.max(1, Math.round(Number(quoteItem?.qty || item.qty || 1)));
        const itemUnitAmount = Math.max(
          0,
          Math.round(Number(quoteItem?.unitAmount || item.unitAmount || 0)),
        );
        if (itemUnitAmount > 0) {
          lineItems.push({
            price_data: {
              currency: 'gbp',
              product_data: {
                name: cleanString(quoteItem?.title || item.title || 'Item', 160) || 'Item',
              },
              unit_amount: itemUnitAmount,
            },
            quantity: itemQty,
          });
        }
        const shippingAmount = Math.max(0, Math.round(Number(quoteItem?.amount) || 0));
        if (shippingAmount > 0) {
          lineItems.push({
            price_data: {
              currency: 'gbp',
              product_data: {
                name:
                  cleanString(
                    `ShippingCo shipping · ${quoteItem?.title || item.title || 'Item'}`,
                    160,
                  ) || 'ShippingCo shipping',
              },
              unit_amount: shippingAmount,
            },
            quantity: 1,
          });
        }
      });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      success_url: redirects.success,
      cancel_url: redirects.cancel,
      client_reference_id: cleanString(buyerUid || '', 128) || undefined,
      metadata,
      payment_intent_data: {
        metadata,
      },
    });

    await persistCheckoutQuoteRecord({
      quoteId,
      buyerUid,
      source: 'checkout_session',
      quote: checkoutQuote,
      checkoutSessionId: session.id,
    });

    res.json({ url: session.url, successUrl: redirects.success, cancelUrl: redirects.cancel });
  } catch (err) {
    const message = String(err?.message || '');
    const statusCode = Number(err?.statusCode || 0);
    if (statusCode === 401) {
      return res.status(401).json({ error: message || 'Authentication required.' });
    }
    if (String(err?.code || '') === 'BUYER_ADDRESS_INCOMPLETE' || String(err?.code || '') === 'SELLER_ADDRESS_INCOMPLETE') {
      return res.status(409).json({ error: message || 'Shipping quote unavailable.' });
    }
    if (String(err?.message || '').startsWith('unavailable-listings:')) {
      return res.status(409).json({
        error: 'One or more items are no longer available.',
        details: String(err.message).replace('unavailable-listings:', ''),
      });
    }
    if (message.includes('PERMISSION_DENIED') || message.includes('Missing or insufficient permissions')) {
      return res.status(500).json({
        error: 'Server cannot access Firestore.',
        details:
          'Configure Firebase Admin credentials (GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON) for project fshn-6a61b.',
      });
    }
    logStructured('error', 'create_checkout_session_failed', {
      requestId: req.requestId,
      message,
    });
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

app.post('/cancel-order', async (req, res) => {
  try {
    const { orderId, role = 'buyer' } = req.body || {};
    const actorUid = await requireRequestAuthUid(req);
    const result = await cancelOrderAndReactivateListing({
      orderId,
      actorUid,
      role,
    });
    return res.json(result);
  } catch (err) {
    const message = String(err?.message || '');
    const code = String(err?.code || '');
    const statusCode = Number(err?.statusCode || 0);

    if (statusCode === 401) {
      return res.status(401).json({ error: message || 'Authentication required.' });
    }
    if (code === 'ORDER_NOT_FOUND') {
      return res.status(404).json({ error: 'Order not found.' });
    }
    if (code === 'ORDER_ROLE_MISMATCH') {
      return res.status(403).json({ error: 'You are not allowed to cancel this order.' });
    }
    if (code === 'ORDER_NOT_CANCELLABLE') {
      return res.status(409).json({
        error: 'This order can no longer be cancelled once shipment has started.',
      });
    }
    if (code === 'ORDER_ID_REQUIRED') {
      return res.status(400).json({ error: 'Missing orderId.' });
    }
    if (message.includes('PERMISSION_DENIED') || message.includes('Missing or insufficient permissions')) {
      return res.status(500).json({
        error: 'Server cannot access Firestore.',
        details:
          'Configure Firebase Admin credentials (GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON) for project fshn-6a61b.',
      });
    }

    console.error('[cancel-order] failed', err);
    return res.status(500).json({ error: 'Failed to cancel order.' });
  }
});

app.post('/notifications/event', async (req, res) => {
  try {
    const {
      type = '',
      enabled = true,
      targetUid = '',
      listingId = '',
      postId = '',
      commentText = '',
      commentEventId = '',
      parentCommentId = '',
    } = req.body || {};
    const actorUid = await requireRequestAuthUid(req);
    const result = await upsertNotificationEvent({
      type,
      actorUid,
      enabled: enabled !== false,
      targetUid,
      listingId,
      postId,
      commentText,
      commentEventId,
      parentCommentId,
    });
    return res.json(result);
  } catch (err) {
    const message = String(err?.message || '');
    const code = String(err?.code || '');
    const statusCode = Number(err?.statusCode || 0);

    if (statusCode === 401) {
      return res.status(401).json({ error: message || 'Authentication required.' });
    }
    if (code === 'LISTING_ID_REQUIRED' || code === 'POST_ID_REQUIRED') {
      return res.status(400).json({ error: message || 'Missing notification target.' });
    }
    if (code === 'COMMENT_ID_REQUIRED') {
      return res.status(400).json({ error: message || 'Missing notification comment id.' });
    }
    if (code === 'UNSUPPORTED_NOTIFICATION_TYPE') {
      return res.status(400).json({ error: 'Unsupported notification type.' });
    }
    if (message.includes('PERMISSION_DENIED') || message.includes('Missing or insufficient permissions')) {
      return res.status(500).json({
        error: 'Server cannot access Firestore.',
        details:
          'Configure Firebase Admin credentials (GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON) for project fshn-6a61b.',
      });
    }

    console.error('[notifications-event] failed', err);
    return res.status(500).json({ error: 'Failed to update notification event.' });
  }
});

app.post('/notifications/backfill', async (req, res) => {
  try {
    const actorUid = await requireRequestAuthUid(req);
    const result = await backfillNotificationsForUser(actorUid);
    return res.json(result);
  } catch (err) {
    const message = String(err?.message || '');
    const statusCode = Number(err?.statusCode || 0);
    if (statusCode === 401) {
      return res.status(401).json({ error: message || 'Authentication required.' });
    }
    if (message.includes('PERMISSION_DENIED') || message.includes('Missing or insufficient permissions')) {
      return res.status(500).json({
        error: 'Server cannot access Firestore.',
        details:
          'Configure Firebase Admin credentials (GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON) for project fshn-6a61b.',
      });
    }
    console.error('[notifications-backfill] failed', err);
    return res.status(500).json({ error: 'Failed to backfill notifications.' });
  }
});

const PORT = Number(runtimeConfig.port || 4242) || 4242;
app.listen(PORT, () => {
  logStructured('log', 'server_started', {
    port: Number(PORT),
    firebaseProjectId: FIREBASE_PROJECT_ID,
  });
  if (FIREBASE_SERVICE_ACCOUNT_JSON) {
    logStructured('log', 'firebase_credentials', {
      source: 'FIREBASE_SERVICE_ACCOUNT_JSON',
    });
  } else if (FIREBASE_CREDENTIAL_PATH) {
    logStructured('log', 'firebase_credentials', {
      source: 'GOOGLE_APPLICATION_CREDENTIALS',
      path: FIREBASE_CREDENTIAL_PATH,
    });
  } else {
    logStructured('log', 'firebase_credentials', {
      source: 'applicationDefault()',
    });
  }
});
