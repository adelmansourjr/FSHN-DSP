// src/tryon/TryOnEngine.ts
import * as FileSystem from 'expo-file-system/legacy'; // ← FIX
import * as ImageManipulator from 'expo-image-manipulator';
import type { GarmentCategory, TryOnResult } from './types';

// (lazy default provider)
let defaultProvider: any = null;
try {
  defaultProvider = require('./providers/googleTryOn').default;
} catch { /* optional */ }

export type Prepared = { uri: string; mime: 'image/jpeg' | 'image/png' };
export type Dims = { width: number; height: number };

export type ProviderRequest =
  & {
      selfieUri: string;
      personMime: 'image/jpeg' | 'image/png';
      category: GarmentCategory;
      count?: number;
      baseSteps?: number;
    }
  & (
      | { productUrl: string }
      | { garmentImageUri: string; productMime: 'image/jpeg' | 'image/png' }
    );

export type Provider = (req: ProviderRequest) => Promise<any>;

export type GenerateOptions = {
  provider?: Provider;
  selfieUri: string;
  category: GarmentCategory;
  productUrl?: string | null;
  garmentImageUri?: string | null;
  garmentMimeHint?: 'image/png' | 'image/jpeg' | null;
  baseSteps?: number;
  count?: number;
  knownSelfieDims?: Dims | null;
  maxSelfie?: number;
  maxProduct?: number;
  signal?: AbortSignal | null;
};

export type GenerateResponse = {
  outputUri: string;
  raw: any;
};

const CACHE_DIR = `${FileSystem.cacheDirectory}tryon/`;
async function ensureCacheDir() { try { await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true }); } catch {} }
function hash36(s: string) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i); return (h >>> 0).toString(36); }
export function guessMimeFromUri(u: string, fallback: 'image/jpeg' | 'image/png') {
  if (/^data:image\/[a-z0-9.+-]+;/i.test(u)) { const m = u.match(/^data:(image\/[a-z0-9.+-]+);/i); return (m?.[1]?.toLowerCase() as any) || fallback; }
  if (/\.png(?:\?|$)/i.test(u)) return 'image/png';
  if (/\.(jpg|jpeg)(?:\?|$)/i.test(u)) return 'image/jpeg';
  if (/\.webp(?:\?|$)/i.test(u)) return 'image/jpeg';
  if (/\.avif(?:\?|$)/i.test(u)) return 'image/jpeg';
  return fallback;
}
async function dataUriToFile(u: string): Promise<string> {
  await ensureCacheDir();
  const m = u.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!m) throw new Error('Bad data URI');
  const mime = m[1].toLowerCase();
  const b64 = m[2];
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  const name = `data_${hash36(u.slice(0, 128))}.${ext}`;
  const dest = `${CACHE_DIR}${name}`;
  const info = await FileSystem.getInfoAsync(dest);
  // ← FIX: plain string encoding for legacy
  if (!info.exists) await FileSystem.writeAsStringAsync(dest, b64, { encoding: 'base64' });
  return dest;
}
async function toLocalFile(u: string): Promise<string> {
  if (!u) throw new Error('Empty uri');
  if (u.startsWith('file://') || u.startsWith('content://')) return u;
  if (u.startsWith('data:')) return dataUriToFile(u);
  if (/^https?:\/\//i.test(u)) {
    await ensureCacheDir();
    const ext =
      /\.png(?:\?|$)/i.test(u) ? 'png' :
      /\.(jpg|jpeg)(?:\?|$)/i.test(u) ? 'jpg' :
      /\.webp(?:\?|$)/i.test(u) ? 'webp' :
      /\.avif(?:\?|$)/i.test(u) ? 'avif' : 'img';
    const name = `dl_${hash36(u)}.${ext}`;
    const dest = `${CACHE_DIR}${name}`;
    const info = await FileSystem.getInfoAsync(dest);
    if (info.exists) return info.uri;
    const res = await FileSystem.downloadAsync(u, dest);
    return res.uri;
  }
  return u;
}

/* cache */
type PrepKey = string;
const prepCache = new Map<PrepKey, Prepared>();
function prepCacheKey(u: string, kind: 'person' | 'product', max: number): PrepKey {
  return `${kind}:${max}:${hash36(u)}`;
}

