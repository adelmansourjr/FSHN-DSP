import { normalizeAppEnv, readStageEnv } from './config.mjs';

export const PARCEL_PROFILES = ['small_garment', 'bulky_garment', 'shoebox'];

const PHASE_LABELS = {
  label_created: 'Label created',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
};

const FIXED_SERVICES = {
  small_garment: 'ShippingCo Small Parcel',
  bulky_garment: 'ShippingCo Medium Parcel',
  shoebox: 'ShippingCo Shoebox',
};

const DEFAULT_FIXED_FEES = {
  small_garment: 499,
  bulky_garment: 699,
  shoebox: 799,
};

const clean = (value) => String(value || '').trim();

const toPositiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toCentsFromGbp = (value, fallback) => {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  return Math.max(0, Math.round(normalized * 100));
};

const readDurationMs = ({
  env,
  appEnv,
  secondsName,
  minutesName,
  defaultSeconds,
}) => {
  const secondsValue = clean(readStageEnv(secondsName, env, appEnv));
  if (secondsValue) {
    return toPositiveNumber(secondsValue, defaultSeconds) * 1000;
  }

  const minutesValue = clean(readStageEnv(minutesName, env, appEnv));
  if (minutesValue) {
    return toPositiveNumber(minutesValue, defaultSeconds / 60) * 60 * 1000;
  }

  return defaultSeconds * 1000;
};

export function sanitizeShippingCoAddress(raw = {}) {
  return {
    name: clean(raw?.name || raw?.fullName || raw?.recipientName || ''),
    line1: clean(raw?.line1 || raw?.addressLine1 || raw?.address1 || ''),
    line2: clean(raw?.line2 || raw?.addressLine2 || raw?.address2 || ''),
    city: clean(raw?.city || ''),
    region: clean(raw?.region || raw?.state || ''),
    postalCode: clean(raw?.postalCode || raw?.postal_code || ''),
    country: clean(raw?.country || ''),
  };
}

export function isShippingCoAddressComplete(raw = {}) {
  const address = sanitizeShippingCoAddress(raw);
  return Boolean(
    address.name &&
      address.line1 &&
      address.city &&
      address.postalCode &&
      address.country
  );
}

export function normalizeParcelProfile(value) {
  const raw = clean(value).toLowerCase();
  if (!raw) return null;
  if (raw === 'small_garment' || raw === 'small-garment' || raw === 'small garment') {
    return 'small_garment';
  }
  if (raw === 'bulky_garment' || raw === 'bulky-garment' || raw === 'bulky garment') {
    return 'bulky_garment';
  }
  if (raw === 'shoebox' || raw === 'shoe_box' || raw === 'shoe-box' || raw === 'shoe box') {
    return 'shoebox';
  }
  return null;
}

export function formatParcelProfileLabel(value) {
  const normalized = normalizeParcelProfile(value);
  if (normalized === 'small_garment') return 'Small Garment';
  if (normalized === 'bulky_garment') return 'Bulky Garment';
  if (normalized === 'shoebox') return 'Shoebox';
  return '';
}

export function formatSandboxPhaseLabel(value) {
  const raw = clean(value).toLowerCase();
  return PHASE_LABELS[raw] || PHASE_LABELS.label_created;
}

export function nextSandboxPhase(value) {
  const raw = clean(value).toLowerCase();
  if (raw === 'label_created') return 'in_transit';
  if (raw === 'in_transit') return 'out_for_delivery';
  if (raw === 'out_for_delivery') return 'delivered';
  return null;
}

export function inferParcelProfileFromListing(listing = {}) {
  const explicit = normalizeParcelProfile(listing?.parcelProfile);
  if (explicit) return explicit;

  const haystack = [
    listing?.category,
    listing?.title,
    listing?.description,
    ...(Array.isArray(listing?.tags) ? listing.tags : []),
  ]
    .map((entry) => clean(entry).toLowerCase())
    .filter(Boolean)
    .join(' ');

  if (/\b(shoe|shoes|sneaker|sneakers|boot|boots|heel|heels|loafer|loafers|trainer|trainers)\b/.test(haystack)) {
    return 'shoebox';
  }
  if (/\b(hoodie|sweatshirt|knitwear|jumper|jeans|trousers|pants|coat|outerwear|puffer|jacket)\b/.test(haystack)) {
    return 'bulky_garment';
  }
  return 'small_garment';
}

