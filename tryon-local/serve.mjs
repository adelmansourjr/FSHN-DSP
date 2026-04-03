// tryon-local/serve.mjs
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleAuth } from 'google-auth-library';
import vision from '@google-cloud/vision';
import { initializeApp as initializeAdminApp, getApps as getAdminApps, cert as adminCert, applicationDefault as adminApplicationDefault } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import sharp from 'sharp';
import { randomUUID } from 'crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getTryOnRuntimeConfig, validateTryOnConfig } from './config.mjs';

/* ───────────────────────── config ───────────────────────── */
const runtimeConfig = validateTryOnConfig(getTryOnRuntimeConfig());
const PORT = Number(runtimeConfig.port || 8787) || 8787;
const HOST = '0.0.0.0';

const PROJECT = runtimeConfig.googleCloudProject;
const LOCATION = runtimeConfig.googleCloudLocation;
const MODEL = runtimeConfig.virtualTryOnModel;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = __dirname;
const MONOREPO_ROOT = path.resolve(APP_ROOT, '..');
const RECOMMENDER_ASSETS_DIR = path.resolve(APP_ROOT, 'recommender-assets');
const RECOMMENDER_SOURCE_DIR = path.resolve(APP_ROOT, 'reccomender');
const CLASSIFIER_SOURCE_DIR = path.resolve(APP_ROOT, 'classifier');
const CLASSIFIER_ASSETS_DIR = path.resolve(APP_ROOT, 'classifier-assets');

function resolveExistingPath(...candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const full = path.resolve(candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

const CLASSIFIER_LOCAL_SOURCE = resolveExistingPath(path.join(CLASSIFIER_SOURCE_DIR, 'classify_images.ts'));
const CLASSIFIER_LOCAL_ASSET = resolveExistingPath(path.join(CLASSIFIER_ASSETS_DIR, 'classify_images.ts'));
const CLASSIFIER_MONOREPO_SOURCE = resolveExistingPath(
  path.join(MONOREPO_ROOT, 'src/components/classifier/classify_images.ts')
);

function resolveClassifierScriptPath() {
  const explicit = resolveExistingPath(process.env.CLASSIFIER_SCRIPT_PATH);
  if (explicit) {
    const explicitPath = path.resolve(explicit);
    if (CLASSIFIER_MONOREPO_SOURCE && explicitPath === path.resolve(CLASSIFIER_MONOREPO_SOURCE) && CLASSIFIER_LOCAL_SOURCE) {
      console.warn(
        '[classifier] CLASSIFIER_SCRIPT_PATH points at the app source copy; using tryon-local/classifier/classify_images.ts instead so runtime dependencies resolve correctly.'
      );
      return CLASSIFIER_LOCAL_SOURCE;
    }
    return explicitPath;
  }
  return CLASSIFIER_LOCAL_SOURCE || CLASSIFIER_LOCAL_ASSET || CLASSIFIER_MONOREPO_SOURCE || null;
}

const CLASSIFIER_SCRIPT = resolveClassifierScriptPath();
const RECOMMENDER_INDEX = resolveExistingPath(
  process.env.RECOMMENDER_INDEX_PATH,
  path.join(RECOMMENDER_ASSETS_DIR, 'index.json'),
  path.join(MONOREPO_ROOT, 'src/data/index.json'),
);
const RECOMMENDER_EMBEDDINGS = resolveExistingPath(
  process.env.RECOMMENDER_EMBEDDINGS_PATH,
  path.join(RECOMMENDER_ASSETS_DIR, 'index.embeddings.json'),
  path.join(MONOREPO_ROOT, 'src/data/index.embeddings.json'),
);
const RECOMMENDER_FARFETCH_INDEX = resolveExistingPath(
  process.env.RECOMMENDER_FARFETCH_INDEX_PATH,
  path.join(RECOMMENDER_ASSETS_DIR, 'index.classifiedfarfetch.json'),
  path.join(MONOREPO_ROOT, 'src/data/index.classifiedfarfetch.json'),
);
const RECOMMENDER_FARFETCH_EMBEDDINGS = resolveExistingPath(
  process.env.RECOMMENDER_FARFETCH_EMBEDDINGS_PATH,
  path.join(RECOMMENDER_ASSETS_DIR, 'index.classified.embeddingsfarfetch.json'),
  path.join(MONOREPO_ROOT, 'src/data/index.classified.embeddingsfarfetch.json'),
);
const RECOMMENDER_POOL_SIZE = Number(process.env.RECOMMENDER_POOL_SIZE || 5);
const RECOMMENDER_PER_ROLE_LIMIT = Number(process.env.RECOMMENDER_PER_ROLE_LIMIT || 18);
const RECOMMENDER_TIMEOUT_MS = Number(process.env.RECOMMENDER_TIMEOUT_MS || 120_000);
const RECOMMENDER_PROJECT = process.env.RECOMMENDER_PROJECT || PROJECT;
const RECOMMENDER_LOCATION = process.env.RECOMMENDER_LOCATION || process.env.RECOMMENDER_GEMINI_LOCATION || 'global';
const RECOMMENDER_MODEL = process.env.RECOMMENDER_MODEL || process.env.RECOMMENDER_GEMINI_MODEL || 'gemini-2.5-flash';
const RECOMMENDER_EMBEDDING_MODEL = process.env.RECOMMENDER_EMBEDDING_MODEL || 'gemini-embedding-001';
const RECOMMENDER_PARSER_MODE = process.env.RECOMMENDER_PARSER_MODE || 'auto';
const RECOMMENDER_EMBEDDING_MODE = process.env.RECOMMENDER_EMBEDDING_MODE || 'hybrid';
const RECOMMENDER_GEMINI_TIMEOUT_MS = Number(process.env.RECOMMENDER_GEMINI_TIMEOUT_MS || 20_000);
const RECOMMENDER_EPSILON = process.env.RECOMMENDER_EPSILON || '0.08';
const RECOMMENDER_JITTER = process.env.RECOMMENDER_JITTER || '0.03';
const RECOMMENDER_DEBUG = (process.env.RECOMMENDER_DEBUG || '0') === '1';
const RECOMMENDER_LIVE_REFRESH_TTL_MS = Number(process.env.RECOMMENDER_LIVE_REFRESH_TTL_MS || 120_000);
const RECOMMENDER_TIMING_LOGS = (process.env.RECOMMENDER_TIMING_LOGS || '0') === '1';
const INGEST_API_KEY = String(runtimeConfig.ingestApiKey || '').trim();
const CLASSIFIER_TIMEOUT_MS = Number(process.env.CLASSIFIER_TIMEOUT_MS || 120_000);
const CLASSIFIER_MIN_COLOURS = Number(process.env.CLASSIFIER_MIN_COLOURS || 1);
const GOOGLE_SEARCH_API_KEY = String(
  process.env.GOOGLE_SEARCH_API_KEY ||
  process.env.EXPO_PUBLIC_GOOGLE_SEARCH_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  ''
).trim();
const GOOGLE_SEARCH_CX = String(
  process.env.GOOGLE_SEARCH_CX ||
  process.env.EXPO_PUBLIC_GOOGLE_SEARCH_CX ||
  process.env.GOOGLE_CUSTOM_SEARCH_CX ||
  ''
).trim();
const GOOGLE_SEARCH_ENDPOINT = 'https://customsearch.googleapis.com/customsearch/v1';
const VISION_WEB_DEFAULT_NUM = Math.max(1, Number(process.env.VISION_WEB_DEFAULT_NUM || 8) || 8);
const VISION_WEB_MAX_NUM = Math.max(1, Number(process.env.VISION_WEB_MAX_NUM || 10) || 10);
const visionClient = new vision.ImageAnnotatorClient();

const TSX_BIN =
  process.env.TSX_PATH ||
  path.resolve(
    __dirname,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
  );

const CLASSIFIER_SCRIPT_DIR = CLASSIFIER_SCRIPT ? path.dirname(CLASSIFIER_SCRIPT) : APP_ROOT;
const LOCAL_NODE_MODULES = path.resolve(APP_ROOT, 'node_modules');

const RECOMMENDER_INDEX_EXISTS = Boolean(RECOMMENDER_INDEX);
const RECOMMENDER_EMBEDDINGS_EXISTS = Boolean(RECOMMENDER_EMBEDDINGS);
const RECOMMENDER_FARFETCH_INDEX_EXISTS = Boolean(RECOMMENDER_FARFETCH_INDEX);
const RECOMMENDER_FARFETCH_EMBEDDINGS_EXISTS = Boolean(RECOMMENDER_FARFETCH_EMBEDDINGS);
const CLASSIFIER_SCRIPT_EXISTS = Boolean(CLASSIFIER_SCRIPT);
const TSX_EXISTS = fs.existsSync(TSX_BIN);

if (!RECOMMENDER_INDEX_EXISTS) {
  console.warn('[recommender] index.json not found; run npm run prepare:recommender or set RECOMMENDER_INDEX_PATH.');
}
if (!RECOMMENDER_EMBEDDINGS_EXISTS) {
  console.warn('[recommender] index.embeddings.json not found; run npm run prepare:recommender or set RECOMMENDER_EMBEDDINGS_PATH.');
}
if (!RECOMMENDER_FARFETCH_INDEX_EXISTS) {
  console.warn('[recommender] index.classifiedfarfetch.json not found; run npm run prepare:recommender or set RECOMMENDER_FARFETCH_INDEX_PATH.');
}
if (!RECOMMENDER_FARFETCH_EMBEDDINGS_EXISTS) {
  console.warn('[recommender] index.classified.embeddingsfarfetch.json not found; run npm run prepare:recommender or set RECOMMENDER_FARFETCH_EMBEDDINGS_PATH.');
}
if (!TSX_EXISTS) {
  console.warn('[recommender] tsx runtime not found at', TSX_BIN, '— install `tsx` dependency.');
}
if (!CLASSIFIER_SCRIPT_EXISTS) {
  console.warn('[classifier] CLI script not found; run npm run prepare:recommender or set CLASSIFIER_SCRIPT_PATH.');
} else {
  console.log('[classifier] using script:', CLASSIFIER_SCRIPT);
}

const RECOMMENDER_ENABLED =
  RECOMMENDER_INDEX_EXISTS &&
  RECOMMENDER_EMBEDDINGS_EXISTS &&
  RECOMMENDER_FARFETCH_INDEX_EXISTS &&
  RECOMMENDER_FARFETCH_EMBEDDINGS_EXISTS;
const CLASSIFIER_ENABLED = CLASSIFIER_SCRIPT_EXISTS && TSX_EXISTS;
const CATEGORY_KEYS = ['top', 'bottom', 'mono', 'shoes'];
const GENDER_PREFS = new Set(['any', 'men', 'women']);

const PERSON_MAX_LONG   = Number(process.env.TRYON_PERSON_MAX_LONG   || 1152);
const PRODUCT_MAX_LONG  = Number(process.env.TRYON_PRODUCT_MAX_LONG  || 1024);
// Hard cap to avoid OpenCV’s “> 1<<30 pixels” guard; 80M px is plenty for our use.
const INPUT_PIXEL_LIMIT = Number(process.env.TRYON_INPUT_PIXEL_LIMIT || 80000000);

const DEBUG = (process.env.TRYON_DEBUG || '1') !== '0';

const JOB_TTL_MS = Number(process.env.TRYON_JOB_TTL_MS || 30 * 60 * 1000); // 30 minutes
const JOB_SWEEP_INTERVAL_MS = Number(process.env.TRYON_JOB_SWEEP_INTERVAL_MS || 5 * 60 * 1000); // 5 minutes

// CORS allowlist: leave CORS_ORIGINS empty to allow all (native apps don't send Origin)
const CORS_ORIGINS = (runtimeConfig.corsOrigins || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const ALLOW_GUEST_AI_ROUTES = runtimeConfig.allowGuestAiRoutes;

// If running on Cloud Run, env K_SERVICE is set
const IS_CLOUD_RUN = !!process.env.K_SERVICE;

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function logStructured(level, event, payload = {}) {
  const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  target(
    JSON.stringify({
      service: 'tryon-api',
      event,
      appEnv: runtimeConfig.appEnv,
      timestamp: new Date().toISOString(),
      ...payload,
    }),
  );
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || '').trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function authResultForLog(req) {
  if (req.authMode === 'guest') return 'guest';
  if (req.authUid) return 'verified';
  return getBearerToken(req) ? 'present-unverified' : 'missing';
}

/* ───────────────────────── app ───────────────────────── */
const app = express();
app.set('trust proxy', 1);

// CORS: allow mobile (no Origin) and allowed web origins when provided
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // native apps / curl
      if (CORS_ORIGINS.length === 0) return cb(null, true); // allow all if not configured
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'), false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
    credentials: false,
  })
);
// Handle preflight quickly
app.options('*', cors());

app.use(express.json({ limit: '32mb' }));
app.use((req, res, next) => {
  const requestId = String(req.headers['x-request-id'] || '').trim() || randomUUID();
  const startedAt = Date.now();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  res.on('finish', () => {
    const body =
      req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    logStructured('log', 'http_request', {
      requestId,
      method: req.method,
      route: String(req.originalUrl || req.url || '').slice(0, 240),
      status: res.statusCode,
      latencyMs: Date.now() - startedAt,
      authResult: authResultForLog(req),
      authUid: req.authUid || undefined,
      jobId: String(req.params?.jobId || body?.jobId || '').trim() || undefined,
      listingId: String(body?.listingId || body?.listing_id || '').trim() || undefined,
    });
  });
  next();
});

app.get('/', (_req, res) =>
  res.type('text/plain').send('MODA Try-On API is up. See /health')
);

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    project: PROJECT,
    location: LOCATION,
    model: MODEL,
    cloudRun: IS_CLOUD_RUN,
    recommenderConfigured: RECOMMENDER_ENABLED,
    classifierConfigured: CLASSIFIER_ENABLED,
    recommenderProject: RECOMMENDER_PROJECT,
    recommenderLocation: RECOMMENDER_LOCATION,
    recommenderModel: RECOMMENDER_MODEL,
    recommenderEmbeddingModel: RECOMMENDER_EMBEDDING_MODEL,
    ingestConfigured: Boolean(INGEST_API_KEY),
    guestAiRoutesEnabled: ALLOW_GUEST_AI_ROUTES,
    visionWebSearchConfigured: true,
    visionWebSearchMode:
      GOOGLE_SEARCH_API_KEY && GOOGLE_SEARCH_CX
        ? 'vision-web-detection+custom-search'
        : 'vision-web-detection',
  })
);

/* ───────────────────── helpers & logging ───────────────────── */
function stripDataUri(b64OrDataUri = '') {
  const m = String(b64OrDataUri).match(/^data:\w+\/[\w.+-]+;base64,(.+)$/i);
  return m ? m[1] : b64OrDataUri;
}
function firstBytesHex(buf, n = 12) {
  return Buffer.from(buf.slice(0, n)).toString('hex');
}
function sniffMagic(buf) {
  if (!buf?.length) return 'empty';
  const h = firstBytesHex(buf, 12);
  if (h.startsWith('89504e470d0a1a0a')) return 'png';
  if (h.startsWith('ffd8ff')) return 'jpeg';
  if (h.startsWith('52494646') && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.slice(4, 8).toString() === 'ftyp') {
    const brand = buf.slice(8, 16).toString();
    if (/avif|avis/i.test(brand)) return 'avif';
    return `mp4/iso (${brand})`;
  }
  return `unknown (${h})`;
}

function wantsAsync(body = {}, query = {}) {
  const flag =
    body.async ?? body.asyncMode ?? body.background ??
    query.async ?? query.asyncMode ?? query.background;
  if (typeof flag === 'string') return flag === '1' || flag.toLowerCase() === 'true';
  return Boolean(flag);
}

function sanitizeTryOnInput(payload = {}) {
  const {
    personB64,
    productB64,
    productUrl,
    selfie_b64,
    garment_b64,
    baseSteps,
    count,
    sampleCount,
    outputMimeType,
  } = payload;

  const personRaw = personB64 || selfie_b64;
  const productRaw = productB64 || garment_b64;

  if (!personRaw) throw new HttpError(400, 'Missing person image.');
  if (!productRaw && !productUrl) {
    throw new HttpError(400, 'Missing product image (productB64/garment_b64) and no productUrl provided.');
  }

  return {
    personB64: stripDataUri(personRaw),
    productB64: productRaw ? stripDataUri(productRaw) : undefined,
    productUrl: productUrl || undefined,
    baseSteps: Number(baseSteps || 32),
    count: Math.max(1, Math.min(Number(count ?? sampleCount ?? 1) || 1, 4)),
    outputMimeType: outputMimeType || 'image/png',
  };
}

async function resolveProductBuffer(input) {
  const { productB64, productUrl } = input;
  let productBuf = null;

  if (productB64) {
    try {
      const tmp = Buffer.from(productB64, 'base64');
      if (tmp.length > 0) {
        await sharp(tmp, { limitInputPixels: INPUT_PIXEL_LIMIT }).metadata();
        productBuf = tmp;
      }
    } catch (e) {
      console.warn('[warn] product base64 invalid or unreadable:', e?.message || e);
    }
  }

  if (!productBuf && productUrl) {
    try {
      productBuf = await fetchToBuffer(productUrl);
    } catch (e) {
      console.warn('[warn] productUrl fetch failed:', e?.message || e);
    }
  }

  if (!productBuf) {
    throw new HttpError(400, 'A product image should be provided (base64 or resolvable productUrl).');
  }

  return productBuf;
}

async function executeTryOn(input) {
  const personNorm = await normalizeForTryOn(input.personB64, 'person');
  const productBuf = await resolveProductBuffer(input);
  const productNorm = await normalizeForTryOn(productBuf, 'product');

  const nImages = Math.max(1, Math.min(Number(input.count || 1), 4));
  const steps = Number(input.baseSteps || 32);
  const outMime = input.outputMimeType || 'image/png';

  console.log('[tryon] input summary', {
    personB64_len: personNorm.b64.length,
    productB64_len: productNorm.b64.length,
    baseSteps: steps,
    count: nImages,
    outputMimeType: outMime,
  });

  let body = {
    instances: [
      {
        personImage: { image: { bytesBase64Encoded: personNorm.b64 } },
        productImages: [{ image: { bytesBase64Encoded: productNorm.b64 } }],
      },
    ],
    parameters: {
      baseSteps: steps,
      sampleCount: nImages,
      outputOptions: { mimeType: outMime },
    },
  };

  if (DEBUG) {
    const instanceKeys = Object.keys(body.instances?.[0] || {});
    console.log('[debug] request shape:', {
      instanceKeys,
      hasPersonImage: !!body.instances[0]?.personImage,
      hasProductImages: !!body.instances[0]?.productImages,
    });
  }

  let r = await vertexPredict(body);
  if (!r.ok) {
    const msg = r?.json?.error?.message || r.text || '';
    const tooBig = /too big|1<<30 pixels|Failed to decode image/i.test(msg);
    if (tooBig) {
      console.warn('[tryon] retrying with stronger clamp…');
      const personRetry = await normalizeForTryOn(Buffer.from(personNorm.b64, 'base64'), 'person');
      const productRetry = await normalizeForTryOn(Buffer.from(productNorm.b64, 'base64'), 'product');
      body = {
        ...body,
        instances: [
          {
            personImage: { image: { bytesBase64Encoded: personRetry.b64 } },
            productImages: [{ image: { bytesBase64Encoded: productRetry.b64 } }],
          },
        ],
      };
      r = await vertexPredict(body);
    }
  }

  if (!r.ok) {
    const msg = r?.json?.error?.message || r.text || `HTTP ${r.status}`;
    console.warn('[tryon] predict failed:', msg);
    throw new HttpError(r.status, msg);
  }

  const b64 = pickBase64(r.json);
  if (!b64) {
    console.warn('[tryon] success but no image payload; body head:', JSON.stringify(r.json || {}).slice(0, 400));
    throw new Error('No image in successful response');
  }

  return { image_b64: b64, mimeType: outMime };
}

