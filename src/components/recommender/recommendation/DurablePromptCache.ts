import crypto from 'node:crypto';

type PromptParseCacheEntry = {
  payload: any;
  created_at: string;
  source: 'live';
  model: string;
  location: string;
  parser_mode: 'auto' | 'gemini';
  schema_version: number;
};

type PromptEmbeddingCacheEntry = {
  key: string;
  vector: number[];
  source: 'live';
  created_at: string;
};

const PROMPT_DURABLE_CACHE_ENABLED = (
  process.env.RECOMMENDER_DURABLE_PROMPT_CACHE ??
  process.env.RECOMMENDER_DURABLE_CACHE ??
  '0'
) !== '0';
const PAIRWISE_DURABLE_CACHE_ENABLED = (
  process.env.RECOMMENDER_DURABLE_PAIRWISE_CACHE ??
  process.env.RECOMMENDER_DURABLE_CACHE ??
  '1'
) !== '0';
const PARSE_CACHE_COLLECTION = String(
  process.env.RECOMMENDER_PARSE_CACHE_COLLECTION || 'recommenderPromptParseCache',
).trim();
const EMBEDDING_CACHE_COLLECTION = String(
  process.env.RECOMMENDER_EMBEDDING_CACHE_COLLECTION || 'recommenderPromptEmbeddingCache',
).trim();
const PAIRWISE_CACHE_COLLECTION = String(
  process.env.RECOMMENDER_PAIRWISE_CACHE_COLLECTION || 'recommenderPairwiseCache',
).trim();

let dbPromise: Promise<any | null> | null = null;
let warnedUnavailable = false;

function sha1(value: string) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function durableCacheActive(enabled: boolean) {
  return enabled && !!(
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT
  );
}

async function getDurableCacheDb(enabled: boolean) {
  if (!durableCacheActive(enabled)) return null;
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    try {
      const adminApp = await import('firebase-admin/app');
      const adminFirestore = await import('firebase-admin/firestore');
      const projectId = String(
        process.env.FIREBASE_PROJECT_ID ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT ||
        '',
      ).trim();

      let app = adminApp.getApps()[0];
      if (!app) {
        const inlineServiceAccount = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
        app = inlineServiceAccount
          ? adminApp.initializeApp({
              credential: adminApp.cert(JSON.parse(inlineServiceAccount)),
              projectId,
            })
          : adminApp.initializeApp({
              credential: adminApp.applicationDefault(),
              projectId,
            });
      }
      return adminFirestore.getFirestore(app);
    } catch (error) {
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        console.warn('[recommender][cache] durable cache unavailable', String((error as Error)?.message || error));
      }
      return null;
    }
  })();
  return dbPromise;
}

export async function loadDurablePromptParse(key: string): Promise<PromptParseCacheEntry | null> {
  const db = await getDurableCacheDb(PROMPT_DURABLE_CACHE_ENABLED);
  if (!db) return null;
  try {
    const snap = await db.collection(PARSE_CACHE_COLLECTION).doc(sha1(key)).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    if (String(data.key || '') !== key || !data.payload) return null;
    return {
      payload: data.payload,
      created_at: String(data.created_at || new Date().toISOString()),
      source: 'live',
      model: String(data.model || ''),
      location: String(data.location || ''),
      parser_mode: data.parser_mode === 'gemini' ? 'gemini' : 'auto',
      schema_version: Number(data.schema_version || 1) || 1,
    };
  } catch {
    return null;
  }
}

export async function persistDurablePromptParse(key: string, entry: PromptParseCacheEntry): Promise<void> {
  const db = await getDurableCacheDb(PROMPT_DURABLE_CACHE_ENABLED);
  if (!db) return;
  await db.collection(PARSE_CACHE_COLLECTION).doc(sha1(key)).set({
    key,
    ...entry,
    updated_at: new Date().toISOString(),
  }, { merge: true });
}

export async function loadDurablePromptEmbeddings(keys: string[]): Promise<Map<string, PromptEmbeddingCacheEntry>> {
  const out = new Map<string, PromptEmbeddingCacheEntry>();
  const uniqKeys = Array.from(new Set(keys.map((key) => String(key || '').trim()).filter(Boolean)));
  if (!uniqKeys.length) return out;
  const db = await getDurableCacheDb(PROMPT_DURABLE_CACHE_ENABLED);
  if (!db) return out;
  try {
    const refs = uniqKeys.map((key) => db.collection(EMBEDDING_CACHE_COLLECTION).doc(sha1(key)));
    const snaps = await Promise.all(refs.map((ref) => ref.get()));
    snaps.forEach((snap) => {
      if (!snap.exists) return;
      const data = snap.data() || {};
      const key = String(data.key || '').trim();
      const vector = Array.isArray(data.vector)
        ? data.vector.map((value: any) => Number(value)).filter((value: number) => Number.isFinite(value))
        : [];
      if (!key || !vector.length) return;
      out.set(key, {
        key,
        vector,
        source: 'live',
        created_at: String(data.created_at || new Date().toISOString()),
      });
    });
  } catch {
    return out;
  }
  return out;
}

export async function persistDurablePromptEmbedding(key: string, vector: number[]): Promise<void> {
  const db = await getDurableCacheDb(PROMPT_DURABLE_CACHE_ENABLED);
  if (!db || !vector.length) return;
  await db.collection(EMBEDDING_CACHE_COLLECTION).doc(sha1(key)).set({
    key,
    vector,
    source: 'live',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { merge: true });
}

export async function loadDurablePairwiseScores(keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniqKeys = Array.from(new Set(keys.map((key) => String(key || '').trim()).filter(Boolean)));
  if (!uniqKeys.length) return out;
  const db = await getDurableCacheDb(PAIRWISE_DURABLE_CACHE_ENABLED);
  if (!db) return out;
  try {
    const refs = uniqKeys.map((key) => db.collection(PAIRWISE_CACHE_COLLECTION).doc(sha1(key)));
    const snaps = await Promise.all(refs.map((ref) => ref.get()));
    snaps.forEach((snap) => {
      if (!snap.exists) return;
      const data = snap.data() || {};
      const key = String(data.key || '').trim();
      const value = Number(data.value);
      if (!key || !Number.isFinite(value)) return;
      out.set(key, value);
    });
  } catch {
    return out;
  }
  return out;
}

export async function persistDurablePairwiseScores(entries: Array<{ key: string; value: number }>): Promise<void> {
  if (!entries.length) return;
  const db = await getDurableCacheDb(PAIRWISE_DURABLE_CACHE_ENABLED);
  if (!db) return;
  const now = new Date().toISOString();
  const uniqEntries = Array.from(new Map(
    entries
      .filter((entry) => String(entry?.key || '').trim() && Number.isFinite(Number(entry?.value)))
      .map((entry) => [String(entry.key).trim(), Number(entry.value)]),
  ).entries());

  for (let index = 0; index < uniqEntries.length; index += 400) {
    const batch = db.batch();
    for (const [key, value] of uniqEntries.slice(index, index + 400)) {
      const ref = db.collection(PAIRWISE_CACHE_COLLECTION).doc(sha1(key));
      batch.set(ref, {
        key,
        value,
        source: 'live',
        updated_at: now,
      }, { merge: true });
    }
    await batch.commit();
  }
}
