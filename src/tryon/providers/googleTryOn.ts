// src/tryon/providers/googleTryOn.ts
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy'; // ← FIX: use legacy API
import type { GarmentCategory, TryOnResult } from '../types';
import { getAuthBearerHeader } from '../../lib/apiAuth';
import { resolveDeviceUrl } from '../../config/runtime';

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

type Args = {
  selfieUri: string;
  garmentImageUri?: string;
  /** Optional product page/image URL so the server can fetch/verify bytes if needed */
  productUrl?: string;
  category?: GarmentCategory | string;
  size?: string;
  personMime?: 'image/jpeg' | 'image/png';
  productMime?: 'image/jpeg' | 'image/png';
  count?: number;      // default 1
  baseSteps?: number;  // default 24
};

/** Replace localhost for Android emulator. */
function resolveForDeviceHost(url: string) {
  if (Platform.OS !== 'android') return resolveDeviceUrl(url);
  return resolveDeviceUrl(url);
}

/** Join base + path safely (no double slashes). */
function joinUrl(base: string, path: string) {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function readExtra() {
  return (
    (Constants.expoConfig?.extra ||
      // legacy dev manifest fallback
      (Constants as any)?.manifest?.extra ||
      {}) as Record<string, any>
  );
}

/**
 * Resolve config:
 * - Prefer EXPO_PUBLIC_GOOGLE_TRYON_ENDPOINT (full URL ending in /tryon)
 * - Else try TRYON_BASE_URL / EXPO_PUBLIC_TRYON_BASE_URL and append /tryon
 */
function getConfig() {
  const extra = readExtra();

  // Full endpoint options (already include /tryon)
  const endpointFull =
    process.env.EXPO_PUBLIC_GOOGLE_TRYON_ENDPOINT ||
    extra.EXPO_PUBLIC_GOOGLE_TRYON_ENDPOINT ||
    extra.GOOGLE_TRYON_ENDPOINT;

  // Base URL options (host only; we will append /tryon)
  const baseRaw =
    process.env.TRYON_BASE_URL ||
    process.env.EXPO_PUBLIC_TRYON_BASE_URL ||
    extra.TRYON_BASE_URL ||
    extra.EXPO_PUBLIC_TRYON_BASE_URL ||
    (__DEV__ ? 'http://localhost:8787' : '');

  let endpoint = endpointFull?.trim() || '';
  if (!endpoint) {
    const base = (baseRaw || '').trim();
    if (base) endpoint = joinUrl(base, 'tryon');
  }

  if (!endpoint) {
    throw new Error(
      'Missing endpoint: set either EXPO_PUBLIC_GOOGLE_TRYON_ENDPOINT (full URL) or TRYON_BASE_URL (base) in app config or env.'
    );
  }

  endpoint = resolveForDeviceHost(endpoint);

  // Also derive a health URL for warmups
  const health =
    endpoint.replace(/\/tryon(\/*)?$/i, '/health') ||
    joinUrl((baseRaw || endpoint), 'health');

  return { endpoint, health };
}

async function toBase64(uri: string): Promise<string> {
  if (!uri) throw new Error('Empty URI');

  if (uri.startsWith('data:')) {
    const [, data] = uri.split(',');
    return data || '';
  }

  if (/^https?:\/\//i.test(uri)) {
    // Only used for selfieUri edge-cases; product should rely on productUrl to avoid big downloads.
    const tmp = FileSystem.cacheDirectory + `dl_${Date.now()}`;
    const res = await FileSystem.downloadAsync(uri, tmp, {
      // headers aren’t strictly required; keep UA just in case
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
    } as any);
    const b64 = await FileSystem.readAsStringAsync(res.uri, { encoding: 'base64' }); // ← FIX
    try { await FileSystem.deleteAsync(res.uri, { idempotent: true }); } catch {}
    return b64;
  }

  return FileSystem.readAsStringAsync(uri, { encoding: 'base64' }); // ← FIX
}

/** Quick Base64 sniff — restrict to JPEG/PNG (what Vertex expects). */
function sniffMimeFromB64(b64: string): 'image/png' | 'image/jpeg' | null {
  if (!b64) return null;
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  return null;
}

/** Finalize mime: prefer explicit hint, else sniff, else fallback. */
function finalizeMime(
  hint: any,
  b64: string,
  fallback: 'image/jpeg' | 'image/png'
): 'image/jpeg' | 'image/png' {
  const sniff = sniffMimeFromB64(b64);
  if (sniff) return sniff;
  if (hint === 'image/jpeg' || hint === 'image/png') return hint;
  return fallback;
}

// tiny helper used by warm/preconnect
async function safeFetch(url: string) {
  try { return await fetch(url); } catch { return null as any; }
}

export async function googleTryOn({
  selfieUri,
  garmentImageUri,
  productUrl, // prefer this to avoid client download
  category,
  size,
  personMime = 'image/jpeg',
  productMime = 'image/png',
  count = 1,
  baseSteps = 24,
}: Args): Promise<TryOnResult> {
  const { endpoint } = getConfig();

  // Read selfie b64 (usually local). For product: only read b64 if we *don’t* have productUrl.
  let selfie_b64 = '';
  let product_b64 = '';

  try {
    selfie_b64 = await toBase64(selfieUri);

    if (!productUrl && garmentImageUri) {
      // No productUrl fallback → we must send product bytes.
      product_b64 = await toBase64(garmentImageUri).catch(() => '');
    } else {
      // We have productUrl → let server fetch & normalize. Skip client download entirely.
      product_b64 = '';
    }
  } catch (err: any) {
    throw new Error(`Failed to read images: ${String(err?.message || err)}`);
  }

  if (!selfie_b64 || selfie_b64.length < 30) {
    throw new Error('Selfie image is empty or invalid.');
  }
  if ((!product_b64 || product_b64.length < 30) && !productUrl) {
    throw new Error('A product image should be provided.');
  }

  const personMimeFinal  = finalizeMime(personMime,  selfie_b64,  'image/jpeg');
  const productMimeFinal = product_b64?.length ? finalizeMime(productMime, product_b64, 'image/png') : 'image/png';

  const nImages = Math.max(1, Math.min(count ?? 1, 4));

  const body: Record<string, any> = {
    // Preferred keys that the server expects
    personB64: selfie_b64,
    productB64: product_b64 || '',

    // legacy keys (harmless, keep for older servers)
    selfie_b64: selfie_b64,
    garment_b64: product_b64 || '',

    // mimes (server currently normalizes, but send anyway)
    personMime: personMimeFinal,
    productMime: productMimeFinal,

    // server fallback path (avoid big client downloads)
    productUrl: productUrl ?? undefined,

    category: category ?? 'top',
    size: size ?? undefined,

    // IMPORTANT: server reads `count`, not `numberOfImages`
    count: nImages,
    numberOfImages: nImages, // (back-compat no-op on server)

    baseSteps,
    outputMimeType: 'image/png',
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(await getAuthBearerHeader()),
      },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    const msg = String(e?.message || e || 'Network request failed');
    const hint =
      ` — cannot reach ${endpoint}. If you’re on Android emulator use http://10.0.2.2:PORT; ` +
      `iOS simulator can use http://127.0.0.1:PORT; physical device must use your LAN IP.`;
    throw new Error(`Network request failed${hint} Original error: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Try-on service error ${res.status}: ${text || res.statusText}`);
  }

  const json: any = await res.json().catch(() => ({}));

  let outputUri: string | null = null;
  if (json.image_b64 || json.imageBase64 || json.output_b64) {
    const b64 = json.image_b64 || json.imageBase64 || json.output_b64;
    const out = FileSystem.cacheDirectory + `tryon_${Date.now()}.png`;
    await FileSystem.writeAsStringAsync(out, b64, { encoding: 'base64' }); // ← FIX
    outputUri = out;
  } else if (json.url || json.outputUrl) {
    outputUri = json.url || json.outputUrl;
  }

  if (!outputUri) throw new Error('Try-on service did not return an image.');
  return { outputUri };
}

/* Optional warm/preconnect hooks used by the UI */
(googleTryOn as any).warm = async () => {
  const { health } = getConfig();
  await safeFetch(health);
};
(googleTryOn as any).preconnect = async () => {
  const { endpoint } = getConfig();
  await safeFetch(endpoint);
};

export default googleTryOn;
