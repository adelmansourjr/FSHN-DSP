import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { CLASSIFIER_ENDPOINT } from '../config/classifier';
import { buildJsonHeaders } from '../lib/apiAuth';

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export type ClassifyResult = {
  category?: string | null;
  brand?: string | null;
  color?: string | null;
  colors?: string[];
  gender?: string | null;
  sub?: string | null;
  fit?: string | null;
  vibes?: string[];
  occasionTags?: string[];
  styleMarkers?: string[];
  formalityScore?: number | null;
  streetwearScore?: number | null;
  cleanlinessScore?: number | null;
  confidence?: Record<string, any> | null;
  tags: string[];
  raw?: Record<string, any>;
};

type Options = {
  signal?: AbortSignal;
  minColours?: number;
};

const CLASSIFIER_TMP_PREFIX = `${FileSystem.cacheDirectory || ''}classifier_`;

const cleanupTempUris = async (uris: string[]) => {
  const seen = new Set<string>();
  for (const uri of uris) {
    const target = String(uri || '').trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    try {
      await FileSystem.deleteAsync(target, { idempotent: true });
    } catch {
      // ignore cleanup failures
    }
  }
};

const writeDataUriToTemp = async (uri: string) => {
  const headerMatch = uri.match(/^data:(image\/[\w.+-]+);base64,/i);
  const ext =
    headerMatch?.[1]?.toLowerCase().includes('png') ? 'png' :
    headerMatch?.[1]?.toLowerCase().includes('jpeg') || headerMatch?.[1]?.toLowerCase().includes('jpg') ? 'jpg' :
    'img';
  const fileUri = `${CLASSIFIER_TMP_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const [, data] = uri.split(',');
  await FileSystem.writeAsStringAsync(fileUri, data || '', { encoding: 'base64' });
  return fileUri;
};

const normalizeForRemoteClassifier = async (uri: string) => {
  const tempUris: string[] = [];
  let sourceUri = uri;

  if (uri.startsWith('data:')) {
    const dataMime = uri.match(/^data:(image\/[\w.+-]+);base64,/i)?.[1]?.toLowerCase() || '';
    if (dataMime === 'image/png' || dataMime === 'image/jpeg' || dataMime === 'image/jpg') {
      const [, data] = uri.split(',');
      return { imageB64: data || '', tempUris };
    }
    sourceUri = await writeDataUriToTemp(uri);
    tempUris.push(sourceUri);
  } else if (/^https?:\/\//i.test(uri)) {
    const ext =
      /\.png(?:\?|$)/i.test(uri) ? 'png' :
      /\.(jpe?g)(?:\?|$)/i.test(uri) ? 'jpg' :
      /\.(webp|avif)(?:\?|$)/i.test(uri) ? 'img' :
      'img';
    const downloadUri = `${CLASSIFIER_TMP_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const res = await FileSystem.downloadAsync(uri, downloadUri, {
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
    } as any);
    sourceUri = res.uri;
    tempUris.push(sourceUri);
  }

  const normalized = await ImageManipulator.manipulateAsync(sourceUri, [], {
    compress: 0.92,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  tempUris.push(normalized.uri);
  const imageB64 = await FileSystem.readAsStringAsync(normalized.uri, { encoding: 'base64' });
  return { imageB64, tempUris };
};

async function toBase64(uri: string): Promise<string> {
  if (!uri) throw new Error('Empty URI');

  let prepared:
    | {
        imageB64: string;
        tempUris: string[];
      }
    | null = null;
  try {
    prepared = await normalizeForRemoteClassifier(uri);
    return prepared.imageB64;
  } finally {
    if (prepared?.tempUris?.length) {
      await cleanupTempUris(prepared.tempUris);
    }
  }
}

export async function classifyPhoto(
  uri: string,
  opts: Options = {},
): Promise<ClassifyResult> {
  if (!CLASSIFIER_ENDPOINT) {
    throw new Error(
      'Classifier endpoint is not configured. Set EXPO_PUBLIC_CLASSIFIER_ENDPOINT or CLASSIFIER_BASE_URL.',
    );
  }

  const imageB64 = await toBase64(uri);
  const body = {
    imageB64,
    min_colours: opts.minColours,
  };

  let payloadText = '';
  let contentType: string | null = null;

  const res = await fetch(CLASSIFIER_ENDPOINT, {
    method: 'POST',
    headers: await buildJsonHeaders(),
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  contentType = res.headers.get('content-type');
  payloadText = await res.text();

  if (!res.ok) {
    const message = extractErrorMessage(payloadText) ?? `Classifier request failed (${res.status})`;
    throw new Error(message);
  }

  const json = safeJsonParse(payloadText, contentType);
  if (!json) throw new Error('Classifier returned an invalid response.');

  const tags = Array.isArray(json.tags) ? json.tags.map(String) : [];
  return {
    category: json.category ?? null,
    brand: json.brand ?? null,
    color: json.color ?? null,
    colors: Array.isArray(json.colors) ? json.colors.map(String) : undefined,
    gender: json.gender ?? json.sex ?? json.targetGender ?? null,
    sub: json.sub ?? null,
    fit: json.fit ?? null,
    vibes: Array.isArray(json.vibes) ? json.vibes.map(String) : undefined,
    occasionTags: Array.isArray(json.occasionTags) ? json.occasionTags.map(String) : undefined,
    styleMarkers: Array.isArray(json.styleMarkers) ? json.styleMarkers.map(String) : undefined,
    formalityScore: Number.isFinite(Number(json.formalityScore)) ? Number(json.formalityScore) : null,
    streetwearScore: Number.isFinite(Number(json.streetwearScore)) ? Number(json.streetwearScore) : null,
    cleanlinessScore: Number.isFinite(Number(json.cleanlinessScore)) ? Number(json.cleanlinessScore) : null,
    confidence: json.confidence && typeof json.confidence === 'object' ? json.confidence : null,
    tags,
    raw: json.raw ?? undefined,
  };
}

function safeJsonParse(payload: string, contentType?: string | null) {
  if (!payload) return null;
  if (contentType && !/json/i.test(contentType)) {
    // still try parsing; Cloud Run may not set content-type
  }
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function extractErrorMessage(payload: string) {
  if (!payload) return null;
  try {
    const json = JSON.parse(payload);
    return json?.error || json?.message || null;
  } catch {
    return null;
  }
}