export function getShippingCoConfig(env = process.env) {
  const appEnv = normalizeAppEnv(env.APP_ENV);

  return {
    appEnv,
    fixedFees: {
      small_garment: toCentsFromGbp(readStageEnv('ROYAL_MAIL_FIXED_FEE_SMALL_GARMENT_GBP', env, appEnv), 4.99),
      bulky_garment: toCentsFromGbp(readStageEnv('ROYAL_MAIL_FIXED_FEE_BULKY_GARMENT_GBP', env, appEnv), 6.99),
      shoebox: toCentsFromGbp(readStageEnv('ROYAL_MAIL_FIXED_FEE_SHOEBOX_GBP', env, appEnv), 7.99),
    },
    sandboxTimings: {
      inTransitMs: readDurationMs({
        env,
        appEnv,
        secondsName: 'ROYAL_MAIL_SANDBOX_IN_TRANSIT_SEC',
        minutesName: 'ROYAL_MAIL_SANDBOX_IN_TRANSIT_MIN',
        defaultSeconds: 20,
      }),
      outForDeliveryMs: readDurationMs({
        env,
        appEnv,
        secondsName: 'ROYAL_MAIL_SANDBOX_OUT_FOR_DELIVERY_SEC',
        minutesName: 'ROYAL_MAIL_SANDBOX_OUT_FOR_DELIVERY_MIN',
        defaultSeconds: 40,
      }),
      deliveredMs: readDurationMs({
        env,
        appEnv,
        secondsName: 'ROYAL_MAIL_SANDBOX_DELIVERED_SEC',
        minutesName: 'ROYAL_MAIL_SANDBOX_DELIVERED_MIN',
        defaultSeconds: 60,
      }),
    },
  };
}

function makeFixedQuote(config, parcelProfile) {
  const normalized = normalizeParcelProfile(parcelProfile) || 'small_garment';
  const configuredAmount = Number(config.fixedFees[normalized]);
  const amount =
    Number.isFinite(configuredAmount) && configuredAmount > 0
      ? Math.round(configuredAmount)
      : DEFAULT_FIXED_FEES[normalized];
  const service = FIXED_SERVICES[normalized];
  return {
    carrier: 'ShippingCo',
    service,
    rate: (amount / 100).toFixed(2),
    currency: 'GBP',
    amount,
    provider: 'fixed',
    providerMode: 'fixed',
    parcelProfile: normalized,
    displayLabel: 'ShippingCo',
    isFallback: false,
  };
}

export async function quoteShippingCoShipment(config, parcelProfile, fromAddress, toAddress) {
  sanitizeShippingCoAddress(fromAddress);
  sanitizeShippingCoAddress(toAddress);
  const normalized = normalizeParcelProfile(parcelProfile) || 'small_garment';
  return makeFixedQuote(config, normalized);
}

export function createSandboxSchedule(config, createdAtMs) {
  return {
    inTransitAtMs: createdAtMs + config.sandboxTimings.inTransitMs,
    outForDeliveryAtMs: createdAtMs + config.sandboxTimings.outForDeliveryMs,
    deliveredAtMs: createdAtMs + config.sandboxTimings.deliveredMs,
  };
}

export function createSandboxEvent(phase, isoTimestamp) {
  return {
    status: phase,
    label: formatSandboxPhaseLabel(phase),
    at: isoTimestamp,
    source: 'sandbox',
  };
}

export function phaseDueForSchedule(sandbox, nowMs) {
  const phase = clean(sandbox?.trackingPhase || 'label_created').toLowerCase();
  const schedule = sandbox?.schedule || {};
  if (phase === 'label_created' && Number(schedule.inTransitAtMs || 0) <= nowMs) return 'in_transit';
  if (phase === 'in_transit' && Number(schedule.outForDeliveryAtMs || 0) <= nowMs) return 'out_for_delivery';
  if (phase === 'out_for_delivery' && Number(schedule.deliveredAtMs || 0) <= nowMs) return 'delivered';
  return null;
}