const jobs = new Map();

function enqueueJob(input, creatorUid = '') {
  const id = randomUUID();
  const job = {
    id,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    creatorUid: String(creatorUid || '').trim(),
    input,
    result: null,
    error: null,
  };
  jobs.set(id, job);
  processTryOnJob(job).catch((err) => {
    console.error('[job] unexpected rejection', err);
  });
  return job;
}

async function processTryOnJob(job) {
  job.status = 'processing';
  job.updatedAt = Date.now();
  const input = job.input;
  try {
    job.result = await executeTryOn(input);
    job.status = 'succeeded';
  } catch (err) {
    job.error = err?.message || 'Unknown error';
    job.httpStatus = err?.status || 500;
    job.status = 'failed';
  } finally {
    job.input = undefined;
    job.updatedAt = Date.now();
  }
}

function cleanExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.updatedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

if (JOB_TTL_MS > 0) {
  const timer = setInterval(cleanExpiredJobs, JOB_SWEEP_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

async function getAccessToken() {
  // On Cloud Run: uses the service account automatically (no key file needed)
  // Locally: if GOOGLE_APPLICATION_CREDENTIALS is set, it will be used.
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token || !token.token) throw new Error('Failed to obtain access token');
  return token.token;
}

const vertexURL = () =>
  `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

function fetchWithTimeout(url, opts = {}, timeoutMs = 90_000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(t));
}

async function vertexPredict(body) {
  const r = await fetchWithTimeout(vertexURL(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { ok: r.ok, status: r.status, json, text };
}

async function fetchToBuffer(url) {
  const r = await fetchWithTimeout(url, {
    headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
  });
  if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  const ab = await r.arrayBuffer();
  const buf = Buffer.from(ab);
  if (DEBUG) {
    console.log('[debug] fetchToBuffer:', { ct, bytes: buf.length, magic: sniffMagic(buf) });
  }
  return buf;
}

/** normalize for try-on:
 *  - rotate by EXIF
 *  - clamp long edge (PERSON_MAX_LONG / PRODUCT_MAX_LONG)
 *  - enforce input pixel limit
 *  - person → JPEG (no alpha), product → PNG (keeps alpha)
 *  returns { b64, mime, outMeta }
 */
async function normalizeForTryOn(bufOrB64, kind /* 'person' | 'product' */) {
  const maxLong = kind === 'product' ? PRODUCT_MAX_LONG : PERSON_MAX_LONG;

  let buf;
  if (typeof bufOrB64 === 'string') {
    const clean = stripDataUri(bufOrB64);
    try { buf = Buffer.from(clean, 'base64'); }
    catch { throw new Error(`${kind}: not valid base64`); }
  } else {
    buf = bufOrB64;
  }
  if (!buf?.length) throw new Error(`${kind}: empty buffer`);

  let img = sharp(buf, { limitInputPixels: INPUT_PIXEL_LIMIT }).rotate();

  // read metadata for size/clamp
  let meta;
  try { meta = await img.metadata(); } catch (e) {
    img = sharp(buf, { limitInputPixels: INPUT_PIXEL_LIMIT }).rotate();
    try { meta = await img.metadata(); } catch {
      throw new Error(`${kind}: unreadable image`);
    }
  }

  const w = meta.width || maxLong;
  const h = meta.height || maxLong;
  const long = Math.max(w, h);
  if (long > maxLong) {
    const resize = (w >= h)
      ? { width: maxLong, withoutEnlargement: true, fit: 'inside', fastShrinkOnLoad: true }
      : { height: maxLong, withoutEnlargement: true, fit: 'inside', fastShrinkOnLoad: true };
    img = img.resize(resize);
  }

  // Person: drop alpha & JPEG; Product: keep alpha via PNG
  if (kind === 'person') {
    img = img.removeAlpha().jpeg({ quality: 90, mozjpeg: true });
  } else {
    img = img.png({ compressionLevel: 9, palette: false });
  }

  const out = await img.toBuffer();
  let outMeta = null;
  try { outMeta = await sharp(out).metadata(); } catch {}

  if (DEBUG) {
    console.log(`[debug] ${kind}: in=${w}x${h}, out=${outMeta?.width}x${outMeta?.height}, bytes=${out.length}, magic=${sniffMagic(out)}`);
  }

  return {
    b64: out.toString('base64'),
    mime: kind === 'person' ? 'image/jpeg' : 'image/png',
    outMeta,
  };
}

/* ───────────────────── response parsing ───────────────────── */
function pickBase64(resp) {
  if (!resp) return null;
  const preds = resp?.predictions || resp?.generatedImages || [];
  for (const p of preds) {
    if (p?.bytesBase64Encoded) return p.bytesBase64Encoded;
    if (p?.imageBytes) return p.imageBytes;
    if (p?.image?.imageBytes) return p.image.imageBytes;
  }
  const parts =
    resp?.candidates?.[0]?.content?.parts ||
    resp?.candidates?.[0]?.content?.[0]?.parts || [];
  for (const part of parts) {
    const d = part?.inline_data?.data || part?.inlineData?.data;
    if (d) return d;
  }
  return null;
}

/* ───────────────────── recommender helpers ───────────────────── */
function normalizeGenderPref(raw = 'any') {
  const lower = String(raw).toLowerCase();
  return GENDER_PREFS.has(lower) ? lower : 'any';
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function cleanVisionQuery(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function parseGoogleSearchError(payload) {
  if (!payload) return null;
  try {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return (
      parsed?.error?.message ||
      parsed?.error_description ||
      parsed?.message ||
      null
    );
  } catch {
    return String(payload).trim().slice(0, 220) || null;
  }
}

async function searchGoogleVisionWeb({ query, num = VISION_WEB_DEFAULT_NUM, safe = 'active' }) {
  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_CX) {
    throw new HttpError(
      503,
      'Vision web search is not configured on the server.',
      { missing: ['GOOGLE_SEARCH_API_KEY', 'GOOGLE_SEARCH_CX'] }
    );
  }

  const cleaned = cleanVisionQuery(query);
  if (!cleaned) throw new HttpError(400, 'query is required.');

  const cappedNum = clampInt(num, 1, VISION_WEB_MAX_NUM, VISION_WEB_DEFAULT_NUM);
  const safeMode = String(safe || 'active').toLowerCase() === 'off' ? 'off' : 'active';

  const params = new URLSearchParams({
    key: GOOGLE_SEARCH_API_KEY,
    cx: GOOGLE_SEARCH_CX,
    q: cleaned,
    num: String(cappedNum),
    searchType: 'image',
    safe: safeMode,
  });

  let response;
  try {
    response = await fetch(`${GOOGLE_SEARCH_ENDPOINT}?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
  } catch (err) {
    throw new HttpError(502, 'Failed to reach Google Custom Search.', { cause: err?.message || String(err) });
  }

  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    if (!response.ok) {
      throw new HttpError(response.status, parseGoogleSearchError(text) || 'Google search request failed.');
    }
    throw new HttpError(502, 'Google Custom Search returned malformed JSON.');
  }

  if (!response.ok) {
    throw new HttpError(response.status, parseGoogleSearchError(json) || `Google search failed (${response.status}).`);
  }

  const items = Array.isArray(json?.items) ? json.items : [];
  const results = items
    .map((row) => {
      const title = String(row?.title || '').trim();
      const imageUrl = String(row?.link || '').trim();
      const pageUrl = String(row?.image?.contextLink || row?.link || '').trim();
      const source = String(row?.displayLink || '').trim();
      const thumbnailUrl = String(row?.image?.thumbnailLink || row?.link || '').trim();
      if (!title || !imageUrl || !pageUrl) return null;
      return {
        title,
        imageUrl,
        pageUrl,
        source: source || 'google',
        thumbnailUrl,
      };
    })
    .filter(Boolean);

  return {
    query: cleaned,
    results,
    meta: {
      count: results.length,
      requested: cappedNum,
      safe: safeMode,
    },
  };
}

function safeHostFromUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname || '';
    return host.replace(/^www\./i, '') || 'web';
  } catch {
    return 'web';
  }
}

function normalizeVisionImageInput(body = {}) {
  const imageB64 =
    body.imageB64 ||
    body.image_b64 ||
    body.image ||
    body.photoB64 ||
    body.photo_b64 ||
    null;
  const imageUrl =
    body.imageUrl ||
    body.image_url ||
    body.url ||
    body.photoUrl ||
    body.photo_url ||
    null;
  return {
    imageB64: imageB64 ? stripDataUri(imageB64) : null,
    imageUrl: imageUrl ? String(imageUrl).trim() : null,
  };
}