export async function prepareImage(
  u: string,
  kind: 'person' | 'product',
  max = kind === 'person' ? 1152 : 1024,
  knownDims?: Dims | null
): Promise<Prepared> {
  const desiredMime: Prepared['mime'] = kind === 'product' ? 'image/png' : 'image/jpeg';
  const desiredFmt = kind === 'product' ? ImageManipulator.SaveFormat.PNG : ImageManipulator.SaveFormat.JPEG;
  const compress = kind === 'product' ? 1 : 0.9;

  const key = prepCacheKey(u, kind, max);
  const cached = prepCache.get(key);
  if (cached) return cached;

  try {
    const local = await toLocalFile(u);
    let w = knownDims?.width ?? 0;
    let h = knownDims?.height ?? 0;

    if (!w || !h) {
      const probe = await ImageManipulator.manipulateAsync(local, [], { compress, format: desiredFmt });
      // @ts-ignore
      w = (probe as any).width ?? max;
      // @ts-ignore
      h = (probe as any).height ?? max;
      const scale = Math.min(1, max / Math.max(w, h));
      const ops = scale < 1 ? [{ resize: { width: Math.round(w * scale), height: Math.round(h * scale) } }] : [];
      const out = await ImageManipulator.manipulateAsync(probe.uri, ops, { compress, format: desiredFmt });
      const prepared: Prepared = { uri: out.uri, mime: desiredMime };
      prepCache.set(key, prepared);
      return prepared;
    }

    const scale = Math.min(1, max / Math.max(w, h));
    const ops = scale < 1 ? [{ resize: { width: Math.round(w * scale), height: Math.round(h * scale) } }] : [];
    const out = await ImageManipulator.manipulateAsync(local, ops, { compress, format: desiredFmt });
    const prepared: Prepared = { uri: out.uri, mime: desiredMime };
    prepCache.set(key, prepared);
    return prepared;
  } catch {
    try {
      const local = await toLocalFile(u);
      const prepared: Prepared = { uri: local, mime: guessMimeFromUri(u, desiredMime) };
      prepCache.set(key, prepared);
      return prepared;
    } catch {
      const prepared: Prepared = { uri: u, mime: guessMimeFromUri(u, desiredMime) };
      prepCache.set(key, prepared);
      return prepared;
    }
  }
}

export async function warmTryOn(provider: any = defaultProvider) {
  try { await provider?.warm?.(); } catch {}
  try { await provider?.preconnect?.(); } catch {}
}

function extractOutputUri(raw: any): string | null {
  const r = Array.isArray(raw) ? raw[0] : raw;
  const c =
    r?.outputUri ?? r?.outputURL ?? r?.url ?? r?.uri ?? r?.image ?? r?.result ??
    (typeof r === 'string' ? r : '');
  return (typeof c === 'string' && c.length > 4) ? c : null;
}

export async function generateTryOn(opts: GenerateOptions): Promise<GenerateResponse> {
  const {
    provider = defaultProvider,
    selfieUri,
    category,
    productUrl,
    garmentImageUri,
    garmentMimeHint = null,
    baseSteps = 32,
    count = 1,
    knownSelfieDims = null,
    maxSelfie = 1152,
    maxProduct = 1024,
    signal = null,
  } = opts;

  if (!provider) throw new Error('No try-on provider supplied.');
  if (!selfieUri) throw new Error('Missing selfieUri');
  if (!category) throw new Error('Missing category');

  warmTryOn(provider).catch(() => {});

  const preparedSelfie = await prepareImage(selfieUri, 'person', maxSelfie, knownSelfieDims);

  let request: ProviderRequest;
  if (productUrl && /^https?:\/\//i.test(productUrl)) {
    request = {
      selfieUri: preparedSelfie.uri,
      personMime: preparedSelfie.mime,
      category,
      baseSteps,
      count,
      productUrl,
    };
  } else {
    if (!garmentImageUri) throw new Error('Either productUrl or garmentImageUri must be provided.');
    const preparedGarment = await prepareImage(garmentImageUri, 'product', maxProduct, null);
    request = {
      selfieUri: preparedSelfie.uri,
      personMime: preparedSelfie.mime,
      category,
      baseSteps,
      count,
      garmentImageUri: preparedGarment.uri,
      productMime: garmentMimeHint || preparedGarment.mime,
    };
  }

  if (signal) (request as any).signal = signal;

  const raw = await provider(request);
  const out = extractOutputUri(raw);
  if (!out) throw new Error('No image returned from try-on provider.');

  return { outputUri: out, raw };
}

export async function generateTryOnResult(opts: GenerateOptions): Promise<TryOnResult> {
  const r = await generateTryOn(opts);
  return { outputUri: r.outputUri };
}