async function searchVisionWebByImage({
  imageB64,
  imageUrl,
  query,
  num = VISION_WEB_DEFAULT_NUM,
}) {
  if (!imageB64 && !imageUrl) {
    throw new HttpError(400, 'imageB64 or imageUrl is required for vision web detection.');
  }

  const cappedNum = clampInt(num, 1, VISION_WEB_MAX_NUM, VISION_WEB_DEFAULT_NUM);
  const cleanedQuery = cleanVisionQuery(query || '');
  const visionImage = imageB64
    ? { content: imageB64 }
    : { source: { imageUri: imageUrl } };

  let detection;
  try {
    const [res] = await visionClient.webDetection({ image: visionImage });
    detection = res?.webDetection || {};
  } catch (err) {
    throw new HttpError(502, 'Google Vision web detection failed.', {
      cause: err?.message || String(err),
    });
  }

  const bestGuess = (detection.bestGuessLabels || [])
    .map((entry) => String(entry?.label || '').trim())
    .filter(Boolean)
    .slice(0, 2);

  const webEntities = (detection.webEntities || [])
    .map((entry) => String(entry?.description || '').trim())
    .filter(Boolean)
    .slice(0, 8);

  const pages = Array.isArray(detection.pagesWithMatchingImages) ? detection.pagesWithMatchingImages : [];
  const full = Array.isArray(detection.fullMatchingImages) ? detection.fullMatchingImages : [];
  const partial = Array.isArray(detection.partialMatchingImages) ? detection.partialMatchingImages : [];
  const visuallySimilar = Array.isArray(detection.visuallySimilarImages) ? detection.visuallySimilarImages : [];

  const fallbackTitle = cleanedQuery || bestGuess[0] || webEntities[0] || 'Visual match';
  const results = [];
  const seen = new Set();

  const pushResult = ({ title, imageUrl, pageUrl, thumbnailUrl }) => {
    const img = String(imageUrl || '').trim();
    const page = String(pageUrl || '').trim() || img;
    if (!img || !page) return;
    const key = `${img}|${page}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      title: String(title || fallbackTitle).trim() || fallbackTitle,
      imageUrl: img,
      pageUrl: page,
      thumbnailUrl: String(thumbnailUrl || img).trim() || img,
      source: safeHostFromUrl(page),
    });
  };

  for (const page of pages) {
    if (results.length >= cappedNum) break;
    const pageUrl = String(page?.url || '').trim();
    if (!pageUrl) continue;
    const pageTitle = String(page?.pageTitle || page?.title || '').trim();
    const pageFull = Array.isArray(page?.fullMatchingImages) ? page.fullMatchingImages : [];
    const pagePartial = Array.isArray(page?.partialMatchingImages) ? page.partialMatchingImages : [];
    const imageCandidate =
      String(pageFull[0]?.url || '').trim() ||
      String(pagePartial[0]?.url || '').trim() ||
      '';
    if (!imageCandidate) continue;
    pushResult({
      title: pageTitle || fallbackTitle,
      imageUrl: imageCandidate,
      pageUrl,
      thumbnailUrl: imageCandidate,
    });
  }

  for (const entry of visuallySimilar) {
    if (results.length >= cappedNum) break;
    const imageCandidate = String(entry?.url || '').trim();
    if (!imageCandidate) continue;
    pushResult({
      title: fallbackTitle,
      imageUrl: imageCandidate,
      pageUrl: imageCandidate,
      thumbnailUrl: imageCandidate,
    });
  }

  for (const entry of [...full, ...partial]) {
    if (results.length >= cappedNum) break;
    const imageCandidate = String(entry?.url || '').trim();
    if (!imageCandidate) continue;
    pushResult({
      title: fallbackTitle,
      imageUrl: imageCandidate,
      pageUrl: imageCandidate,
      thumbnailUrl: imageCandidate,
    });
  }

  return {
    query: cleanedQuery || fallbackTitle,
    results: results.slice(0, cappedNum),
    meta: {
      provider: 'vision-web-detection',
      count: results.length,
      requested: cappedNum,
      bestGuess,
      entities: webEntities,
    },
  };
}

let recommenderRuntimePromise = null;

async function getRecommenderRuntime() {
  if (!RECOMMENDER_ENABLED) {
    throw new HttpError(503, 'Recommender runtime is not available on this server.');
  }
  if (!recommenderRuntimePromise) {
    recommenderRuntimePromise = import('./recommender-runtime.mjs')
      .then(({ createRecommenderRuntime }) =>
        createRecommenderRuntime({
          originalIndexPath: RECOMMENDER_INDEX,
          originalEmbeddingPath: RECOMMENDER_EMBEDDINGS,
          farfetchIndexPath: RECOMMENDER_FARFETCH_INDEX,
          farfetchEmbeddingPath: RECOMMENDER_FARFETCH_EMBEDDINGS,
          liveRefreshTtlMs: RECOMMENDER_LIVE_REFRESH_TTL_MS,
        })
      )
      .catch((error) => {
        recommenderRuntimePromise = null;
        throw error;
      });
  }
  return recommenderRuntimePromise;
}

function buildRecommenderRequest({
  prompt,
  genderPref,
  poolSize,
  perRoleLimit,
  anchorEmbeddings,
  debug,
}) {
  return {
    indexPath: RECOMMENDER_INDEX,
    prompt,
    genderPref,
    anchorEmbeddings,
    parserMode: RECOMMENDER_PARSER_MODE,
    outputMode: 'json',
    embeddingMode: RECOMMENDER_EMBEDDING_MODE,
    embeddingSidecarPath: RECOMMENDER_EMBEDDINGS,
    project: RECOMMENDER_PROJECT,
    location: RECOMMENDER_LOCATION,
    model: RECOMMENDER_MODEL,
    embeddingModel: RECOMMENDER_EMBEDDING_MODEL,
    geminiTimeoutMs: RECOMMENDER_GEMINI_TIMEOUT_MS,
    poolSize,
    perRoleLimit,
    epsilon: Number(RECOMMENDER_EPSILON),
    jitter: Number(RECOMMENDER_JITTER),
    seed: null,
    intentOnly: false,
    intentJsonInPath: null,
    debug,
  };
}

function normalizeAnchorEmbeddingsPayload(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const id = String(entry?.id || '').trim();
      const slot = ['top', 'bottom', 'mono', 'shoes'].includes(String(entry?.slot || ''))
        ? String(entry.slot)
        : null;
      const vector = Array.isArray(entry?.vector)
        ? entry.vector.map((item) => Number(item)).filter((item) => Number.isFinite(item))
        : [];
      if (!id || !vector.length) return null;
      return { id, slot, vector };
    })
    .filter(Boolean);
}

function formatRecommendationItem(item, fallbackCategory = null) {
  if (!item?.imagePath) return null;
  const category = item.category || fallbackCategory || null;
  return {
    id: item.id || null,
    imagePath: item.imagePath,
    category,
    meta: {
      title: item.name || null,
      name: item.name || null,
      sub: item.sub || null,
      gender: item.gender || null,
      runtimeBlockFor: Array.isArray(item.runtimeBlockFor) ? item.runtimeBlockFor : [],
      colours: Array.isArray(item.colours) ? item.colours : [],
      vibes: Array.isArray(item.vibes) ? item.vibes : [],
      entities: Array.isArray(item.entities) ? item.entities : [],
      entityMeta: Array.isArray(item.entityMeta) ? item.entityMeta : [],
      occasion_tags: Array.isArray(item.occasion_tags) ? item.occasion_tags : [],
      style_markers: Array.isArray(item.style_markers) ? item.style_markers : [],
      formality_score: item.formality_score ?? null,
      streetwear_score: item.streetwear_score ?? null,
      cleanliness_score: item.cleanliness_score ?? null,
    },
  };
}

function formatLook(look) {
  const selection = {};
  for (const slot of CATEGORY_KEYS) {
    const item = look?.outfit?.[slot];
    const normalized = formatRecommendationItem(item, slot);
    if (normalized) selection[slot] = normalized;
  }
  return selection;
}

const FEMININE_RECOMMENDATION_VETO_RE =
  /\b(ruffled|blouse|camisole|tie neck|tie-neck|crop top|plunge|pointelle|lace-detail|corset|sleeveless|tank top|bralette|bodysuit|self-portrait|patou|max mara ribbed polo top|pump|pumps|heel|heels|stiletto|stilettos|slingback|slingbacks|mary jane|mary janes|kitten heel|kitten heels|legging|leggings|tights|stockings|hosiery|jeggings)\b/;
const MASCULINE_RECOMMENDATION_VETO_RE =
  /\b(boxy fit|workwear|field jacket|bomber|cargo trousers|drizzler|rugged|combat boot|heavyweight tee|menswear)\b/;

function normalizeRecommendationGender(value = '') {
  const raw = normalizeText(String(value || ''));
  if (!raw) return null;
  if (/\b(unisex|all|any|gender neutral|gender-neutral)\b/.test(raw)) return 'unisex';
  if (/\b(men|mens|men s|man|male|boy|boys)\b/.test(raw)) return 'men';
  if (/\b(women|womens|women s|woman|female|girl|girls|lady|ladies)\b/.test(raw)) return 'women';
  return null;
}

function recommendationGenderText(item = {}) {
  return normalizeText(
    [
      item?.meta?.title || item?.meta?.name || '',
      item?.meta?.sub || '',
      ...(Array.isArray(item?.meta?.style_markers) ? item.meta.style_markers : []),
      ...(Array.isArray(item?.meta?.occasion_tags) ? item.meta.occasion_tags : []),
      ...(Array.isArray(item?.meta?.entities) ? item.meta.entities : []),
    ].join(' '),
  );
}

function recommendationSlotText(item = {}) {
  return normalizeText(
    [
      item?.category || '',
      item?.meta?.title || item?.meta?.name || '',
      item?.meta?.sub || '',
      ...(Array.isArray(item?.meta?.entities) ? item.meta.entities : []),
      ...(Array.isArray(item?.meta?.style_markers) ? item.meta.style_markers : []),
      ...(Array.isArray(item?.meta?.occasion_tags) ? item.meta.occasion_tags : []),
    ].join(' '),
  );
}

function recommendationSlotCompatible(item, slot) {
  if (!item || !slot) return false;
  const category = normalizeText(item?.category || '');
  const sub = normalizeText(item?.meta?.sub || item?.sub || '');
  const text = recommendationSlotText(item);
  if (!text) return false;
  if (slot === 'top') {
    if (category === slot) return true;
    if (/\b(shirt|tee|t-shirt|tshirt|top|hoodie|sweater|jumper|cardigan|jacket|coat|blazer|polo|vest|waistcoat|outerwear|overshirt|jersey)\b/.test(sub)) return true;
    if (/\b(shoe|sneaker|trainer|boot|loafer|heel|oxford|derby|sandal|mule|slipper|dress|gown|jumpsuit|romper|pant|pants|trouser|trousers|jean|jeans|legging|leggings|shorts|skirt)\b/.test(text)) return false;
    if (/\b(shirt|tee|t-shirt|tshirt|top|hoodie|sweater|jumper|cardigan|jacket|coat|blazer|polo|vest|waistcoat|outerwear|overshirt)\b/.test(text)) return true;
    if (text.includes('shirt') || text.includes('hoodie') || text.includes('jacket') || text.includes('polo') || text.includes('jersey')) return true;
  } else if (slot === 'bottom') {
    if (category === slot) return true;
    if (/\b(pant|pants|trouser|trousers|jean|jeans|legging|leggings|shorts|short|jogger|joggers|cargo|cargos|skirt|skirts|slacks|chino|chinos)\b/.test(sub) || sub.includes('short')) return true;
    if (/\b(shoe|sneaker|trainer|boot|loafer|heel|oxford|derby|sandal|mule|slipper|dress|gown|jumpsuit|romper|shirt|tee|t-shirt|tshirt|hoodie|sweater|cardigan|jacket|blazer|polo)\b/.test(text)) return false;
    if (/\b(pant|pants|trouser|trousers|jean|jeans|legging|leggings|shorts|short|jogger|joggers|cargo|cargos|skirt|skirts|slacks|chino|chinos)\b/.test(text)) return true;
    if (text.includes('shorts') || text.includes('pants') || text.includes('trousers') || text.includes('jeans') || text.includes('jogger') || text.includes('cargo')) return true;
  } else if (slot === 'shoes') {
    if (category === slot) return true;
    if (/\b(shoe|shoes|sneaker|sneakers|trainer|trainers|boot|boots|loafer|loafers|heel|heels|oxford|oxfords|derby|derbies|sandal|sandals|mule|mules|slipper|slippers|cleat|cleats)\b/.test(sub)) return true;
    if (/\b(dress|gown|jumpsuit|romper|shirt|hoodie|jacket|trouser|jean|shorts|skirt)\b/.test(text)) return false;
    if (/\b(shoe|shoes|sneaker|sneakers|trainer|trainers|boot|boots|loafer|loafers|heel|heels|oxford|oxfords|derby|derbies|sandal|sandals|mule|mules|slipper|slippers|cleat|cleats)\b/.test(text)) return true;
    if (text.includes('sneaker') || text.includes('boot') || text.includes('shoe') || text.includes('cleat') || text.includes('jordan')) return true;
  } else if (slot === 'mono') {
    if (category === slot) return true;
    if (/\b(dress|gown|jumpsuit|romper|playsuit|one piece|one-piece)\b/.test(sub)) return true;
    if (/\b(shoe|sneaker|trainer|boot|loafer|shirt|hoodie|jacket|trouser|jean|shorts|skirt)\b/.test(text)) return false;
    if (/\b(dress|gown|jumpsuit|romper|playsuit|one piece|one-piece)\b/.test(text)) return true;
  }
  return false;
}

function recommendationGenderCompatible(item, target) {
  if (!item || !target || target === 'any') return true;
  const gender = normalizeRecommendationGender(item?.meta?.gender || item?.gender || '');
  const blocked = Array.isArray(item?.meta?.runtimeBlockFor) ? item.meta.runtimeBlockFor.map((entry) => String(entry || '').toLowerCase()) : [];
  if (blocked.includes(target)) return false;
  if (gender === 'women') return target === 'women';
  if (gender === 'men') return target === 'men';
  const text = recommendationGenderText(item);
  if (target === 'men' && FEMININE_RECOMMENDATION_VETO_RE.test(text)) return false;
  if (target === 'women' && MASCULINE_RECOMMENDATION_VETO_RE.test(text)) return false;
  return true;
}

function repairRecommendationOutfits(outfits, genderPref) {
  if (!Array.isArray(outfits) || !outfits.length || genderPref === 'any') return outfits;
  const pools = { top: [], bottom: [], mono: [], shoes: [] };
  for (const outfit of outfits) {
    for (const slot of CATEGORY_KEYS) {
      const item = outfit?.[slot];
      if (item) pools[slot].push(item);
    }
  }
  for (const slot of CATEGORY_KEYS) {
    const seen = new Set();
    pools[slot] = pools[slot].filter((item) => {
      if (!recommendationGenderCompatible(item, genderPref)) return false;
      if (!recommendationSlotCompatible(item, slot)) return false;
      const key = String(item.id || item.imagePath || '').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const repaired = [];
  const topSeen = new Set();
  for (const outfit of outfits) {
    const next = { ...outfit };
    let valid = true;
    for (const slot of CATEGORY_KEYS) {
      const item = next[slot];
      if (!item) continue;
      if (recommendationGenderCompatible(item, genderPref) && recommendationSlotCompatible(item, slot)) continue;
      const replacement = pools[slot].find((candidate) => {
        if (slot === 'top' && topSeen.has(String(candidate.id || candidate.imagePath || '').trim())) return false;
        return true;
      }) || null;
      if (!replacement) {
        valid = false;
        break;
      }
      next[slot] = replacement;
    }
    if (!valid) continue;
    if (next.top) topSeen.add(String(next.top.id || next.top.imagePath || '').trim());
    repaired.push(next);
  }
  const reorderForTopDiversity = (looks) => {
    if (!Array.isArray(looks) || looks.length < 2) return looks;
    const uniqueTopCount = new Set(
      looks
        .map((entry) => String(entry?.top?.id || entry?.top?.imagePath || '').trim())
        .filter(Boolean),
    ).size;
    const targetUniqueTops = Math.min(uniqueTopCount, Math.min(4, looks.length));
    if (targetUniqueTops <= 1) return looks;

    const remaining = [...looks];
    const ordered = [];
    const usedTopIds = new Set();

    while (remaining.length) {
      let chosenIndex = 0;
      if (usedTopIds.size < targetUniqueTops) {
        const unseenIndex = remaining.findIndex((entry) => {
          const topId = String(entry?.top?.id || entry?.top?.imagePath || '').trim();
          return topId && !usedTopIds.has(topId);
        });
        if (unseenIndex >= 0) chosenIndex = unseenIndex;
      }
      const [chosen] = remaining.splice(chosenIndex, 1);
      if (!chosen) continue;
      const topId = String(chosen?.top?.id || chosen?.top?.imagePath || '').trim();
      if (topId) usedTopIds.add(topId);
      ordered.push(chosen);
    }

    return ordered;
  };

  return reorderForTopDiversity(repaired);
}

function recommendationSportFootwearText(item = {}) {
  return normalizeText(
    [
      item?.meta?.title || item?.meta?.name || '',
      item?.meta?.sub || '',
      ...(Array.isArray(item?.meta?.entities) ? item.meta.entities : []),
      ...(Array.isArray(item?.meta?.style_markers) ? item.meta.style_markers : []),
      ...(Array.isArray(item?.meta?.occasion_tags) ? item.meta.occasion_tags : []),
      item?.meta?.sportMeta?.sport || '',
    ].join(' '),
  );
}

function recommendationSportApparelText(item = {}) {
  return normalizeText(
    [
      item?.meta?.title || item?.meta?.name || '',
      item?.meta?.sub || '',
      ...(Array.isArray(item?.meta?.entities) ? item.meta.entities : []),
      ...(Array.isArray(item?.meta?.style_markers) ? item.meta.style_markers : []),
      ...(Array.isArray(item?.meta?.occasion_tags) ? item.meta.occasion_tags : []),
      item?.meta?.sportMeta?.sport || '',
      ...(Array.isArray(item?.meta?.sportMeta?.teams) ? item.meta.sportMeta.teams : []),
    ].join(' '),
  );
}

function recommendationSportApparelScore(item, sport, slot) {
  if (!item || !sport || sport === 'none' || (slot !== 'top' && slot !== 'bottom')) return -Infinity;
  const text = recommendationSportApparelText(item);
  const sub = normalizeText(item?.meta?.sub || '');
  const metaSport = normalizeText(item?.meta?.sportMeta?.sport || '');
  const teamKitCue = /\bfootball\b|\bsoccer\b|\bbasketball\b|\bnba\b|\bjersey\b|\bkit\b/.test(text);
  let score = 0;

  if (metaSport && metaSport === sport) score += 4.2;
  else if (metaSport && metaSport !== sport) score -= 2.2;

  if (sport === 'gym') {
    if (/\bgym\b|\btraining\b|\bworkout\b|\btrainer\b|\bcross trainer\b|\bcross-training\b|\bathletic\b|\bperformance\b/.test(text)) score += 4.8;
    if (slot === 'top' && /\b(sports bra|sport bra|tank|tank top|crop top|t-shirt|tshirt|tee|top|compression)\b/.test(text)) score += 3.2;
    if (slot === 'top' && /\bhoodie|sweatshirt|windbreaker|field jacket|drizzler|bomber\b/.test(text)) score -= 1.6;
    if (slot === 'top' && /\b(blazer|dress shirt|oxford|cardigan|coat|parka)\b/.test(text)) score -= 3.6;
    if (slot === 'bottom' && /\b(legging|leggings|short|shorts|jogger|joggers|track pants|trackpant)\b/.test(text)) score += 2.4;
    if (teamKitCue) score -= 5.4;
  } else if (sport === 'running') {
    if (/\brunning\b|\brunner\b|\bmarathon\b|\btempo\b|\btraining\b|\bperformance\b/.test(text)) score += 4.4;
    if (slot === 'top' && /\b(tank|t-shirt|tshirt|tee|top|sports bra|sport bra)\b/.test(text)) score += 1.8;
    if (slot === 'bottom' && /\b(short|shorts|legging|leggings|jogger|joggers)\b/.test(text)) score += 2.1;
    if (teamKitCue) score -= 3.2;
  } else if (sport === 'tennis') {
    if (/\btennis\b|\bcourt\b/.test(text)) score += 4.2;
    if (slot === 'top' && /\b(polo|shirt|top|tank)\b/.test(text)) score += 1.4;
    if (slot === 'bottom' && /\b(short|shorts|skirt|skort)\b/.test(text)) score += 1.8;
  } else if (sport === 'basketball') {
    if (/\bbasketball\b|\bnba\b|\bjersey\b/.test(text)) score += 4.6;
    if (slot === 'bottom' && /\b(short|shorts)\b/.test(text)) score += 1.8;
  } else if (sport === 'football') {
    if (/\bfootball\b|\bsoccer\b|\bjersey\b|\bkit\b/.test(text)) score += 4.8;
    if (slot === 'bottom' && /\b(short|shorts)\b/.test(text)) score += 2.0;
  }

  if (slot === 'top' && /\b(blouse|tie neck|tie-neck|ruffled)\b/.test(text)) score -= 1.2;
  if (slot === 'bottom' && /\b(trouser|trousers|dress pants|tailored)\b/.test(text) && sport !== 'tennis') score -= 1.4;
  if (slot === 'bottom' && /\bshoe|sneaker|trainer|boot|loafer|heel|oxford|derby\b/.test(text)) score -= 6;
  return score;
}

function recommendationSportFootwearScore(item, sport) {
  if (!item || !sport || sport === 'none') return -Infinity;
  const sub = normalizeText(item?.meta?.sub || '');
  const text = recommendationSportFootwearText(item);
  const metaSport = normalizeText(item?.meta?.sportMeta?.sport || '');
  const ruggedBootCue = /\bhiking\b|\bwork boot\b|\bworkboot\b|\bcombat\b|\btrek\b|\btrail\b|\bmountain\b|\boutdoor\b|\brock\b/.test(text);
  let score = 0;

  if (metaSport && metaSport === sport) score += 5;
  else if (metaSport && metaSport !== sport) score -= 2.8;

  if (sport === 'football') {
    if (sub === 'boots') score += 3.8;
    if (/\bfootball\b|\bsoccer\b|\bcleat\b|\bcleats\b|\bturf\b|\bfirm ground\b|\bsoft ground\b|\bartificial ground\b|\bfg\b|\bsg\b|\bag\b|\bmercurial\b|\bpredator\b|\bphantom\b|\bf50\b/.test(text)) score += 5.2;
    if (sub && sub !== 'boots' && !/\bfootball\b|\bsoccer\b|\bcleat\b|\bturf\b/.test(text)) score -= 4.4;
  } else if (sport === 'basketball') {
    const explicit = /\bbasketball\b|\bnba\b|\bjordan\b|\bair jordan\b|\blebron\b|\bkobe\b|\bdunk\b/.test(text);
    const premium = /\bjordan\b|\bair jordan\b|\blebron\b|\bkobe\b|\bdunk\b/.test(text);
    if (metaSport === 'basketball') score += explicit ? 2.6 : 0.6;
    if (explicit) score += premium ? 6.2 : 3.2;
    if (/\bsneaker\b|\bsneakers\b|\btrainer\b|\btrainers\b/.test(text)) score += explicit ? 1.4 : 0.2;
    if (ruggedBootCue || /\bboot\b|\bboots\b/.test(text)) score -= premium ? 0.5 : 6.2;
    if (!explicit && metaSport === 'basketball') score -= 2.8;
    if (!explicit && metaSport !== 'basketball' && sub && sub !== 'sneakers') score -= 2.8;
  } else if (sport === 'running') {
    if (/\brunning\b|\brunner\b|\bmarathon\b|\btempo\b|\bpegasus\b|\bvaporfly\b|\balphafly\b|\bgel kayano\b|\bnovablast\b/.test(text)) score += 4.5;
  } else if (sport === 'tennis') {
    if (/\btennis\b|\bcourt\b|\bclay\b|\bhard court\b/.test(text)) score += 4.2;
  } else if (sport === 'gym') {
    if (/\bgym\b|\btraining\b|\bworkout\b|\btrainer\b|\bcross trainer\b|\bcross-training\b|\bmetcon\b/.test(text)) score += 4.0;
  }

  return score;
}

function refinedIntentActive(intent = {}) {
  const vibes = Array.isArray(intent?.vibe_tags) ? intent.vibe_tags.map((entry) => normalizeText(entry)) : [];
  const occasions = Array.isArray(intent?.occasion_tags) ? intent.occasion_tags.map((entry) => normalizeText(entry)) : [];
  const activities = Array.isArray(intent?.activity_context) ? intent.activity_context.map((entry) => normalizeText(entry)) : [];
  return vibes.some((entry) => ['formal', 'chic', 'preppy', 'minimal', 'classic', 'old money', 'smart casual'].includes(entry))
    || occasions.some((entry) => ['evening', 'formal', 'smart_casual', 'date_night', 'business_casual'].includes(entry))
    || activities.includes('dinner');
}

function recommendationPaletteFamilies(item) {
  const colours = Array.isArray(item?.meta?.colours) ? item.meta.colours : Array.isArray(item?.colours) ? item.colours : [];
  return [...new Set(colours.map((entry) => normalizeText(entry)).filter(Boolean))];
}

function recommendationPaletteScore(item, intent) {
  if (!item || !intent) return 0;
  const mode = normalizeText(intent?.palette_mode || '');
  const strength = normalizeText(intent?.palette_override_strength || '');
  const targets = Array.isArray(intent?.global_palette_colours)
    ? [...new Set(intent.global_palette_colours.map((entry) => normalizeText(entry)).filter(Boolean))]
    : [];
  if (!targets.length || (mode !== 'monochrome' && mode !== 'tonal')) return 0;
  const families = recommendationPaletteFamilies(item);
  if (!families.length) return 0;
  const paletteHits = targets.filter((colour) => families.includes(colour)).length;
  const foreignFamilies = families.filter((colour) => !targets.includes(colour));
  let score = 0;
  if (paletteHits) score += strength === 'hard' ? 4.2 : 1.6;
  if (!foreignFamilies.length && paletteHits) score += strength === 'hard' ? 6.4 : 2.0;
  if (foreignFamilies.length) score -= foreignFamilies.length * (strength === 'hard' ? 7.4 : 1.6);
  return score;
}

function recommendationRefinedFootwearScore(item, intent) {
  if (!item) return -Infinity;
  const text = recommendationSportFootwearText(item);
  const sub = normalizeText(item?.meta?.sub || '');
  const targetGender = normalizeText(intent?.target_gender || '');
  const womenDateContext =
    targetGender === 'women' &&
    (
      (Array.isArray(intent?.activity_context) && intent.activity_context.some((entry) => normalizeText(entry) === 'dinner')) ||
      (Array.isArray(intent?.occasion_tags) && intent.occasion_tags.some((entry) => ['evening', 'date_night'].includes(normalizeText(entry)))) ||
      (Array.isArray(intent?.vibe_tags) && intent.vibe_tags.some((entry) => ['formal', 'chic'].includes(normalizeText(entry))))
    );
  let score = 0;
  if (/\b(loafer|loafers|oxford|oxfords|derby|derbies|boat shoe|boat shoes|penny|penny strap|moccasin|moccasins)\b/.test(text)) score += 4.8;
  if (/\b(santoni|ferragamo|sebago|paraboot|prada|jimmy choo|loewe|givenchy|marni|brunello cucinelli)\b/.test(text)) score += 0.4;
  if (/\b(boot|boots)\b/.test(text) && !/\bhiking|work boot|workboot|combat|trail|trek|mountain|outdoor\b/.test(text)) score += 1.4;
  if (/\b(sandal|sandals|slide|slides|slipper|slippers|mule|mules|clog|clogs|birkenstock|boston eva)\b/.test(text)) score -= 4.4;
  if (/\b(sneaker|sneakers|trainer|trainers|athletic)\b/.test(text)) score -= 2.2;
  if (/\bhiking|work boot|workboot|combat|trail|trek|mountain|outdoor\b/.test(text)) score -= 3.2;
  if (womenDateContext) {
    if (/\b(pump|pumps|heel|heels|slingback|mary jane|kitten heel|tabi)\b/.test(text)) score += 7.2;
    else if (/\bankle boot|ankle boots|mule|mules|sandal|sandals\b/.test(text)) score += 3.8;
    if (/\b(loafer|loafers|boat shoe|boat shoes|oxford|oxfords|derby|derbies)\b/.test(text)) score -= 3.6;
    if (/\b(sneaker|sneakers|trainer|trainers)\b/.test(text)) score -= 4.8;
  }
  if (sub === 'boots') score += 0.4;
  score += recommendationPaletteScore(item, intent);
  return score;
}

const REFINED_MENS_TOP_FEMININE_RE =
  /\b(lace|lace-detail|ribbon|ruffled|blouse|camisole|tie neck|tie-neck|crop top|pointelle|corset|tank top|sleeveless|bow detail|bow-detail)\b/;

function recommendationMeaningfulIdentityTokens(text) {
  return normalizeText(text || '')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) =>
      token.length >= 4 &&
      ![
        'top', 'tops', 'shirt', 'shirts', 'tee', 'tees', 'tshirt', 'tshirts', 'sweater', 'sweaters', 'cardigan', 'cardigans',
        'jacket', 'jackets', 'hoodie', 'hoodies', 'men', 'mens', 'women', 'womens', 'unisex',
      ].includes(token),
    );
}

function recommendationLowInformationRefinedMensTopPenalty(item) {
  if (!item) return 0;
  const text = recommendationSportApparelText(item);
  const identityText = recommendationFocusText(item);
  const informativeIdentity = recommendationMeaningfulIdentityTokens(identityText);
  let evidence = 0;
  if (/\b(shirt|dress shirt|oxford shirt|polo|cardigan|sweater|jumper|knit|knitwear|blazer|tailored|turtleneck|zip sweater)\b/.test(text)) evidence += 1.25;
  if (/\b(oxford|dress shirt|button down|button-down|collared|polo|cardigan|sweater|jumper|knit|knitwear|crewneck|cashmere|merino|wool|quarter zip|quarter-zip|zip sweater|turtleneck|blazer|tailored)\b/.test(text)) evidence += 1.55;
  if (Array.isArray(item?.meta?.style_markers) && item.meta.style_markers.length) evidence += 0.55;
  if (Array.isArray(item?.meta?.occasion_tags) && item.meta.occasion_tags.some((entry) => ['smart_casual', 'formal', 'evening', 'office'].includes(normalizeText(entry)))) evidence += 0.85;
  if (Array.isArray(item?.meta?.entityMeta) && item.meta.entityMeta.some((entry) => ['brand', 'material', 'sponsor'].includes(normalizeText(entry?.type || '')))) evidence += 0.7;
  if (informativeIdentity.length >= 2) evidence += 1.15;
  else if (informativeIdentity.length === 1) evidence += 0.35;
  if (evidence >= 2.2) return 0;
  if (evidence >= 1.45) return -2.8;
  return -6.9;
}

function recommendationLowInformationRefinedBottomPenalty(item) {
  if (!item) return 0;
  const text = recommendationSportApparelText(item);
  const identityText = recommendationFocusText(item);
  const informativeIdentity = recommendationMeaningfulIdentityTokens(identityText);
  const normalizedIdentity = normalizeText(identityText);
  const identityTokens = normalizedIdentity.split(/\s+/).filter(Boolean);
  const opaqueNumericIdentity =
    (identityTokens.length > 0 && identityTokens.every((token) => /^\d+$/.test(token))) ||
    /\b\d{6,}\b/.test(normalizedIdentity);
  let evidence = 0;
  if (/\b(trouser|trousers|slack|slacks|chino|chinos|linen|tailored|pleated|straight leg|straight-leg)\b/.test(text)) evidence += 1.4;
  if (Array.isArray(item?.meta?.style_markers) && item.meta.style_markers.length) evidence += 0.45;
  if (Array.isArray(item?.meta?.occasion_tags) && item.meta.occasion_tags.some((entry) => ['smart_casual', 'formal', 'evening', 'office'].includes(normalizeText(entry)))) evidence += 0.75;
  if (Array.isArray(item?.meta?.entityMeta) && item.meta.entityMeta.some((entry) => ['brand', 'material'].includes(normalizeText(entry?.type || '')))) evidence += 0.6;
  if (informativeIdentity.length >= 2) evidence += 1.05;
  else if (informativeIdentity.length === 1) evidence += 0.3;
  if (evidence >= 2.1) return 0;
  if (opaqueNumericIdentity) return -7.2;
  if (informativeIdentity.length === 0 && evidence < 1.6) return -5.9;
  if (evidence >= 1.35) return -2.8;
  return -5.2;
}

function recommendationOpaqueNumericIdentity(item) {
  const normalizedIdentity = normalizeText(recommendationFocusText(item));
  const identityTokens = normalizedIdentity.split(/\s+/).filter(Boolean);
  return (
    identityTokens.length > 0 &&
    identityTokens.every((token) => /^\d+$/.test(token))
  ) || /\b\d{6,}\b/.test(normalizedIdentity);
}

function recommendationRefinedApparelScore(item, intent, slot, genderPref = 'any') {
  if (!item || !refinedIntentActive(intent) || (slot !== 'top' && slot !== 'bottom')) return -Infinity;
  const text = recommendationSportApparelText(item);
  const effectiveGender = normalizeText(genderPref || intent?.target_gender || '');
  const vibes = Array.isArray(item?.meta?.vibes) ? item.meta.vibes.map((entry) => normalizeText(entry)) : [];
  const hasTeamEntity = Array.isArray(item?.meta?.entityMeta) && item.meta.entityMeta.some((entry) => ['team', 'sponsor'].includes(normalizeText(entry?.type || '')));
  let score = 0;
  if (slot === 'top') {
    if (/\b(shirt|dress shirt|oxford shirt|polo|cardigan|sweater|jumper|knit|knitwear|blouse|blazer|tailored|turtleneck|zip sweater)\b/.test(text)) score += 4.8;
    if (/\b(t-shirt|tshirt|tee)\b/.test(text)) score -= /\bgraphic|logo|distressed|washed\b/.test(text) ? 2.8 : 1.4;
    if (/\b(tech ?fleece|fleece|track jacket|zip hoodie|athletic|training|sporty)\b/.test(text)) score -= 4.8;
    if (/\b(jacket|coat|bomber|windbreaker|field jacket|drizzler|parka|hoodie|sweatshirt)\b/.test(text)) score -= 3.6;
    if (/\b(jersey|kit|club|fc|uefa|premier league|champions league|nba)\b/.test(text)) score -= 6.2;
    if (hasTeamEntity) score -= 7.4;
    if (vibes.some((entry) => ['sporty', 'streetwear'].includes(entry))) score -= 4.4;
    if (effectiveGender === 'men' && REFINED_MENS_TOP_FEMININE_RE.test(text)) score -= 6.8;
    if (effectiveGender === 'men') score += recommendationLowInformationRefinedMensTopPenalty(item) * 0.42;
    if (/\bgraphic|logo|distressed|washed\b/.test(text)) score -= 1.2;
    if (recommendationOldMoneyMensIntent(intent, genderPref)) {
      if (/\b(oxford|dress shirt|button down|button-down|collared|polo|cardigan|sweater|jumper|knit|knitwear|crewneck|cashmere|merino|wool|quarter zip|quarter-zip|zip sweater|turtleneck|blazer|tailored)\b/.test(text)) score += 3.8;
      if (/\b(overshirt|drizzler)\b/.test(text) && !/\b(workwear|utility|patch pocket|field jacket|carhartt)\b/.test(text)) score += 1.1;
      if (/\b(t-shirt|tshirt|tee)\b/.test(text)) score -= 5.8;
      if (/\b(tech ?fleece|fleece|track jacket|zip hoodie|athletic|training|sporty)\b/.test(text)) score -= 6.4;
      if (REFINED_MENS_TOP_FEMININE_RE.test(text)) score -= 7.6;
      if (/\b(graphic|logo|distressed|washed|jersey|hoodie|sweatshirt|windbreaker|bomber|field jacket|parka|leather jacket)\b/.test(text)) score -= 5.4;
      if (/\b(workwear|utility|patch pocket|carhartt|technical|cargo|leather jacket)\b/.test(text)) score -= 6.2;
      if (/\b(sport|training|football|basketball|track|running)\b/.test(text)) score -= 4.2;
    }
  } else if (slot === 'bottom') {
    if (/\b(trouser|trousers|slack|slacks|chino|chinos|linen|tailored)\b/.test(text)) score += 4.4;
    if (/\bjean|jeans|denim\b/.test(text)) score -= 0.9;
    if (/\blegging|leggings|track|jogger|joggers|cargo|cargos|short|shorts\b/.test(text)) score -= 2.4;
    if (vibes.some((entry) => ['sporty', 'streetwear', 'techwear', 'edgy'].includes(entry))) score -= 2.8;
    if (hasTeamEntity) score -= 4.4;
    score += recommendationLowInformationRefinedBottomPenalty(item);
  }
  score += recommendationPaletteScore(item, intent);
  return score;
}

function recommendationOldMoneyMensTopScore(item, intent, genderPref = 'any') {
  if (!item || !recommendationOldMoneyMensIntent(intent, genderPref)) return -Infinity;
  const text = recommendationSportApparelText(item);
  let score = recommendationRefinedApparelScore(item, intent, 'top', genderPref);
  if (/\b(oxford|dress shirt|button down|button-down|collared|polo|cardigan|sweater|jumper|knit|knitwear|crewneck|cashmere|merino|wool|quarter zip|quarter-zip|zip sweater|turtleneck|blazer|tailored)\b/.test(text)) score += 5.2;
  if (/\b(overshirt|drizzler)\b/.test(text) && !/\b(workwear|utility|patch pocket|field jacket|carhartt)\b/.test(text)) score += 1.6;
  if (/\b(t-shirt|tshirt|tee)\b/.test(text)) score -= 8.2;
  if (/\b(graphic|logo|distressed|washed|jersey|hoodie|sweatshirt|windbreaker|bomber|field jacket|parka|leather jacket)\b/.test(text)) score -= 7.6;
  if (/\b(tech ?fleece|fleece|track jacket|zip hoodie|athletic|training|sporty)\b/.test(text)) score -= 8.2;
  if (REFINED_MENS_TOP_FEMININE_RE.test(text)) score -= 9.2;
  if (/\b(workwear|utility|patch pocket|carhartt|technical|cargo|leather jacket)\b/.test(text)) score -= 8.4;
  score += recommendationLowInformationRefinedMensTopPenalty(item);
  return score;
}

function recommendationLowInformationRefinedTop(item, intent, genderPref = 'any') {
  if (!item) return false;
  const text = recommendationSportApparelText(item);
  if (/\b(t-shirt|tshirt|tee|graphic|logo|hoodie|sweatshirt|jersey|track jacket|windbreaker)\b/.test(text)) {
    return true;
  }
  if (normalizeText(genderPref || intent?.target_gender || '') === 'men') {
    return recommendationLowInformationRefinedMensTopPenalty(item) <= -5.5;
  }
  return false;
}

function recommendationTeamText(item = {}) {
  return normalizeText(
    [
      item?.meta?.title || item?.meta?.name || '',
      ...(Array.isArray(item?.meta?.entities) ? item.meta.entities : []),
      ...(Array.isArray(item?.meta?.entityMeta) ? item.meta.entityMeta.map((entry) => entry?.text || '') : []),
      ...(Array.isArray(item?.meta?.sportMeta?.teams) ? item.meta.sportMeta.teams : []),
    ].join(' '),
  );
}

function recommendationTeamScore(item, teams, slot, sport) {
  if (!item || !Array.isArray(teams) || !teams.length) return -Infinity;
  const text = recommendationTeamText(item);
  const metaTeams = Array.isArray(item?.meta?.sportMeta?.teams) ? item.meta.sportMeta.teams.map((entry) => normalizeText(entry)) : [];
  const normalizedTeams = teams.map((team) => normalizeText(team)).filter(Boolean);
  const hits = normalizedTeams.filter((team) => metaTeams.some((value) => value && (value.includes(team) || team.includes(value))) || text.includes(team)).length;
  const hasCompetingTeam = metaTeams.some((value) => value && !normalizedTeams.some((team) => value.includes(team) || team.includes(value)));
  let score = hits * (slot === 'top' ? 6.5 : slot === 'bottom' ? 5.2 : 2.0);
  if (hits && sport && sport !== 'none' && normalizeText(item?.meta?.sportMeta?.sport || '') === sport) score += 1.2;
  if (!hits && hasCompetingTeam) score -= slot === 'top' ? 5.8 : slot === 'bottom' ? 4.6 : 1.6;
  return score;
}

function recommendationFocusTerms(intent = {}) {
  const terms = new Set();
  for (const value of Array.isArray(intent?.brand_focus) ? intent.brand_focus : []) {
    const norm = normalizeText(value);
    if (norm) terms.add(norm);
  }
  for (const value of Array.isArray(intent?.team_focus) ? intent.team_focus : []) {
    const norm = normalizeText(value);
    if (norm) terms.add(norm);
  }
  for (const subject of Array.isArray(intent?.semantic_subjects) ? intent.semantic_subjects : []) {
    if (!subject || !['brand', 'team', 'item_line'].includes(normalizeText(subject.kind || ''))) continue;
    for (const value of [subject.label, ...(Array.isArray(subject.soft_brand_priors) ? subject.soft_brand_priors : [])]) {
      const norm = normalizeText(value);
      if (norm) terms.add(norm);
    }
  }
  return Array.from(terms);
}

function recommendationBrandTerms(intent = {}) {
  const terms = new Set();
  for (const value of Array.isArray(intent?.brand_focus) ? intent.brand_focus : []) {
    const norm = normalizeText(value);
    if (norm) terms.add(norm);
  }
  for (const subject of Array.isArray(intent?.semantic_subjects) ? intent.semantic_subjects : []) {
    if (!subject || normalizeText(subject.kind || '') !== 'brand') continue;
    for (const value of [subject.label, ...(Array.isArray(subject.soft_brand_priors) ? subject.soft_brand_priors : [])]) {
      const norm = normalizeText(value);
      if (norm) terms.add(norm);
    }
  }
  return Array.from(terms);
}

function recommendationRequestedSlots(intent = {}) {
  const explicit = Array.isArray(intent?.requested_slots) ? intent.requested_slots.filter((slot) => CATEGORY_KEYS.includes(slot)) : [];
  if (explicit.length) return explicit;

  const structural = [
    ...(Array.isArray(intent?.required_categories) ? intent.required_categories : []),
    ...(Array.isArray(intent?.optional_categories) ? intent.optional_categories : []),
  ].filter((slot) => CATEGORY_KEYS.includes(slot));
  if (structural.length) {
    return Array.from(new Set(structural));
  }

  const requestedForm = normalizeText(intent?.requested_form || '');
  const derived = CATEGORY_KEYS.filter((slot) => requestedForm.includes(slot));
  return derived.length ? derived : CATEGORY_KEYS;
}

function recommendationFocusText(item = {}) {
  return normalizeText(
    [
      item?.meta?.title || item?.meta?.name || '',
      item?.meta?.brand || '',
      ...(Array.isArray(item?.meta?.entities) ? item.meta.entities : []),
      ...(Array.isArray(item?.meta?.entityMeta) ? item.meta.entityMeta.map((entry) => entry?.text || entry?.label || entry?.name || '') : []),
    ].join(' '),
  );
}

function recommendationFocusScore(item, intent, slot) {
  const focus = recommendationFocusTerms(intent);
  if (!item || !focus.length) return -Infinity;
  const text = recommendationFocusText(item);
  const hits = focus.filter((term) => text.includes(term)).length;
  let score = hits * (slot === 'top' ? 6.4 : slot === 'bottom' ? 5.2 : slot === 'shoes' ? 5.8 : 4.6);
  const sport = normalizeText(intent?.sport_context || '');
  if (sport === 'none' && slot === 'shoes') {
    score += recommendationRefinedFootwearScore(item, intent) * 0.25;
  }
  if (sport === 'none' && (slot === 'top' || slot === 'bottom')) {
    score += recommendationRefinedApparelScore(item, intent, slot) * 0.18;
  }
  return score;
}

function recommendationBrandScore(item, intent, slot) {
  const focus = recommendationBrandTerms(intent);
  if (!item || !focus.length) return -Infinity;
  const text = recommendationFocusText(item);
  const hits = focus.filter((term) => text.includes(term)).length;
  if (!hits) return -Infinity;
  let score = hits * (slot === 'top' ? 7.2 : slot === 'bottom' ? 6.2 : slot === 'shoes' ? 6.4 : 5.6);
  const sport = normalizeText(intent?.sport_context || '');
  if (sport === 'none' && slot === 'shoes') {
    score += recommendationRefinedFootwearScore(item, intent) * 0.2;
  }
  if (sport === 'none' && (slot === 'top' || slot === 'bottom')) {
    score += recommendationRefinedApparelScore(item, intent, slot) * 0.16;
  }
  return score;
}

function recommendationItemMatchesBrand(item, intent) {
  const focus = recommendationBrandTerms(intent);
  if (!item || !focus.length) return false;
  const text = recommendationFocusText(item);
  return focus.some((term) => text.includes(term));
}

function recommendationBrandModeActive(intent = {}) {
  return normalizeText(intent?.brand_fit_mode || '') !== 'none' && recommendationBrandTerms(intent).length > 0;
}

function recommendationPersonaSoftBrandTerms(intent = {}) {
  const terms = new Set();
  for (const subject of Array.isArray(intent?.semantic_subjects) ? intent.semantic_subjects : []) {
    if (!subject || normalizeText(subject.kind || '') !== 'persona') continue;
    for (const value of Array.isArray(subject.soft_brand_priors) ? subject.soft_brand_priors : []) {
      const norm = normalizeText(value);
      if (norm) terms.add(norm);
    }
  }
  return Array.from(terms);
}

function recommendationBrandLeadProfile(intent = {}) {
  if (recommendationBrandModeActive(intent)) {
    return {
      mode: normalizeText(intent?.brand_fit_mode || '') || 'single_brand_presence',
      terms: recommendationBrandTerms(intent),
      weight: 1,
    };
  }
  const personaTerms = recommendationPersonaSoftBrandTerms(intent);
  if (!personaTerms.length) {
    return { mode: 'none', terms: [], weight: 0 };
  }
  return {
    mode: 'persona_soft',
    terms: personaTerms,
    weight: 0.55,
  };
}

function recommendationOutfitBrandCoverage(outfit, terms, requestedSlots) {
  if (!outfit || !terms.length) return { count: 0, weighted: 0 };
  let count = 0;
  let weighted = 0;
  for (const slot of requestedSlots) {
    const item = outfit?.[slot];
    if (!item || !recommendationSlotCompatible(item, slot)) continue;
    const text = recommendationFocusText(item);
    if (!text || !terms.some((term) => text.includes(term))) continue;
    count += 1;
    weighted +=
      slot === 'top' ? 1.25 :
      slot === 'bottom' ? 1.1 :
      slot === 'mono' ? 1.15 :
      0.9;
  }
  return { count, weighted };
}

function recommendationOldMoneyMensIntent(intent = {}, genderPref = 'any') {
  const effectiveGender = normalizeText(genderPref || intent?.target_gender || '');
  if (effectiveGender !== 'men') return false;
  const subjectHit = (Array.isArray(intent?.semantic_subjects) ? intent.semantic_subjects : []).some((subject) =>
    normalizeText(subject?.kind || '') === 'style_archetype' &&
    /\b(old money|quiet luxury|stealth wealth)\b/.test(normalizeText(subject?.label || '')),
  );
  if (subjectHit) return true;
  const vibes = new Set((Array.isArray(intent?.vibe_tags) ? intent.vibe_tags : []).map((entry) => normalizeText(entry)));
  const occasions = new Set((Array.isArray(intent?.occasion_tags) ? intent.occasion_tags : []).map((entry) => normalizeText(entry)));
  return (
    vibes.has('preppy') &&
    (vibes.has('formal') || vibes.has('chic') || vibes.has('minimal') || occasions.has('smart_casual')) &&
    !vibes.has('streetwear') &&
    normalizeText(intent?.sport_context || 'none') === 'none'
  );
}

function recommendationWomenEveningIntent(intent = {}, genderPref = 'any') {
  const effectiveGender = normalizeText(genderPref || intent?.target_gender || '');
  if (effectiveGender !== 'women') return false;
  if (normalizeText(intent?.sport_context || 'none') !== 'none') return false;
  const vibes = new Set((Array.isArray(intent?.vibe_tags) ? intent.vibe_tags : []).map((entry) => normalizeText(entry)));
  const occasions = new Set((Array.isArray(intent?.occasion_tags) ? intent.occasion_tags : []).map((entry) => normalizeText(entry)));
  const activities = new Set((Array.isArray(intent?.activity_context) ? intent.activity_context : []).map((entry) => normalizeText(entry)));
  return (
    activities.has('dinner') ||
    occasions.has('date_night') ||
    occasions.has('evening') ||
    occasions.has('formal') ||
    vibes.has('formal') ||
    vibes.has('chic')
  );
}

function recommendationGymBottomIntent(intent = {}) {
  return normalizeText(intent?.sport_context || 'none') === 'gym';
}

function recommendationOpaqueRecommendationIdentity(item) {
  const normalizedIdentity = normalizeText(recommendationFocusText(item));
  const identityTokens = normalizedIdentity.split(/\s+/).filter(Boolean);
  if (!identityTokens.length) return true;
  if (identityTokens.every((token) => /^\d+$/.test(token))) return true;
  if (identityTokens.length <= 2 && identityTokens.every((token) => /^[a-z]*\d+[a-z\d-]*$/i.test(token))) return true;
  return /\b\d{6,}\b/.test(normalizedIdentity);
}

function refinedMensTopEligible(item, intent, genderPref = 'any') {
  if (!item) return false;
  const text = recommendationSportApparelText(item);
  if (!recommendationGenderCompatible(item, genderPref) || !recommendationSlotCompatible(item, 'top')) return false;
  if (REFINED_MENS_TOP_FEMININE_RE.test(text)) return false;
  if (recommendationLowInformationRefinedTop(item, intent, genderPref)) return false;
  if (/\b(blouse|camisole|crop top|plunge|pointelle|lace|corset|tank top|sleeveless|tie neck|tie-neck|ruffled|bow detail|bow-detail)\b/.test(text)) return false;
  if (/\b(t-shirt|tshirt|tee|graphic|logo|hoodie|sweatshirt|jersey|track jacket|windbreaker|parka|field jacket|bomber|leather jacket|workwear|utility|cargo|technical|training|sporty)\b/.test(text)) return false;
  if (!/\b(oxford|dress shirt|button down|button-down|collared|polo|cardigan|sweater|jumper|knit|knitwear|crewneck|cashmere|merino|wool|quarter zip|quarter-zip|zip sweater|turtleneck|blazer|tailored|shirt|overshirt|drizzler)\b/.test(text)) {
    return false;
  }
  return recommendationOldMoneyMensTopScore(item, intent, genderPref) >= 1.2;
}

function womenEveningRefinedShoeEligible(item, intent, genderPref = 'any') {
  if (!item) return false;
  const text = recommendationSportFootwearText(item);
  if (!recommendationGenderCompatible(item, genderPref) || !recommendationSlotCompatible(item, 'shoes')) return false;
  if (/\b(sneaker|sneakers|trainer|trainers|boat shoe|boat shoes|loafer|loafers|oxford|oxfords|derby|derbies|slipper|slippers|clog|clogs|birkenstock)\b/.test(text)) {
    return false;
  }
  if (/\b(hiking|work boot|workboot|combat|trail|trek|mountain|outdoor)\b/.test(text)) return false;
  const eveningCue =
    /\b(pump|pumps|heel|heels|stiletto|stilettos|slingback|slingbacks|mary jane|mary janes|kitten heel|kitten heels|tabi|ankle boot|ankle boots|mule|mules|sandal|sandals|boot|boots)\b/.test(text);
  if (!eveningCue) return false;
  return recommendationRefinedFootwearScore(item, intent) >= 1.2;
}

function gymBottomEligible(item, intent, genderPref = 'any') {
  if (!item) return false;
  const text = recommendationSportApparelText(item);
  if (!recommendationGenderCompatible(item, genderPref) || !recommendationSlotCompatible(item, 'bottom')) return false;
  if (/\b(jean|jeans|denim|trouser|trousers|dress pants|slack|slacks|chino|chinos|tailored|skirt|skirts)\b/.test(text)) {
    return false;
  }
  if (/\b(legging|leggings|bike short|bike shorts|short|shorts|jogger|joggers|track pants|track pant|trackpant|trackpants|sweatpant|sweatpants|running|athletic|training|workout|gym|performance|active|compression)\b/.test(text)) {
    return true;
  }
  return recommendationSportApparelScore(item, 'gym', 'bottom') >= 2.2;
}

function gymTopEligible(item, intent, genderPref = 'any') {
  if (!item) return false;
  const text = recommendationSportApparelText(item);
  if (!recommendationGenderCompatible(item, genderPref) || !recommendationSlotCompatible(item, 'top')) return false;
  if (/\b(lace|lace-detail|ruffled|blouse|camisole|corset|pointelle|tie neck|tie-neck|plunge)\b/.test(text)) return false;
  if (/\b(blazer|dress shirt|oxford|cardigan|coat|parka|field jacket|drizzler|bomber)\b/.test(text)) return false;
  if (/\b(hoodie|sweatshirt|windbreaker)\b/.test(text)) return false;
  if (/\b(sports bra|sport bra|tank|tank top|crop top|t-shirt|tshirt|tee|top|compression|training|workout|athletic|performance|gym)\b/.test(text)) {
    return true;
  }
  return recommendationSportApparelScore(item, 'gym', 'top') >= 2.4;
}

function gymFootwearEligible(item, intent, genderPref = 'any') {
  if (!item) return false;
  const text = recommendationSportFootwearText(item);
  if (!recommendationGenderCompatible(item, genderPref) || !recommendationSlotCompatible(item, 'shoes')) return false;
  if (/\b(loafer|loafers|boat shoe|boat shoes|oxford|oxfords|derby|derbies|heel|heels|pump|pumps|slingback|mule|mules|boot|boots)\b/.test(text)) {
    return false;
  }
  if (/\b(sneaker|sneakers|trainer|trainers|cross trainer|cross-training|metcon|running|workout|training|gym|athletic)\b/.test(text)) {
    return true;
  }
  return recommendationSportFootwearScore(item, 'gym') >= 2.6;
}

function womenEveningRefinedTopEligible(item, intent, genderPref = 'any') {
  if (!item) return false;
  const text = recommendationSportApparelText(item);
  if (!recommendationGenderCompatible(item, genderPref) || !recommendationSlotCompatible(item, 'top')) return false;
  if (recommendationOpaqueRecommendationIdentity(item)) return false;
  if (/\b(hoodie|sweatshirt|track jacket|windbreaker|jersey|graphic|logo|training|sporty)\b/.test(text)) return false;
  if (/\b(t-shirt|tshirt|tee)\b/.test(text) && !/\b(knit|cashmere|merino|polo)\b/.test(text)) return false;
  if (!/\b(cardigan|sweater|jumper|knit|knitwear|blouse|shirt|top|cashmere|merino|silk|satin|polo|tailored|turtleneck|mock neck|pullover)\b/.test(text)) {
    return false;
  }
  return recommendationRefinedApparelScore(item, intent, 'top', genderPref) >= 0.9;
}

function recommendationLaneEligible(item, slot, intent, genderPref = 'any') {
  if (!item) return false;
  if (slot === 'top' && recommendationOldMoneyMensIntent(intent, genderPref)) {
    return refinedMensTopEligible(item, intent, genderPref);
  }
  if (slot === 'top' && recommendationWomenEveningIntent(intent, genderPref)) {
    return womenEveningRefinedTopEligible(item, intent, genderPref);
  }
  if (slot === 'shoes' && recommendationWomenEveningIntent(intent, genderPref)) {
    return womenEveningRefinedShoeEligible(item, intent, genderPref);
  }
  if (slot === 'top' && recommendationGymBottomIntent(intent)) {
    return gymTopEligible(item, intent, genderPref);
  }
  if (slot === 'bottom' && recommendationGymBottomIntent(intent)) {
    return gymBottomEligible(item, intent, genderPref);
  }
  if (slot === 'shoes' && recommendationGymBottomIntent(intent)) {
    return gymFootwearEligible(item, intent, genderPref);
  }
  return true;
}

function recommendationPreferLaneEligible(entries, slot, intent, genderPref = 'any', getCandidate = (entry) => entry) {
  if (!Array.isArray(entries) || !entries.length) return { entries: [], restricted: false };
  const eligible = entries.filter((entry) => recommendationLaneEligible(getCandidate(entry), slot, intent, genderPref));
  return eligible.length ? { entries: eligible, restricted: true } : { entries, restricted: false };
}

function broadRecommendationPrompt(intent = {}) {
  const requestedForm = String(intent?.requested_form || '').trim().toLowerCase();
  const requestedSlots = Array.isArray(intent?.requested_slots) ? intent.requested_slots.length : 0;
  const vibeCount = Array.isArray(intent?.vibe_tags) ? intent.vibe_tags.length : 0;
  const occasionCount = Array.isArray(intent?.occasion_tags) ? intent.occasion_tags.length : 0;
  const activityCount = Array.isArray(intent?.activity_context) ? intent.activity_context.length : 0;
  const hasSpecificFocus =
    (Array.isArray(intent?.brand_focus) && intent.brand_focus.length > 0) ||
    (Array.isArray(intent?.team_focus) && intent.team_focus.length > 0) ||
    (Array.isArray(intent?.specific_items) && intent.specific_items.length > 0);
  if (hasSpecificFocus) return false;
  if (!['top_bottom_shoes', 'top_bottom', 'top_shoes', 'bottom_shoes'].includes(requestedForm)) return false;
  return requestedSlots >= 2 && (vibeCount > 0 || occasionCount > 0 || activityCount > 0);
}

function weightedRecommendationChoice(entries, {
  penaltyById = null,
  penaltyWeight = 0,
  closenessScale = 1,
  rarityById = null,
  rarityWeight = 0,
} = {}) {
  if (!Array.isArray(entries) || !entries.length) return null;
  if (entries.length === 1) return entries[0];
  const bestScore = entries[0]?.score || 0;
  const weighted = entries.map((entry, index) => {
    const id = entry?.candidate?.id || '';
    const gap = Math.max(0, bestScore - (entry?.score || 0));
    const closeness = Math.exp(-gap / Math.max(0.35, closenessScale));
    const rankWeight = Math.max(0.3, 1 - index * 0.08);
    const penalty = penaltyById && id ? (penaltyById.get(id) || 0) * penaltyWeight : 0;
    const rarity = rarityById && id ? (rarityById.get(id) || 0) * rarityWeight : 0;
    return {
      entry,
      weight: Math.max(0.001, closeness * rankWeight + rarity - penalty),
    };
  });
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let cursor = Math.random() * (total || 1);
  for (const entry of weighted) {
    cursor -= entry.weight;
    if (cursor <= 0) return entry.entry;
  }
  return weighted[0]?.entry || entries[0];
}

function buildRecommendationSlotPools(sourcePools, fallbackOutfits, genderPref) {
  const pools = {};
  for (const slot of CATEGORY_KEYS) {
    const raw = Array.isArray(sourcePools?.[slot]) && sourcePools[slot].length
      ? sourcePools[slot]
      : Array.isArray(fallbackOutfits)
        ? fallbackOutfits.map((outfit) => outfit?.[slot]).filter(Boolean)
        : [];
    const seen = new Set();
    pools[slot] = raw.filter((item) => {
      if (!item || !recommendationGenderCompatible(item, genderPref)) return false;
      if (!recommendationSlotCompatible(item, slot)) return false;
      const key = String(item.id || item.imagePath || '').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return pools;
}

function repairFocusSpecificOutfits(outfits, slotPools, intent, genderPref) {
  const focus = recommendationFocusTerms(intent);
  if (!Array.isArray(outfits) || !outfits.length || !focus.length) return outfits;

  return outfits.map((outfit) => {
    let next = outfit;
    for (const slot of CATEGORY_KEYS) {
      const pool = Array.isArray(slotPools?.[slot])
        ? slotPools[slot].filter((item) => recommendationGenderCompatible(item, genderPref) && recommendationSlotCompatible(item, slot))
        : [];
      if (!pool.length) continue;
      const current = next?.[slot] || null;
      const currentScore = recommendationFocusScore(current, intent, slot);
      const ranked = pool
        .map((candidate) => ({ candidate, score: recommendationFocusScore(candidate, intent, slot) }))
        .filter((entry) => Number.isFinite(entry.score))
        .sort((a, b) => b.score - a.score);
      const best = ranked[0]?.candidate || current;
      const bestScore = ranked[0]?.score ?? currentScore;
      if (best && best !== current && bestScore > 0 && bestScore >= currentScore) {
        next = { ...next, [slot]: best };
      }
    }
    return next;
  });
}

function repairBrandFitOutfits(outfits, slotPools, intent, genderPref) {
  const mode = String(intent?.brand_fit_mode || '').trim().toLowerCase() || 'none';
  const brandTerms = recommendationBrandTerms(intent);
  if (!Array.isArray(outfits) || !outfits.length || !brandTerms.length || mode === 'none') return outfits;
  const requestedSlots = recommendationRequestedSlots(intent);
  if (!requestedSlots.length) return outfits;

  const rankedBrandCandidatesForSlot = (slot) => {
    const pool = Array.isArray(slotPools?.[slot])
      ? slotPools[slot].filter((item) => recommendationGenderCompatible(item, genderPref) && recommendationSlotCompatible(item, slot))
      : [];
    return pool
      .map((candidate) => ({ candidate, score: recommendationBrandScore(candidate, intent, slot) }))
      .filter((entry) => Number.isFinite(entry.score) && entry.score > 0)
      .sort((a, b) => b.score - a.score);
  };

  return outfits.map((outfit) => {
    let next = outfit;
    if (mode === 'full_brand_coverage') {
      for (const slot of requestedSlots) {
        const current = next?.[slot] || null;
        const currentScore = recommendationBrandScore(current, intent, slot);
        if (Number.isFinite(currentScore) && currentScore > 0) continue;
        const ranked = rankedBrandCandidatesForSlot(slot);
        const best = ranked[0]?.candidate || null;
        if (best) {
          next = { ...next, [slot]: best };
        }
      }
      return next;
    }

    const hasBrandHit = requestedSlots.some((slot) => {
      const score = recommendationBrandScore(next?.[slot] || null, intent, slot);
      return Number.isFinite(score) && score > 0;
    });
    if (hasBrandHit) return next;

    let replacement = null;
    const prioritySlots = ['top', 'bottom', 'mono', 'shoes'].filter((slot) => requestedSlots.includes(slot));
    for (const slot of prioritySlots) {
      const ranked = rankedBrandCandidatesForSlot(slot);
      const best = ranked[0] || null;
      if (!best?.candidate || !Number.isFinite(best.score) || best.score <= 0) continue;
      const slotPriority =
        slot === 'top' ? 2.4 :
        slot === 'bottom' ? 1.8 :
        slot === 'mono' ? 1.4 :
        0.9;
      const adjustedScore = best.score + slotPriority;
      if (!replacement || adjustedScore > replacement.score) {
        replacement = { slot, candidate: best.candidate, score: adjustedScore };
      }
    }
    if (!replacement) return next;
    return { ...next, [replacement.slot]: replacement.candidate };
  });
}

function enforceReturnedBrandCoverage(outfits, slotPools, intent, genderPref) {
  const mode = String(intent?.brand_fit_mode || '').trim().toLowerCase() || 'none';
  const brandTerms = recommendationBrandTerms(intent);
  if (!Array.isArray(outfits) || !outfits.length || !brandTerms.length || mode === 'none') return outfits;
  const requestedSlots = recommendationRequestedSlots(intent);
  if (!requestedSlots.length) return outfits;

  const firstPositiveBrandCandidate = (slot) =>
    (Array.isArray(slotPools?.[slot]) ? slotPools[slot] : []).find((item) =>
      recommendationGenderCompatible(item, genderPref) &&
      recommendationSlotCompatible(item, slot) &&
      recommendationItemMatchesBrand(item, intent),
    ) || null;

  return outfits.map((outfit) => {
    let next = outfit;
    if (mode === 'full_brand_coverage') {
      for (const slot of requestedSlots) {
        if (recommendationItemMatchesBrand(next?.[slot] || null, intent)) continue;
        const replacement = firstPositiveBrandCandidate(slot);
        if (replacement) next = { ...next, [slot]: replacement };
      }
      return next;
    }

    const hasBrandHit = requestedSlots.some((slot) => recommendationItemMatchesBrand(next?.[slot] || null, intent));
    if (hasBrandHit) return next;

    const prioritySlots = ['top', 'bottom', 'mono', 'shoes'].filter((slot) => requestedSlots.includes(slot));
    for (const slot of prioritySlots) {
      const replacement = firstPositiveBrandCandidate(slot);
      if (replacement) return { ...next, [slot]: replacement };
    }
    return next;
  });
}

function enforceReturnedRefinedSelection(outfits, slotPools, intent, genderPref) {
  const sport = normalizeText(intent?.sport_context || 'none');
  if (!Array.isArray(outfits) || !outfits.length || !refinedIntentActive(intent) || sport !== 'none') return outfits;
  const broadPrompt = broadRecommendationPrompt(intent);
  const brandModeActive = recommendationBrandModeActive(intent);
  const requestedSlots = new Set(recommendationRequestedSlots(intent));

  const rankedCandidatesForSlot = (slot) => {
    const pool = Array.isArray(slotPools?.[slot])
      ? slotPools[slot].filter((item) => recommendationGenderCompatible(item, genderPref) && recommendationSlotCompatible(item, slot))
      : [];
    const scorer =
      slot === 'top' && recommendationOldMoneyMensIntent(intent, genderPref)
        ? (item) => recommendationOldMoneyMensTopScore(item, intent, genderPref)
        : slot === 'top' || slot === 'bottom'
          ? (item) => recommendationRefinedApparelScore(item, intent, slot, genderPref)
          : slot === 'shoes'
            ? (item) => recommendationRefinedFootwearScore(item, intent)
            : () => -Infinity;
    const ranked = pool
      .map((candidate) => ({ candidate, score: scorer(candidate) }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => b.score - a.score);
    return recommendationPreferLaneEligible(ranked, slot, intent, genderPref, (entry) => entry.candidate);
  };

  return outfits.map((outfit) => {
    let next = outfit;
    for (const slot of ['top', 'bottom', 'shoes']) {
      const scorer =
        slot === 'top' && recommendationOldMoneyMensIntent(intent, genderPref)
          ? (item) => recommendationOldMoneyMensTopScore(item, intent, genderPref)
          : slot === 'top' || slot === 'bottom'
            ? (item) => recommendationRefinedApparelScore(item, intent, slot, genderPref)
            : (item) => recommendationRefinedFootwearScore(item, intent);
      const current = next?.[slot] || null;
      const currentScore = scorer(current);
      if (brandModeActive && requestedSlots.has(slot) && recommendationItemMatchesBrand(next?.[slot] || null, intent)) {
        continue;
      }
      const { entries: ranked, restricted: laneRestricted } = rankedCandidatesForSlot(slot);
      const best = ranked[0] || null;
      if (!best?.candidate) continue;
      if (laneRestricted && current && !recommendationLaneEligible(current, slot, intent, genderPref) && best.candidate !== current) {
        next = { ...next, [slot]: best.candidate };
        continue;
      }
      if (slot === 'top' && recommendationLowInformationRefinedTop(next?.[slot] || null, intent, genderPref)) {
        const cleanerTop = ranked.find((entry) =>
          !recommendationLowInformationRefinedTop(entry.candidate, intent, genderPref) &&
          entry.score >= Math.max(best.score - 1.2, currentScore - 0.35),
        );
        if (cleanerTop?.candidate && cleanerTop.candidate !== next?.[slot]) {
          next = { ...next, top: cleanerTop.candidate };
          continue;
        }
      }
      if (slot === 'bottom' && (recommendationLowInformationRefinedBottomPenalty(next?.[slot] || null) <= -5.5 || recommendationOpaqueNumericIdentity(next?.[slot] || null))) {
        const cleanerBottom = ranked.find((entry) =>
          !recommendationOpaqueNumericIdentity(entry.candidate) &&
          recommendationLowInformationRefinedBottomPenalty(entry.candidate) > -5.5 &&
          entry.score >= Math.max(best.score - 1.4, currentScore - 0.75),
        );
        if (cleanerBottom?.candidate && cleanerBottom.candidate !== next?.[slot]) {
          next = { ...next, bottom: cleanerBottom.candidate };
          continue;
        }
      }
      let acceptableFloor = Math.max(
        slot === 'shoes' ? 0.6 : slot === 'top' ? 0.9 : 0.5,
        best.score - (broadPrompt ? (slot === 'top' ? 1.9 : slot === 'bottom' ? 0.85 : slot === 'shoes' ? 1.05 : 1.3) : 0.6),
      );
      if (slot === 'bottom' && recommendationLowInformationRefinedBottomPenalty(next?.[slot] || null) <= -5.5) {
        acceptableFloor = Math.max(acceptableFloor, best.score - 0.35);
      }
      if (currentScore < acceptableFloor && best.score > currentScore + 0.35) {
        next = { ...next, [slot]: best.candidate };
      }
    }
    return next;
  });
}

function diversifyBroadPromptOutfits(outfits, slotPools, intent, genderPref) {
  if (!Array.isArray(outfits) || outfits.length < 2 || !broadRecommendationPrompt(intent)) return outfits;
  const next = outfits.map((outfit) => ({ ...outfit }));
  const priority = [
    ['top', 4],
    ['bottom', 4],
    ['shoes', 3],
  ];
  const uniqueIds = (slot) => new Set(next.map((outfit) => outfit?.[slot]?.id).filter(Boolean));

  for (const [slot, target] of priority) {
    const pool = Array.isArray(slotPools?.[slot])
      ? slotPools[slot]
          .filter((item) => recommendationGenderCompatible(item, genderPref) && recommendationSlotCompatible(item, slot))
          .slice(0, Math.max(target * 3, 8))
      : [];
    const { entries: lanePool } = recommendationPreferLaneEligible(pool, slot, intent, genderPref);
    const usablePool = lanePool.length ? lanePool : pool;
    if (!usablePool.length) continue;
    const seen = uniqueIds(slot);
    if (seen.size >= Math.min(target, usablePool.length)) continue;
    let insertIndex = 0;
    for (const candidate of usablePool) {
      if (!candidate?.id || seen.has(candidate.id)) continue;
      while (insertIndex < next.length && !next[insertIndex]?.[slot]) insertIndex += 1;
      if (insertIndex >= next.length) break;
      next[insertIndex] = { ...next[insertIndex], [slot]: candidate };
      seen.add(candidate.id);
      insertIndex += 1;
      if (seen.size >= Math.min(target, usablePool.length)) break;
    }
  }

  const choiceWindow = Math.min(8, next.length);
  if (choiceWindow > 1) {
    const window = next.slice(0, choiceWindow);
    const coreCounts = new Map();
    const topCounts = new Map();
    const bottomCounts = new Map();
    const shoeCounts = new Map();
    for (const outfit of window) {
      const topId = outfit?.top?.id || '';
      const bottomId = outfit?.bottom?.id || '';
      const shoeId = outfit?.shoes?.id || '';
      const monoId = outfit?.mono?.id || '';
      const coreId = monoId || `${topId || '-'}|${bottomId || '-'}`;
      if (coreId) coreCounts.set(coreId, (coreCounts.get(coreId) || 0) + 1);
      if (topId) topCounts.set(topId, (topCounts.get(topId) || 0) + 1);
      if (bottomId) bottomCounts.set(bottomId, (bottomCounts.get(bottomId) || 0) + 1);
      if (shoeId) shoeCounts.set(shoeId, (shoeCounts.get(shoeId) || 0) + 1);
    }
    const weights = window.map((outfit, index) => {
      const topId = outfit?.top?.id || '';
      const bottomId = outfit?.bottom?.id || '';
      const shoeId = outfit?.shoes?.id || '';
      const monoId = outfit?.mono?.id || '';
      const coreId = monoId || `${topId || '-'}|${bottomId || '-'}`;
      const rankWeight = Math.max(0.35, 1 - index * 0.06);
      const coreBonus = Math.max(0, 2 - (coreCounts.get(coreId) || 0)) * 0.9;
      const topBonus = topId ? Math.max(0, 3 - (topCounts.get(topId) || 0)) * 0.45 : 0;
      const bottomBonus = bottomId ? Math.max(0, 3 - (bottomCounts.get(bottomId) || 0)) * 0.35 : 0;
      const shoeBonus = shoeId ? Math.max(0, 3 - (shoeCounts.get(shoeId) || 0)) * 0.38 : 0;
      return rankWeight * (1 + coreBonus + topBonus + bottomBonus + shoeBonus);
    });
    const total = weights.reduce((sum, value) => sum + value, 0);
    let cursor = Math.random() * (total || 1);
    let chosenIndex = 0;
    for (let index = 0; index < weights.length; index += 1) {
      cursor -= weights[index];
      if (cursor <= 0) {
        chosenIndex = index;
        break;
      }
    }
    const [chosen] = next.splice(chosenIndex, 1);
    next.unshift(chosen);
  }
  return next;
}

function finalizeBroadPromptLead(outfits, intent, slotPools, genderPref) {
  if (!Array.isArray(outfits) || outfits.length < 2 || !broadRecommendationPrompt(intent)) return outfits;
  const deduped = [];
  const seenSignatures = new Set();
  for (const outfit of outfits) {
    const signature = CATEGORY_KEYS.map((slot) => outfit?.[slot]?.id || '').join('|');
    if (!signature || seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    deduped.push(outfit);
  }
  if (deduped.length < 2) return deduped.length ? deduped : outfits;

  const windowSize = Math.min(deduped.length, 8);
  const window = deduped.slice(0, windowSize);
  const coreCounts = new Map();
  const topCounts = new Map();
  const bottomCounts = new Map();
  const shoeCounts = new Map();
  for (const outfit of window) {
    const topId = outfit?.top?.id || '';
    const bottomId = outfit?.bottom?.id || '';
    const shoeId = outfit?.shoes?.id || '';
    const monoId = outfit?.mono?.id || '';
    const coreKey = monoId || `${topId || '-'}|${bottomId || '-'}`;
    if (coreKey) coreCounts.set(coreKey, (coreCounts.get(coreKey) || 0) + 1);
    if (topId) topCounts.set(topId, (topCounts.get(topId) || 0) + 1);
    if (bottomId) bottomCounts.set(bottomId, (bottomCounts.get(bottomId) || 0) + 1);
    if (shoeId) shoeCounts.set(shoeId, (shoeCounts.get(shoeId) || 0) + 1);
  }
  const weighted = window.map((outfit, index) => {
    const topId = outfit?.top?.id || '';
    const bottomId = outfit?.bottom?.id || '';
    const shoeId = outfit?.shoes?.id || '';
    const monoId = outfit?.mono?.id || '';
    const coreKey = monoId || `${topId || '-'}|${bottomId || '-'}`;
    const rankWeight = Math.max(0.32, 1 - index * 0.08);
    const coreBonus = Math.max(0, 2 - (coreCounts.get(coreKey) || 0)) * 0.95;
    const topBonus = topId ? Math.max(0, 3 - (topCounts.get(topId) || 0)) * 0.5 : 0;
    const bottomBonus = bottomId ? Math.max(0, 3 - (bottomCounts.get(bottomId) || 0)) * 0.42 : 0;
    const shoeBonus = shoeId ? Math.max(0, 3 - (shoeCounts.get(shoeId) || 0)) * 0.42 : 0;
    return { outfit, weight: rankWeight * (1 + coreBonus + topBonus + bottomBonus + shoeBonus) };
  });
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let cursor = Math.random() * (total || 1);
  let chosenIndex = 0;
  for (let index = 0; index < weighted.length; index += 1) {
    cursor -= weighted[index].weight;
    if (cursor <= 0) {
      chosenIndex = index;
      break;
    }
  }
  const reordered = deduped.slice();
  const [chosen] = reordered.splice(chosenIndex, 1);
  let lead = chosen;
  for (const slot of ['top', 'bottom', 'shoes']) {
    if (!lead?.[slot] || recommendationLaneEligible(lead[slot], slot, intent, genderPref)) continue;
    const pool = Array.isArray(slotPools?.[slot])
      ? slotPools[slot].filter((item) => recommendationGenderCompatible(item, genderPref) && recommendationSlotCompatible(item, slot))
      : [];
    if (!pool.length) continue;
    const sport = normalizeText(intent?.sport_context || 'none');
    const scorer =
      slot === 'top' && recommendationOldMoneyMensIntent(intent, genderPref)
        ? (item) => recommendationOldMoneyMensTopScore(item, intent, genderPref)
        : slot === 'top' || slot === 'bottom'
          ? sport !== 'none'
            ? (item) => recommendationSportApparelScore(item, sport, slot)
            : (item) => recommendationRefinedApparelScore(item, intent, slot, genderPref)
          : sport !== 'none'
            ? (item) => recommendationSportFootwearScore(item, sport)
            : (item) => recommendationRefinedFootwearScore(item, intent);
    const ranked = pool
      .map((candidate) => ({ candidate, score: scorer(candidate) }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => b.score - a.score);
    const { entries: laneRanked, restricted: laneRestricted } = recommendationPreferLaneEligible(
      ranked,
      slot,
      intent,
      genderPref,
      (entry) => entry.candidate,
    );
    if (laneRestricted && laneRanked[0]?.candidate) {
      lead = { ...lead, [slot]: laneRanked[0].candidate };
    }
  }
  if (refinedIntentActive(intent) && normalizeText(intent?.sport_context || 'none') === 'none') {
    const shoePool = Array.isArray(slotPools?.shoes)
      ? slotPools.shoes.filter((item) => recommendationGenderCompatible(item, genderPref) && recommendationSlotCompatible(item, 'shoes'))
      : [];
    if (shoePool.length >= 3) {
      const rankedShoes = shoePool
        .map((candidate) => ({ candidate, score: recommendationRefinedFootwearScore(candidate, intent) }))
        .filter((entry) => Number.isFinite(entry.score))
        .sort((a, b) => b.score - a.score);
      const { entries: laneRankedShoes } = recommendationPreferLaneEligible(
        rankedShoes,
        'shoes',
        intent,
        genderPref,
        (entry) => entry.candidate,
      );
      if (laneRankedShoes.length) {
        const bestShoeScore = laneRankedShoes[0].score;
        const acceptableFloor = Math.max(0.6, bestShoeScore - 1.65);
        const eligibleShoes = laneRankedShoes.filter((entry) => entry.score >= acceptableFloor).slice(0, 5);
        const shoeUsage = new Map();
        reordered.slice(0, Math.min(reordered.length, 6)).forEach((outfit) => {
          const id = outfit?.shoes?.id || '';
          if (!id) return;
          shoeUsage.set(id, (shoeUsage.get(id) || 0) + 1);
        });
        const currentShoe = lead?.shoes || null;
        const currentId = currentShoe?.id || '';
        if (currentId) shoeUsage.set(currentId, (shoeUsage.get(currentId) || 0) + 1);
        const currentScore = recommendationRefinedFootwearScore(currentShoe, intent);
        const currentUsage = currentId ? (shoeUsage.get(currentId) || 0) : 0;
        const alternativeShoes = eligibleShoes.filter((entry) =>
          entry?.candidate?.id &&
          entry.candidate.id !== currentId,
        );
        const chosenShoeEntry = weightedRecommendationChoice(
          alternativeShoes.length ? alternativeShoes : eligibleShoes,
          {
            penaltyById: shoeUsage,
            penaltyWeight: 0.2,
            closenessScale: 0.65,
          },
        ) || alternativeShoes[0] || eligibleShoes[0] || null;
        if (
          chosenShoeEntry?.candidate &&
          chosenShoeEntry.candidate !== currentShoe &&
          currentUsage > 0
        ) {
          lead = { ...lead, shoes: chosenShoeEntry.candidate };
        }
      }
    }
  }
  reordered.unshift(lead);
  return reordered;
}

function finalizeBrandAwareLead(outfits, intent) {
  if (!Array.isArray(outfits) || outfits.length < 2) return outfits;
  const profile = recommendationBrandLeadProfile(intent);
  if (!profile.terms.length || profile.mode === 'none') return outfits;
  const requestedSlots = recommendationRequestedSlots(intent);
  const windowSize = Math.min(outfits.length, profile.mode === 'persona_soft' ? 6 : 8);
  const window = outfits.slice(0, windowSize);
  const scored = window.map((outfit, index) => {
    const coverage = recommendationOutfitBrandCoverage(outfit, profile.terms, requestedSlots);
    const rankWeight = Math.max(0.3, 1 - index * 0.08);
    return {
      outfit,
      index,
      ...coverage,
      priority: coverage.weighted * profile.weight + rankWeight,
    };
  });
  const current = scored[0];
  if (!current) return outfits;
  const ranked = [...scored].sort((a, b) =>
    b.count - a.count ||
    b.priority - a.priority ||
    a.index - b.index,
  );
  const best = ranked[0];
  if (!best || best.index === 0) return outfits;
  if (profile.mode !== 'persona_soft' && best.count <= current.count) return outfits;
  if (profile.mode === 'persona_soft') {
    if (best.count <= 0) return outfits;
    if (best.count < current.count) return outfits;
    if (best.count === current.count && best.priority <= current.priority + 0.15) return outfits;
  }
  const reordered = outfits.slice();
  const [chosen] = reordered.splice(best.index, 1);
  reordered.unshift(chosen);
  return reordered;
}

function synthesizeBroadPromptOutfitsFromPools(outfits, slotPools, intent, genderPref) {
  if (!Array.isArray(outfits) || outfits.length < 2 || !broadRecommendationPrompt(intent)) return outfits;
  const next = outfits.map((outfit) => ({ ...outfit }));
  const uniqueCount = (slot, window = next.length) =>
    new Set(next.slice(0, window).map((outfit) => outfit?.[slot]?.id).filter(Boolean)).size;
  const maxRepeatCount = (slot, window = next.length) => {
    const counts = new Map();
    next.slice(0, window).forEach((outfit) => {
      const id = outfit?.[slot]?.id || '';
      if (!id) return;
      counts.set(id, (counts.get(id) || 0) + 1);
    });
    return Math.max(0, ...counts.values());
  };
  const visibleWindow = Math.min(next.length, 4);
  const uniquePool = (slot, count) => {
    const seen = new Set();
    const deduped = (Array.isArray(slotPools?.[slot]) ? slotPools[slot] : [])
      .filter((item) => recommendationGenderCompatible(item, genderPref) && recommendationSlotCompatible(item, slot))
      .filter((item) => {
        const id = item?.id;
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    const { entries: laneDeduped } = recommendationPreferLaneEligible(deduped, slot, intent, genderPref);
    const laneFiltered = laneDeduped.length ? laneDeduped : deduped;
    if (refinedIntentActive(intent) && normalizeText(intent?.sport_context || 'none') === 'none' && ['top', 'bottom', 'shoes'].includes(slot)) {
      const scorer =
        slot === 'top' && recommendationOldMoneyMensIntent(intent, genderPref)
          ? (item) => recommendationOldMoneyMensTopScore(item, intent, genderPref)
          : slot === 'top' || slot === 'bottom'
            ? (item) => recommendationRefinedApparelScore(item, intent, slot, genderPref)
            : (item) => recommendationRefinedFootwearScore(item, intent);
      const ranked = laneFiltered
        .map((candidate) => ({ candidate, score: scorer(candidate) }))
        .filter((entry) => Number.isFinite(entry.score))
        .sort((a, b) => b.score - a.score);
      if (!ranked.length) return [];
      let acceptableFloor = Math.max(
        slot === 'shoes' ? 0.6 : slot === 'top' ? 0.9 : 0.5,
        ranked[0].score - (slot === 'top' ? 1.6 : slot === 'bottom' ? 0.45 : 0.9),
      );
      const filtered = ranked.filter((entry) => entry.score >= acceptableFloor).map((entry) => entry.candidate);
      const lowInfoBottomFiltered =
        slot === 'bottom' && filtered.filter((item) => recommendationLowInformationRefinedBottomPenalty(item) > -5.5).length >= 3
          ? filtered.filter((item) => recommendationLowInformationRefinedBottomPenalty(item) > -5.5)
          : filtered;
      return (lowInfoBottomFiltered.length ? lowInfoBottomFiltered : filtered).slice(0, count);
    }
    return laneFiltered.slice(0, count);
  };
  const topPool = uniquePool('top', 4);
  const bottomPool = uniquePool('bottom', 4);
  const shoePool = uniquePool('shoes', 3);
  const needTop = uniqueCount('top', visibleWindow) <= 1 && topPool.length >= 3;
  const needBottom = uniqueCount('bottom', visibleWindow) <= 2 && bottomPool.length >= 3;
  const needShoes =
    shoePool.length >= 3 &&
    (uniqueCount('shoes', visibleWindow) <= 2 || maxRepeatCount('shoes', visibleWindow) > 1);
  if (!needTop && !needBottom && !needShoes) return outfits;

  const window = Math.min(next.length, Math.max(4, Math.max(topPool.length, bottomPool.length, shoePool.length)));
  for (let index = 0; index < window; index++) {
    const base = { ...next[index] };
    if (needTop && topPool.length) base.top = topPool[index % topPool.length];
    if (needBottom && bottomPool.length) base.bottom = bottomPool[index % bottomPool.length];
    if (needShoes && shoePool.length) base.shoes = shoePool[index % shoePool.length];
    next[index] = base;
  }
  if (window > 1) {
    const offset = Math.floor(Math.random() * Math.min(window, 4));
    const [chosen] = next.splice(offset, 1);
    next.unshift(chosen);
  }
  return next;
}

function repairSportSpecificApparel(outfits, slotPools, intent, genderPref) {
  const sport = normalizeText(intent?.sport_context || '');
  if (!Array.isArray(outfits) || !outfits.length || !sport || sport === 'none') return outfits;
  return outfits.map((outfit) => {
    let next = outfit;
    for (const slot of ['top', 'bottom']) {
      const pool = Array.isArray(slotPools?.[slot])
        ? slotPools[slot].filter((item) => recommendationGenderCompatible(item, genderPref) && recommendationSlotCompatible(item, slot))
        : [];
      if (!pool.length) continue;
      const rankedPool = pool
        .map((candidate) => ({ candidate, score: recommendationSportApparelScore(candidate, sport, slot) }))
        .sort((a, b) => b.score - a.score);
      const { entries: ranked, restricted: laneRestricted } = recommendationPreferLaneEligible(
        rankedPool,
        slot,
        intent,
        genderPref,
        (entry) => entry.candidate,
      );
      const current = next?.[slot] || null;
      const currentScore = recommendationSportApparelScore(current, sport, slot);
      let best = current;
      let bestScore = currentScore;
      for (const entry of ranked) {
        const candidate = entry.candidate;
        const candidateScore = entry.score;
        if (candidateScore > bestScore) {
          best = candidate;
          bestScore = candidateScore;
        }
      }
      if (laneRestricted && current && !recommendationLaneEligible(current, slot, intent, genderPref) && best && best !== current) {
        next = { ...next, [slot]: best };
        continue;
      }
      if (best && best !== current && bestScore >= currentScore + 0.5) {
        next = { ...next, [slot]: best };
      }
    }
    return next;
  });
}

function repairSportSpecificOutfits(outfits, slotPools, intent, genderPref) {
  const sport = normalizeText(intent?.sport_context || '');
  if (!Array.isArray(outfits) || !outfits.length || !sport || sport === 'none') return outfits;
  const shoePool = Array.isArray(slotPools?.shoes) ? slotPools.shoes.filter((item) => recommendationGenderCompatible(item, genderPref)) : [];
  if (!shoePool.length) return outfits;

  return outfits.map((outfit) => {
    const current = outfit?.shoes || null;
    const currentScore = recommendationSportFootwearScore(current, sport);
    let best = current;
    let bestScore = currentScore;
    for (const candidate of shoePool) {
      const candidateScore = recommendationSportFootwearScore(candidate, sport);
      if (candidateScore > bestScore) {
        best = candidate;
        bestScore = candidateScore;
      }
    }
    if (!best || best === current || bestScore < currentScore + 0.25) return outfit;
    return { ...outfit, shoes: best };
  });
}

function repairTeamSpecificOutfits(outfits, slotPools, intent, genderPref) {
  const teams = Array.isArray(intent?.team_focus) ? intent.team_focus : [];
  const sport = normalizeText(intent?.sport_context || '');
  if (!Array.isArray(outfits) || !outfits.length || !teams.length) return outfits;

  return outfits.map((outfit) => {
    let next = outfit;
    for (const slot of ['top', 'bottom'] ) {
      const pool = Array.isArray(slotPools?.[slot]) ? slotPools[slot].filter((item) => recommendationGenderCompatible(item, genderPref)) : [];
      if (!pool.length) continue;
      const current = next?.[slot] || null;
      const currentScore = recommendationTeamScore(current, teams, slot, sport);
      let best = current;
      let bestScore = currentScore;
      for (const candidate of pool) {
        const candidateScore = recommendationTeamScore(candidate, teams, slot, sport);
        if (candidateScore > bestScore) {
          best = candidate;
          bestScore = candidateScore;
        }
      }
      if (best && best !== current && bestScore >= currentScore + 2.5) {
        next = { ...next, [slot]: best };
      }
    }
    return next;
  });
}

function repairRefinedFootwearOutfits(outfits, slotPools, intent, genderPref) {
  if (!Array.isArray(outfits) || !outfits.length || !refinedIntentActive(intent) || normalizeText(intent?.sport_context || '') !== 'none') {
    return outfits;
  }
  const broadPrompt = broadRecommendationPrompt(intent);
  const brandModeActive = recommendationBrandModeActive(intent);
  const requestedSlots = new Set(recommendationRequestedSlots(intent));
  const shoePool = Array.isArray(slotPools?.shoes)
    ? slotPools.shoes.filter((item) => recommendationGenderCompatible(item, genderPref) && recommendationSlotCompatible(item, 'shoes'))
    : [];
  if (!shoePool.length) return outfits;
  const ranked = shoePool
    .map((candidate) => ({ candidate, score: recommendationRefinedFootwearScore(candidate, intent) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score);
  const { entries: laneRanked, restricted: laneRestricted } = recommendationPreferLaneEligible(
    ranked,
    'shoes',
    intent,
    genderPref,
    (entry) => entry.candidate,
  );
  if (!laneRanked.length) return outfits;
  const bestScore = laneRanked[0].score;
  const acceptableFloor = Math.max(0.6, bestScore - (broadPrompt ? 1.05 : 0.75));
  const usage = new Map();

  return outfits.map((outfit) => {
    const current = outfit?.shoes || null;
    const currentId = current?.id || null;
    const currentScore = recommendationRefinedFootwearScore(current, intent);
    if (currentId) usage.set(currentId, (usage.get(currentId) || 0) + 1);
    if (brandModeActive && requestedSlots.has('shoes') && recommendationItemMatchesBrand(current, intent)) return outfit;
    const eligible = laneRanked.filter((entry) => entry.score >= acceptableFloor).slice(0, broadPrompt ? 8 : 4);
    const adjustedEligible = eligible
      .map((entry) => ({
        ...entry,
        adjusted: entry.score - (broadPrompt ? 0.65 : 0.2) * (usage.get(entry.candidate?.id || '') || 0),
      }))
      .sort((a, b) => b.adjusted - a.adjusted);
    const chosenEntry = broadPrompt
      ? weightedRecommendationChoice(
          adjustedEligible.slice(0, 6),
          {
            penaltyById: usage,
            penaltyWeight: 0.18,
            closenessScale: 0.7,
          },
        ) || adjustedEligible[0] || ranked[0]
      : adjustedEligible[0] || laneRanked[0];
    const chosen = chosenEntry?.candidate || current;
    const currentUsage = currentId ? (usage.get(currentId) || 0) : 0;
    const currentAdjusted =
      current && Number.isFinite(currentScore)
        ? currentScore - (broadPrompt ? 0.65 : 0.2) * currentUsage
        : -Infinity;
    const shouldDiversifyAcceptable =
      broadPrompt &&
      current &&
      currentScore >= acceptableFloor &&
      currentUsage > 0 &&
      chosen &&
      chosen !== current &&
      (chosenEntry?.adjusted ?? -Infinity) > currentAdjusted + 0.12 &&
      (chosenEntry?.score ?? -Infinity) >= currentScore - 0.18;
    if (laneRestricted && current && !recommendationLaneEligible(current, 'shoes', intent, genderPref) && chosen && chosen !== current) {
      const chosenId = chosen?.id || null;
      if (currentId) usage.set(currentId, Math.max(0, (usage.get(currentId) || 1) - 1));
      if (chosenId) usage.set(chosenId, (usage.get(chosenId) || 0) + 1);
      return { ...outfit, shoes: chosen };
    }
    if (current && currentScore >= acceptableFloor && !shouldDiversifyAcceptable) return outfit;
    if (!chosen || chosen === current) return outfit;
    const chosenId = chosen?.id || null;
    if (currentId) usage.set(currentId, Math.max(0, (usage.get(currentId) || 1) - 1));
    if (chosenId) usage.set(chosenId, (usage.get(chosenId) || 0) + 1);
    return { ...outfit, shoes: chosen };
  });
}

function repairRefinedApparelOutfits(outfits, slotPools, intent, genderPref) {
  if (!Array.isArray(outfits) || !outfits.length || !refinedIntentActive(intent) || normalizeText(intent?.sport_context || '') !== 'none') {
    return outfits;
  }
  const broadPrompt = broadRecommendationPrompt(intent);
  const brandModeActive = recommendationBrandModeActive(intent);
  const requestedSlots = new Set(recommendationRequestedSlots(intent));
  const usageBySlot = {
    top: new Map(),
    bottom: new Map(),
  };

  return outfits.map((outfit) => {
    let next = outfit;
    for (const slot of ['top', 'bottom']) {
      const pool = Array.isArray(slotPools?.[slot])
        ? slotPools[slot].filter((item) => recommendationGenderCompatible(item, genderPref) && recommendationSlotCompatible(item, slot))
        : [];
      if (!pool.length) continue;
      const scoreItem = (item) =>
        slot === 'top' && recommendationOldMoneyMensIntent(intent, genderPref)
          ? recommendationOldMoneyMensTopScore(item, intent, genderPref)
          : recommendationRefinedApparelScore(item, intent, slot, genderPref);
      const ranked = pool
        .map((candidate) => ({ candidate, score: scoreItem(candidate) }))
        .filter((entry) => Number.isFinite(entry.score))
        .sort((a, b) => b.score - a.score);
      const { entries: laneRanked, restricted: laneRestricted } = recommendationPreferLaneEligible(
        ranked,
        slot,
        intent,
        genderPref,
        (entry) => entry.candidate,
      );
      if (!laneRanked.length) continue;
      const bestScore = laneRanked[0].score;
      const acceptableFloor = Math.max(
        slot === 'top' ? 0.9 : 0.5,
        bestScore - (slot === 'top' && broadPrompt ? 1.9 : slot === 'bottom' && broadPrompt ? 0.85 : broadPrompt ? 1.3 : 0.85),
      );
      const current = next?.[slot] || null;
      const currentId = current?.id || null;
      const currentScore = scoreItem(current);
      if (currentId) usageBySlot[slot].set(currentId, (usageBySlot[slot].get(currentId) || 0) + 1);
      if (brandModeActive && requestedSlots.has(slot) && recommendationItemMatchesBrand(current, intent)) continue;
      if (laneRestricted && current && !recommendationLaneEligible(current, slot, intent, genderPref) && laneRanked[0]?.candidate && laneRanked[0].candidate !== current) {
        const chosenId = laneRanked[0].candidate?.id || null;
        if (currentId) usageBySlot[slot].set(currentId, Math.max(0, (usageBySlot[slot].get(currentId) || 1) - 1));
        if (chosenId) usageBySlot[slot].set(chosenId, (usageBySlot[slot].get(chosenId) || 0) + 1);
        next = { ...next, [slot]: laneRanked[0].candidate };
        continue;
      }
      if (slot === 'top' && recommendationLowInformationRefinedTop(current, intent, genderPref)) {
        const cleanerTop = laneRanked.find((entry) =>
          !recommendationLowInformationRefinedTop(entry.candidate, intent, genderPref) &&
          entry.score >= Math.max(laneRanked[0].score - 1.2, currentScore - 0.35),
        );
        if (cleanerTop?.candidate && cleanerTop.candidate !== current) {
          const chosenId = cleanerTop.candidate?.id || null;
          if (currentId) usageBySlot[slot].set(currentId, Math.max(0, (usageBySlot[slot].get(currentId) || 1) - 1));
          if (chosenId) usageBySlot[slot].set(chosenId, (usageBySlot[slot].get(chosenId) || 0) + 1);
          next = { ...next, [slot]: cleanerTop.candidate };
          continue;
        }
      }
      if (slot === 'bottom' && (recommendationLowInformationRefinedBottomPenalty(current) <= -5.5 || recommendationOpaqueNumericIdentity(current))) {
        const cleanerBottom = laneRanked.find((entry) =>
          !recommendationOpaqueNumericIdentity(entry.candidate) &&
          recommendationLowInformationRefinedBottomPenalty(entry.candidate) > -5.5 &&
          entry.score >= Math.max(laneRanked[0].score - 1.4, currentScore - 0.75),
        );
        if (cleanerBottom?.candidate && cleanerBottom.candidate !== current) {
          const chosenId = cleanerBottom.candidate?.id || null;
          if (currentId) usageBySlot[slot].set(currentId, Math.max(0, (usageBySlot[slot].get(currentId) || 1) - 1));
          if (chosenId) usageBySlot[slot].set(chosenId, (usageBySlot[slot].get(chosenId) || 0) + 1);
          next = { ...next, [slot]: cleanerBottom.candidate };
          continue;
        }
      }

      const eligible = laneRanked.filter((entry) => entry.score >= acceptableFloor).slice(0, broadPrompt ? 10 : 5);
      const adjustedEligible = eligible
        .map((entry) => ({
          ...entry,
          adjusted:
            entry.score -
            (broadPrompt ? (slot === 'top' ? 0.85 : 0.55) : 0.2) *
              (usageBySlot[slot].get(entry.candidate?.id || '') || 0),
        }))
        .sort((a, b) => b.adjusted - a.adjusted);
      const chosenEntry = broadPrompt
        ? weightedRecommendationChoice(
            adjustedEligible.slice(0, slot === 'top' ? 7 : 6),
            {
              penaltyById: usageBySlot[slot],
              penaltyWeight: slot === 'top' ? 0.22 : 0.16,
              closenessScale: slot === 'top' ? 0.9 : 0.65,
            },
          ) || adjustedEligible[0] || ranked[0]
        : adjustedEligible[0] || ranked[0];
      const chosen = chosenEntry?.candidate || current;
      const currentUsage = currentId ? (usageBySlot[slot].get(currentId) || 0) : 0;
      const currentAdjusted =
        current && Number.isFinite(currentScore)
          ? currentScore -
            (broadPrompt ? (slot === 'top' ? 0.85 : 0.55) : 0.2) * currentUsage
          : -Infinity;
      const shouldDiversifyAcceptable =
        broadPrompt &&
        current &&
        currentScore >= acceptableFloor &&
        currentUsage > 1 &&
        chosen &&
        chosen !== current &&
        (chosenEntry?.adjusted ?? -Infinity) > currentAdjusted + (slot === 'top' ? 0.14 : 0.1) &&
        (chosenEntry?.score ?? -Infinity) >= currentScore - (slot === 'top' ? 0.34 : 0.24);
      if (current && currentScore >= acceptableFloor && !shouldDiversifyAcceptable) continue;
      if (!chosen || chosen === current) continue;
      if (slot === 'bottom' && recommendationLowInformationRefinedBottomPenalty(current) <= -5.5 && laneRanked[0]?.score > currentScore + 0.25) {
        const cleanerBottom = laneRanked.find((entry) => recommendationLowInformationRefinedBottomPenalty(entry.candidate) > -5.5 && entry.score >= acceptableFloor);
        if (cleanerBottom?.candidate) {
          const chosenId = cleanerBottom.candidate?.id || null;
          if (currentId) usageBySlot[slot].set(currentId, Math.max(0, (usageBySlot[slot].get(currentId) || 1) - 1));
          if (chosenId) usageBySlot[slot].set(chosenId, (usageBySlot[slot].get(chosenId) || 0) + 1);
          next = { ...next, [slot]: cleanerBottom.candidate };
          continue;
        }
      }
      const chosenId = chosen?.id || null;
      if (currentId) usageBySlot[slot].set(currentId, Math.max(0, (usageBySlot[slot].get(currentId) || 1) - 1));
      if (chosenId) usageBySlot[slot].set(chosenId, (usageBySlot[slot].get(chosenId) || 0) + 1);
      next = { ...next, [slot]: chosen };
    }
    return next;
  });
}

function sortIntentAwareSlotPools(slotPools, intent, genderPref) {
  if (!slotPools || typeof slotPools !== 'object') return slotPools;
  const sport = normalizeText(intent?.sport_context || '');
  const brandModeActive = recommendationBrandModeActive(intent);
  const refined = refinedIntentActive(intent) && sport === 'none';
  const focusTerms = recommendationFocusTerms(intent);
  const next = {};
  for (const slot of CATEGORY_KEYS) {
    const list = Array.isArray(slotPools?.[slot]) ? [...slotPools[slot]] : [];
    if (!list.length) {
      next[slot] = [];
      continue;
    }
    if (sport !== 'none') {
      if (slot === 'shoes') {
        list.sort((a, b) => recommendationSportFootwearScore(b, sport) - recommendationSportFootwearScore(a, sport));
      } else if (slot === 'top' || slot === 'bottom') {
        list.sort((a, b) => recommendationSportApparelScore(b, sport, slot) - recommendationSportApparelScore(a, sport, slot));
      }
    } else if (brandModeActive) {
      list.sort((a, b) => recommendationBrandScore(b, intent, slot) - recommendationBrandScore(a, intent, slot));
    } else if (refined) {
      if (slot === 'shoes') {
        list.sort((a, b) => recommendationRefinedFootwearScore(b, intent) - recommendationRefinedFootwearScore(a, intent));
      } else if (slot === 'top' || slot === 'bottom') {
        if (slot === 'top' && recommendationOldMoneyMensIntent(intent, genderPref)) {
          list.sort((a, b) => recommendationOldMoneyMensTopScore(b, intent, genderPref) - recommendationOldMoneyMensTopScore(a, intent, genderPref));
        } else {
          list.sort((a, b) => recommendationRefinedApparelScore(b, intent, slot, genderPref) - recommendationRefinedApparelScore(a, intent, slot, genderPref));
        }
      }
    } else if (focusTerms.length) {
      list.sort((a, b) => recommendationFocusScore(b, intent, slot) - recommendationFocusScore(a, intent, slot));
    }
    next[slot] = list.filter((item) => recommendationGenderCompatible(item, genderPref));
  }
  return next;
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function recommendWithRuntime({
  prompt,
  genderPref,
  poolSize,
  perRoleLimit,
  anchorEmbeddings,
  debug,
  timeoutMs,
}) {
  const runtime = await getRecommenderRuntime();
  const request = buildRecommenderRequest({
    prompt,
    genderPref,
    poolSize,
    perRoleLimit,
    anchorEmbeddings,
    debug,
  });
  return withTimeout(
    runtime.recommend(request),
    timeoutMs || RECOMMENDER_TIMEOUT_MS,
    'recommender_v2',
  );
}

function assertIngestAuthorized(req) {
  if (!INGEST_API_KEY) {
    throw new HttpError(503, 'Internal ingest API is not configured.');
  }
  const headerKey =
    req.headers['x-ingest-api-key'] ||
    req.headers['x-api-key'] ||
    req.query.ingest_api_key ||
    req.query.api_key;
  if (String(headerKey || '').trim() !== INGEST_API_KEY) {
    throw new HttpError(401, 'unauthorized');
  }
}

let firebaseAdminApp = null;

function getFirebaseAdminApp() {
  if (firebaseAdminApp) return firebaseAdminApp;
  if (getAdminApps().length) {
    firebaseAdminApp = getAdminApps()[0];
    return firebaseAdminApp;
  }
  const projectId =
    String(runtimeConfig.firebaseProjectId || PROJECT || '').trim() || undefined;
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKeyRaw = String(process.env.FIREBASE_PRIVATE_KEY || '').trim();
  if (clientEmail && privateKeyRaw) {
    firebaseAdminApp = initializeAdminApp({
      credential: adminCert({
        projectId,
        clientEmail,
        privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
      }),
      projectId,
    });
    return firebaseAdminApp;
  }
  firebaseAdminApp = initializeAdminApp({
    credential: adminApplicationDefault(),
    projectId,
  });
  return firebaseAdminApp;
}

async function requireBearerUser(req) {
  const token = getBearerToken(req);
  if (!token) {
    throw new HttpError(401, 'Missing bearer token.');
  }
  const app = getFirebaseAdminApp();
  const decoded = await getAdminAuth(app).verifyIdToken(token);
  const uid = String(decoded?.uid || '').trim();
  if (!uid) {
    throw new HttpError(401, 'Invalid bearer token.');
  }
  req.authUid = uid;
  req.authMode = 'verified';
  return { uid, token: decoded };
}

async function requireUserFacingAiAccess(req) {
  const token = getBearerToken(req);
  if (!token) {
    if (ALLOW_GUEST_AI_ROUTES) {
      req.authMode = 'guest';
      return { uid: '', token: null, guest: true };
    }
    throw new HttpError(401, 'Missing bearer token.');
  }
  const user = await requireBearerUser(req);
  return { ...user, guest: false };
}

/* ───────────────────── classifier helpers ───────────────────── */
const CLASSIFIER_CATEGORY_LABELS = {
  top: 'Top',
  bottom: 'Bottom',
  mono: 'Dress',
  shoes: 'Shoes',
};

const BRAND_RE =
  /\b(nike|adidas|puma|balenciaga|timberland|zara|gucci|prada|dior|lv|north face|patagonia|reebok|new balance|h&m|uniqlo)\b/i;

function toTitleCase(value = '') {
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTag(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  return v;
}

function uniqTags(list = []) {
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const tag = normalizeTag(entry);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

function pickBrand(entityMeta = [], entities = []) {
  const brands = Array.isArray(entityMeta)
    ? entityMeta.filter((e) => e?.type === 'brand' && e?.text)
    : [];
  if (brands.length) {
    const sorted = brands.sort((a, b) => (b.weight || 0) - (a.weight || 0));
    return toTitleCase(sorted[0].text);
  }
  const match = (entities || []).find((e) => BRAND_RE.test(String(e)));
  return match ? toTitleCase(match) : null;
}

function collectEntityTags(entityMeta = [], limit = 8) {
  if (!Array.isArray(entityMeta)) return [];
  return entityMeta
    .filter((e) => e?.text && e?.type && e.type !== 'generic')
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .map((e) => e.text)
    .slice(0, limit);
}

function buildClassifierTags({
  colours = [],
  vibes = [],
  brand,
  sub,
  sportMeta,
  entityMeta,
}) {
  const sportTag =
    sportMeta?.sport && sportMeta.sport !== 'none' && sportMeta.sport !== 'other'
      ? sportMeta.sport
      : null;
  const tags = uniqTags([
    ...colours,
    ...vibes,
    ...(brand ? [brand] : []),
    ...(sub ? [sub] : []),
    ...(sportTag ? [sportTag] : []),
    ...collectEntityTags(entityMeta),
  ]);
  return tags.slice(0, 40);
}

async function fetchImageBytes(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
  });
  if (!res.ok) {
    throw new HttpError(400, `Unable to fetch image (${res.status}).`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function inferImageExt(buffer) {
  const magic = sniffMagic(buffer);
  if (magic === 'png') return 'png';
  if (magic === 'jpeg') return 'jpg';
  return null;
}

function clampMinColours(value) {
  const num = Number(value || CLASSIFIER_MIN_COLOURS) || CLASSIFIER_MIN_COLOURS;
  return Math.max(1, Math.min(2, num));
}

function buildClassifierNodePath() {
  const parts = [];
  if (LOCAL_NODE_MODULES) parts.push(LOCAL_NODE_MODULES);
  if (process.env.NODE_PATH) parts.push(process.env.NODE_PATH);
  return Array.from(new Set(parts.filter(Boolean))).join(path.delimiter);
}

function runClassifierCli({ dir, out, minColours, timeoutMs }) {
  if (!CLASSIFIER_ENABLED) {
    throw new HttpError(503, 'Classifier CLI is not available on this server.');
  }

  const args = [
    CLASSIFIER_SCRIPT,
    '--images_dir',
    dir,
    '--out',
    out,
    '--min_colours',
    String(minColours),
  ];

  const env = {
    ...process.env,
    GOOGLE_CLOUD_PROJECT: PROJECT,
    NODE_PATH: buildClassifierNodePath(),
  };

  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, args, {
      cwd: CLASSIFIER_SCRIPT_DIR,
      env,
    });

    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new HttpError(504, 'Classifier timed out.'));
    }, timeoutMs || CLASSIFIER_TIMEOUT_MS);

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new HttpError(500, `Failed to spawn classifier: ${err?.message || err}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        if (stderr && DEBUG) {
          console.warn('[classifier stderr]', stderr.trim());
        }
        resolve();
        return;
      }
      const stderrText = stderr.trim();
      const details = { code, stderr: stderrText || '(empty stderr)' };
      if (stderrText || DEBUG) {
        console.error('[classifier error]', details);
      }
      const message = stderrText || `Classifier exited with code ${code}`;
      reject(new HttpError(502, message, details));
    });
  });
}

async function classifyImagePayload({ imageB64, imageUrl, minColours }) {
  const rawB64 = imageB64 ? stripDataUri(imageB64) : null;
  let buffer;
  if (rawB64) {
    buffer = Buffer.from(rawB64, 'base64');
  } else if (imageUrl) {
    buffer = await fetchImageBytes(imageUrl);
  } else {
    throw new HttpError(400, 'Missing image data.');
  }

  let ext = inferImageExt(buffer);
  if (!ext) {
    try {
      buffer = await sharp(buffer).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
      ext = 'jpg';
    } catch {
      throw new HttpError(400, 'Unsupported image format. Use PNG or JPEG.');
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-'));
  const filePath = path.join(dir, `input.${ext}`);
  const outPath = path.join(dir, 'out.json');
  try {
    fs.writeFileSync(filePath, buffer);
    await runClassifierCli({
      dir,
      out: outPath,
      minColours: clampMinColours(minColours),
    });
    const raw = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const item = Array.isArray(raw) ? raw[0] : null;
    if (!item) {
      throw new HttpError(502, 'Classifier did not return any results.');
    }

    const colours = Array.isArray(item.colours) ? item.colours.map(String) : [];
    const vibes = Array.isArray(item.vibes) ? item.vibes.map(String) : [];
    const entities = Array.isArray(item.entities) ? item.entities.map(String) : [];
    const entityMeta = Array.isArray(item.entityMeta) ? item.entityMeta : [];
    const occasionTags = Array.isArray(item.occasion_tags) ? item.occasion_tags.map(String) : [];
    const styleMarkers = Array.isArray(item.style_markers) ? item.style_markers.map(String) : [];
    const brand = pickBrand(entityMeta, entities);
    let tags = buildClassifierTags({
      colours,
      vibes,
      brand,
      sub: item.sub,
      sportMeta: item.sportMeta,
      entityMeta,
    });

    const category =
      CLASSIFIER_CATEGORY_LABELS[item.category] || (item.category ? toTitleCase(item.category) : null);
    const color = colours.length ? colours.join(', ') : '';

    if (!tags.length && category) {
      tags = [String(category).toLowerCase()];
    }

    return {
      category,
      brand: brand || null,
      color,
      colors: colours,
      sub: item.sub || null,
      fit: item.fit || null,
      vibes,
      occasionTags,
      styleMarkers,
      formalityScore: item.formality_score ?? null,
      streetwearScore: item.streetwear_score ?? null,
      cleanlinessScore: item.cleanliness_score ?? null,
      confidence: item.confidence ?? null,
      gender: item.gender || null,
      tags,
      raw: {
        category: item.category || null,
        sub: item.sub || null,
        colours,
        vibes,
        gender: item.gender || null,
        fit: item.fit || null,
        sportMeta: item.sportMeta || null,
        entities,
        entityMeta,
        occasion_tags: occasionTags,
        style_markers: styleMarkers,
        formality_score: item.formality_score ?? null,
        streetwear_score: item.streetwear_score ?? null,
        cleanliness_score: item.cleanliness_score ?? null,
        confidence: item.confidence ?? null,
      },
    };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

/* ───────────────────────── route ───────────────────────── */
app.post('/classify', async (req, res) => {
  if (!CLASSIFIER_ENABLED) {
    return res.status(503).json({ error: 'Classifier CLI not available on this server.' });
  }

  const body = req.body || {};
  const imageB64 =
    body.imageB64 ||
    body.image_b64 ||
    body.image ||
    body.photoB64 ||
    body.photo_b64 ||
    body.photo ||
    body.base64 ||
    null;
  const imageUrl =
    body.imageUrl ||
    body.image_url ||
    body.url ||
    body.photoUrl ||
    body.photo_url ||
    null;

  try {
    await requireUserFacingAiAccess(req);
    const result = await classifyImagePayload({
      imageB64,
      imageUrl,
      minColours: body.min_colours ?? body.minColours,
    });
    return res.json(result);
  } catch (err) {
    const status = err?.status || 500;
    console.error('[classifier]', err?.message || err);
    return res.status(status).json({
      error: err?.message || 'Unable to run classifier.',
      details: DEBUG ? err?.details : undefined,
    });
  }
});

app.post('/recommend', async (req, res) => {
  if (!RECOMMENDER_ENABLED) {
    return res.status(503).json({ error: 'Recommender runtime not available on this server.' });
  }

  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const genderPref = normalizeGenderPref(req.body?.gender_pref || req.body?.genderPref || 'any');
  const poolSizeRaw = req.body?.pool_size ?? req.body?.poolSize;
  const perRoleRaw = req.body?.per_role_limit ?? req.body?.perRoleLimit;
  const poolSize = Math.max(1, Number(poolSizeRaw || RECOMMENDER_POOL_SIZE) || RECOMMENDER_POOL_SIZE);
  const perRoleLimit = Math.max(1, Number(perRoleRaw || RECOMMENDER_PER_ROLE_LIMIT) || RECOMMENDER_PER_ROLE_LIMIT);
  const anchorEmbeddings = normalizeAnchorEmbeddingsPayload(req.body?.anchor_embeddings || req.body?.anchorEmbeddings);

  const debug = Boolean(req.body?.debug) || RECOMMENDER_DEBUG;
  const startedAt = Date.now();
  try {
    await requireUserFacingAiAccess(req);
    const response = await recommendWithRuntime({
      prompt,
      genderPref,
      poolSize,
      perRoleLimit,
      anchorEmbeddings,
      debug,
    });
    const formattedLooks = Array.isArray(response?.looks)
      ? response.looks
          .map((look, index) => ({
            rank: index + 1,
            score: look.score,
            symbolic: look.symbolic,
            semantic: look.semantic,
            selection: formatLook(look),
          }))
          .filter((entry) => Object.keys(entry.selection || {}).length > 0)
      : [];
    const repairedOutfits = repairRecommendationOutfits(
      formattedLooks.map((look) => look.selection),
      genderPref,
    );
    const sourceSlotPools = sortIntentAwareSlotPools(buildRecommendationSlotPools(
      Object.fromEntries(
        CATEGORY_KEYS.map((slot) => [
          slot,
          Array.isArray(response?.slot_pools?.[slot])
            ? response.slot_pools[slot].map((item) => formatRecommendationItem(item, slot)).filter(Boolean)
            : [],
        ]),
      ),
      repairedOutfits,
      genderPref,
    ), response?.intent, genderPref);
    const focusAwareOutfits = repairFocusSpecificOutfits(repairedOutfits, sourceSlotPools, response?.intent, genderPref);
    const brandAwareOutfits = repairBrandFitOutfits(focusAwareOutfits, sourceSlotPools, response?.intent, genderPref);
    const sportApparelAwareOutfits = repairSportSpecificApparel(brandAwareOutfits, sourceSlotPools, response?.intent, genderPref);
    const sportAwareOutfits = repairSportSpecificOutfits(sportApparelAwareOutfits, sourceSlotPools, response?.intent, genderPref);
    const teamAwareOutfits = repairTeamSpecificOutfits(sportAwareOutfits, sourceSlotPools, response?.intent, genderPref);
    const refinedApparelAwareOutfits = repairRefinedApparelOutfits(teamAwareOutfits, sourceSlotPools, response?.intent, genderPref);
    const refinedFootwearAwareOutfits = repairRefinedFootwearOutfits(refinedApparelAwareOutfits, sourceSlotPools, response?.intent, genderPref);
    let outfits = diversifyBroadPromptOutfits(
      refinedFootwearAwareOutfits.filter((entry) => Object.keys(entry).length > 0),
      sourceSlotPools,
      response?.intent,
      genderPref,
    );
    const fallbackOutfits = repairedOutfits.filter((entry) => Object.keys(entry).length > 0);
    const rawFormattedOutfits = formattedLooks
      .map((look) => look.selection)
      .filter((entry) => entry && Object.keys(entry).length > 0);
    if (!outfits.length && fallbackOutfits.length) {
      outfits = fallbackOutfits;
    } else if (!outfits.length && rawFormattedOutfits.length) {
      outfits = rawFormattedOutfits;
    }
    const slotPools = sortIntentAwareSlotPools(buildRecommendationSlotPools(
      Object.fromEntries(
        CATEGORY_KEYS.map((slot) => [
          slot,
          Array.isArray(response?.slot_pools?.[slot])
            ? response.slot_pools[slot].map((item) => formatRecommendationItem(item, slot)).filter(Boolean)
            : [],
        ]),
      ),
      outfits,
      genderPref,
    ), response?.intent, genderPref);
    outfits = synthesizeBroadPromptOutfitsFromPools(outfits, slotPools, response?.intent, genderPref);
    outfits = repairFocusSpecificOutfits(outfits, slotPools, response?.intent, genderPref);
    outfits = repairBrandFitOutfits(outfits, slotPools, response?.intent, genderPref)
      .filter((entry) => entry && Object.keys(entry).length > 0);
    outfits = repairSportSpecificApparel(outfits, slotPools, response?.intent, genderPref);
    outfits = repairSportSpecificOutfits(outfits, slotPools, response?.intent, genderPref);
    outfits = repairTeamSpecificOutfits(outfits, slotPools, response?.intent, genderPref);
    outfits = repairRefinedApparelOutfits(outfits, slotPools, response?.intent, genderPref);
    outfits = repairRefinedFootwearOutfits(outfits, slotPools, response?.intent, genderPref);
    outfits = enforceReturnedRefinedSelection(outfits, slotPools, response?.intent, genderPref)
      .filter((entry) => entry && Object.keys(entry).length > 0);
    outfits = enforceReturnedBrandCoverage(outfits, slotPools, response?.intent, genderPref)
      .filter((entry) => entry && Object.keys(entry).length > 0);
    outfits = finalizeBrandAwareLead(outfits, response?.intent);
    outfits = finalizeBroadPromptLead(outfits, response?.intent, slotPools, genderPref);
    const repairedLooks = formattedLooks
      .map((look, index) => ({ ...look, selection: outfits[index] || null }))
      .filter((look) => look.selection);
    if (!outfits.length) {
      throw new HttpError(502, 'Recommender runtime completed without emitting outfits.');
    }
    if (RECOMMENDER_TIMING_LOGS || debug) {
      console.log('[recommender][selection]', JSON.stringify({
        prompt,
        genderPref,
        selection: Object.fromEntries(
          Object.entries(outfits[0] || {}).map(([slot, item]) => [
            slot,
            item ? {
              id: item.id || null,
              title: item.meta?.title || item.meta?.name || null,
              gender: item.meta?.gender || null,
            } : null,
          ]),
        ),
        slotPools: Object.fromEntries(
          CATEGORY_KEYS.map((slot) => [
            slot,
            outfits
              .map((entry) => entry?.[slot] || null)
              .filter(Boolean)
              .slice(0, 5)
              .map((item) => ({
                id: item.id || null,
                title: item.meta?.title || item.meta?.name || null,
                gender: item.meta?.gender || null,
              })),
          ]),
        ),
      }));
    }
    return res.json({
      selection: outfits[0],
      top: slotPools.top || [],
      bottom: slotPools.bottom || [],
      mono: slotPools.mono || [],
      shoes: slotPools.shoes || [],
      outfits,
      intent: response.intent,
      diagnostics: response.diagnostics,
      looks: repairedLooks,
      meta: {
        poolSize,
        perRoleLimit,
        genderPref,
        parserMode: RECOMMENDER_PARSER_MODE,
        embeddingMode: RECOMMENDER_EMBEDDING_MODE,
        project: RECOMMENDER_PROJECT,
        location: RECOMMENDER_LOCATION,
        model: RECOMMENDER_MODEL,
        embeddingModel: RECOMMENDER_EMBEDDING_MODEL,
      },
    });
    if (RECOMMENDER_TIMING_LOGS || debug) {
      console.log('[recommender][timing]', JSON.stringify({
        stage: 'route_complete',
        total_ms: Date.now() - startedAt,
        prompt_length: prompt.length,
        pool_size: poolSize,
        per_role_limit: perRoleLimit,
        looks: Array.isArray(response?.looks) ? response.looks.length : 0,
      }));
    }
  } catch (err) {
    const status = err?.status || 500;
    console.error('[recommender]', err?.message || err);
    if (RECOMMENDER_TIMING_LOGS || debug) {
      console.log('[recommender][timing]', JSON.stringify({
        stage: 'route_error',
        total_ms: Date.now() - startedAt,
        prompt_length: prompt.length,
        pool_size: poolSize,
        per_role_limit: perRoleLimit,
        error: String(err?.message || err),
      }));
    }
    return res.status(status).json({
      error: err?.message || 'Unable to run recommender.',
      details: debug ? err?.details : undefined,
    });
  }
});

app.post('/embed-closet-item', async (req, res) => {
  if (!RECOMMENDER_ENABLED) {
    return res.status(503).json({ error: 'Recommender runtime not available on this server.' });
  }
  try {
    await requireUserFacingAiAccess(req);
    const item = req.body?.item && typeof req.body.item === 'object' ? req.body.item : null;
    if (!item) {
      throw new HttpError(400, 'item is required');
    }
    const runtime = await getRecommenderRuntime();
    const result = await runtime.embedClosetItem(item);
    return res.json(result);
  } catch (err) {
    const status = err?.status || 500;
    console.error('[embed-closet-item]', err?.message || err);
    return res.status(status).json({
      error: err?.message || 'Unable to embed closet item.',
      details: DEBUG ? err?.details : undefined,
    });
  }
});

app.post('/internal/recommendations/reindex-listing', async (req, res) => {
  try {
    assertIngestAuthorized(req);
    const listingId = String(req.body?.listingId || req.body?.listing_id || '').trim();
    if (!listingId) {
      throw new HttpError(400, 'listingId is required.');
    }
    const debug = Boolean(req.body?.debug) || RECOMMENDER_DEBUG;
    const runtime = await getRecommenderRuntime();
    const result = await runtime.reindexListing(listingId, {
      debug,
      classifyImage: ({ imageUrl, minColours }) =>
        classifyImagePayload({
          imageUrl,
          minColours,
        }),
    });
    return res.json(result);
  } catch (err) {
    const status = err?.status || 500;
    console.error('[reindex-listing]', err?.message || err);
    return res.status(status).json({
      error: err?.message || 'Unable to reindex listing.',
      details: DEBUG ? err?.details : undefined,
    });
  }
});

app.post('/reindex-my-listing', async (req, res) => {
  try {
    if (!RECOMMENDER_ENABLED) {
      throw new HttpError(503, 'Recommender runtime not available on this server.');
    }
    const { uid } = await requireBearerUser(req);
    const listingId = String(req.body?.listingId || req.body?.listing_id || '').trim();
    if (!listingId) {
      throw new HttpError(400, 'listingId is required.');
    }
    const runtime = await getRecommenderRuntime();
    const listingRef = runtime.db.collection('listings').doc(listingId);
    const listingSnap = await listingRef.get();
    if (!listingSnap.exists) {
      throw new HttpError(404, 'Listing not found.');
    }
    const listing = listingSnap.data() || {};
    if (String(listing.sellerUid || '').trim() !== uid) {
      throw new HttpError(403, 'You can only reindex your own listing.');
    }
    const result = await runtime.reindexListing(listingId, {
      debug: Boolean(req.body?.debug) || RECOMMENDER_DEBUG,
      classifyImage: ({ imageUrl, minColours }) =>
        classifyImagePayload({
          imageUrl,
          minColours,
        }),
    });
    return res.json(result);
  } catch (err) {
    const status = err?.status || 500;
    console.error('[reindex-my-listing]', err?.message || err);
    return res.status(status).json({
      error: err?.message || 'Unable to reindex listing.',
      details: DEBUG ? err?.details : undefined,
    });
  }
});

app.post('/internal/recommendations/backfill', async (req, res) => {
  try {
    assertIngestAuthorized(req);
    const limitRaw = req.body?.limit ?? req.body?.max ?? null;
    const limit = Number.isFinite(Number(limitRaw)) ? Math.max(1, Number(limitRaw)) : null;
    const debug = Boolean(req.body?.debug) || RECOMMENDER_DEBUG;
    const runtime = await getRecommenderRuntime();
    const result = await runtime.backfillActiveListings({
      limit,
      debug,
      classifyImage: ({ imageUrl, minColours }) =>
        classifyImagePayload({
          imageUrl,
          minColours,
        }),
    });
    return res.json(result);
  } catch (err) {
    const status = err?.status || 500;
    console.error('[recommendation-backfill]', err?.message || err);
    return res.status(status).json({
      error: err?.message || 'Unable to run recommendation backfill.',
      details: DEBUG ? err?.details : undefined,
    });
  }
});

app.post('/vision/search', async (req, res) => {
  const body = req.body || {};
  const query = body.query || body.q || '';
  const num = body.num ?? body.limit ?? body.count ?? VISION_WEB_DEFAULT_NUM;
  const safe = body.safe ?? body.safeMode ?? 'active';
  const { imageB64, imageUrl } = normalizeVisionImageInput(body);

  try {
    await requireUserFacingAiAccess(req);
    let payload;
    if (imageB64 || imageUrl) {
      payload = await searchVisionWebByImage({
        imageB64,
        imageUrl,
        query,
        num,
      });
    } else if (GOOGLE_SEARCH_API_KEY && GOOGLE_SEARCH_CX) {
      payload = await searchGoogleVisionWeb({ query, num, safe });
    } else {
      throw new HttpError(
        400,
        'Vision web search requires imageB64/imageUrl when custom search is not configured.'
      );
    }
    return res.json(payload);
  } catch (err) {
    const status = err?.status || 500;
    console.error('[vision-search]', err?.message || err);
    return res.status(status).json({
      error: err?.message || 'Unable to run vision web search.',
      details: DEBUG ? err?.details : undefined,
    });
  }
});

app.post('/tryon', async (req, res) => {
  let requester;
  let input;
  try {
    requester = await requireUserFacingAiAccess(req);
    input = sanitizeTryOnInput(req.body || {});
  } catch (err) {
    const status = err?.status || 400;
    return res.status(status).json({ error: err?.message || 'Invalid request' });
  }

  const asyncRequested = wantsAsync(req.body, req.query);
  if (asyncRequested) {
    const job = enqueueJob(input, requester?.uid || '');
    return res.status(202).json({
      jobId: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ttlMs: JOB_TTL_MS,
    });
  }

  try {
    const result = await executeTryOn(input);
    return res.json(result);
  } catch (err) {
    const status = err?.status || 500;
    console.error('[tryon] error:', err?.message || err);
    return res.status(status).json({ error: err?.message || 'Internal error' });
  }
});

app.get('/tryon/jobs/:jobId', async (req, res) => {
  try {
    const requester = await requireUserFacingAiAccess(req);
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.creatorUid && job.creatorUid !== requester.uid) {
      return res.status(403).json({ error: 'You are not allowed to view this job.' });
    }
    return res.json({
      jobId: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      result: job.status === 'succeeded' ? job.result : undefined,
      error: job.status === 'failed' ? job.error : undefined,
      httpStatus: job.httpStatus,
      ttlMs: JOB_TTL_MS,
    });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({ error: err?.message || 'Unable to load job.' });
  }
});

/* ───────────────────── lifecycle & start ───────────────────── */
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e);
});
process.on('SIGTERM', () => {
  logStructured('log', 'sigterm_received');
  process.exit(0);
});

app.listen(PORT, HOST, () => {
  logStructured('log', 'server_started', {
    host: HOST,
    port: PORT,
    project: PROJECT,
    location: LOCATION,
    model: MODEL,
  });
  if (IS_CLOUD_RUN && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    logStructured('warn', 'cloud_run_adc_override', {
      message:
        'GOOGLE_APPLICATION_CREDENTIALS is set on Cloud Run; it is not needed and should be removed.',
    });
  }
});
