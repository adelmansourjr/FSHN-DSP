import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RecommendationService } from './reccomender/recommendation/index.ts';
import {
  CatalogRepository as BaseCatalogRepository,
  precomputeItemFeatures,
} from './reccomender/og_recommendation/RecommendationService.ts';
import { buildSemanticCorpusStats, normalizeIndexItem } from './reccomender/canonical_index.ts';
import {
  normalizeOccasionTags,
  normalizeText,
  normalizeVibes,
  toFit,
} from './reccomender/fashion_taxonomy.ts';
import { createGoogleGenAIClient, embedTexts } from './reccomender/semantic_embeddings.ts';
import { buildItemSemanticBundle } from './reccomender/style_semantics.ts';
import { getAdminDb, getFirebaseAdminConfig } from './firebase-admin.mjs';

const LISTING_EMBEDDINGS_COLLECTION = 'listingEmbeddings';
const LIVE_CORPUS_STATE_DOC = 'recommenderState/liveCorpus';
const CATEGORY_DISPLAY = {
  top: 'Top',
  bottom: 'Bottom',
  mono: 'Dress',
  shoes: 'Shoes',
};
const DEFAULT_LIVE_REFRESH_TTL_MS = Math.max(
  15_000,
  Number(process.env.RECOMMENDER_LIVE_REFRESH_TTL_MS || 120_000) || 120_000,
);
const TIMING_LOGS_ENABLED = (process.env.RECOMMENDER_TIMING_LOGS || '0') === '1';
const LIVE_EMBEDDING_SCHEMA_VERSION = 1;
const LIVE_VERSION_CHECK_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.RECOMMENDER_LIVE_VERSION_CHECK_INTERVAL_MS || 10_000) || 10_000,
);
const FARFETCH_RUNTIME_OVERRIDES = {
  '20044319.jpg': {
    gender: 'women',
    blockFor: ['men'],
    removeEntityPatterns: ['men s', 'mens', 'men s shirt', 'mensshirt', 'men s style', 'mensstyle'],
  },
  '33195925.jpg': {
    gender: 'women',
    blockFor: ['men'],
  },
  '33241279.jpg': {
    gender: 'women',
    blockFor: ['men'],
  },
  '34569304.jpg': {
    gender: 'women',
    blockFor: ['men'],
    removeEntityPatterns: ['men s', 'mens', 'men s shirt', 'mensshirt', 'men s style', 'mensstyle'],
  },
};

function nowIso() {
  return new Date().toISOString();
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function uniqueStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function normalizeListingGender(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'unisex';
  if (/\bunisex\b/.test(raw) || /\bgender[\s-]?neutral\b/.test(raw) || /\ball genders?\b/.test(raw)) return 'unisex';
  if (/\bwomen'?s?\b/.test(raw) || /\bfemale\b/.test(raw) || /\blad(?:y|ies)\b/.test(raw) || /\bgirls?\b/.test(raw)) return 'women';
  if (/\bmen'?s?\b/.test(raw) || /\bmale\b/.test(raw) || /\bboys?\b/.test(raw)) return 'men';
  return 'unisex';
}

function extractListingImageUrl(listing = {}) {
  const photos = safeArray(listing.photos);
  const firstPhoto = photos[0];
  return (
    String(listing?.primeImage?.url || '').trim() ||
    String(firstPhoto?.url || firstPhoto || '').trim() ||
    ''
  );
}

function inferCategoryFromListing(listing = {}) {
  const directRole = normalizeText(listing.role || '');
  if (directRole === 'top' || directRole === 'bottom' || directRole === 'mono' || directRole === 'shoes') return directRole;

  const fields = [
    String(listing.category || ''),
    String(listing.sub || ''),
    String(listing.title || ''),
    String(listing.description || ''),
    safeArray(listing.tags).join(' '),
    safeArray(listing.vibes).join(' '),
  ];
  const text = normalizeText(fields.join(' '));
  if (!text) return null;

  const has = (pattern) => pattern.test(text);

  if (has(/\b(dress|gown|jumpsuit|romper|one piece|one-piece|playsuit)\b/)) return 'mono';
  if (has(/\b(shoe|shoes|sneaker|sneakers|trainer|trainers|boot|boots|loafer|loafers|heel|heels|oxford|oxfords|derby|derbies|sandal|sandals|mule|mules|slipper|slippers)\b/)) return 'shoes';
  if (has(/\b(pant|pants|trouser|trousers|jean|jeans|denim|cargo|cargos|jogger|joggers|legging|leggings|short|shorts|chino|chinos|slack|slacks|skirt|skirts)\b/)) return 'bottom';
  if (has(/\b(shirt|shirts|tee|tees|t shirt|t-shirt|tshirt|polo|polos|hoodie|hoodies|sweater|sweaters|jumper|jumpers|cardigan|cardigans|blazer|blazers|jacket|jackets|coat|coats|coatigan|vest|waistcoat|top|tops|outerwear|overshirt|overshirts)\b/)) return 'top';

  const category = normalizeText(listing.category || '');
  if (category === 'outerwear') return 'top';
  return null;
}

function classifierPayloadToCanonicalRaw(listingId, listing = {}, classification = {}) {
  const raw = classification?.raw || {};
  const category = normalizeText(raw.category || '') || inferCategoryFromListing(listing);
  const imagePath = extractListingImageUrl(listing);
  if (!category || !imagePath) return null;

  return {
    id: `listing:${listingId}`,
    imagePath,
    category,
    sub: raw.sub || listing.sub || category,
    colours: uniqueStrings(raw.colours || listing.colors || []),
    vibes: normalizeVibes(raw.vibes || listing.vibes || []),
    gender: normalizeListingGender(raw.gender || listing.gender),
    fit: toFit(raw.fit || listing.fit || '') || null,
    sportMeta: raw.sportMeta || listing.sportMeta || null,
    name: String(listing.title || raw.name || listingId).trim(),
    name_normalized: normalizeText(listing.title || raw.name || listingId),
    entities: uniqueStrings(raw.entities || listing.entities || []),
    entityMeta: safeArray(raw.entityMeta || listing.entityMeta || []),
    occasion_tags: normalizeOccasionTags(raw.occasion_tags || listing.occasionTags || []),
    style_markers: uniqueStrings(raw.style_markers || listing.styleMarkers || []),
    formality_score: numberOrNull(raw.formality_score ?? listing.formalityScore),
    streetwear_score: numberOrNull(raw.streetwear_score ?? listing.streetwearScore),
    cleanliness_score: numberOrNull(raw.cleanliness_score ?? listing.cleanlinessScore),
    confidence: raw.confidence || listing.classifierConfidence || null,
  };
}

function listingDocToCanonicalItem(listingId, listing = {}, embeddingDoc = null) {
  const embeddedItem = embeddingDoc?.item && typeof embeddingDoc.item === 'object'
    ? embeddingDoc.item
    : null;
  const mergedRaw = {
    category: normalizeText(listing.role || listing.category || '') || '',
    sub: listing.sub || embeddedItem?.sub || '',
    colours: safeArray(listing.colors).length ? safeArray(listing.colors) : safeArray(embeddedItem?.colours),
    vibes: safeArray(listing.vibes).length ? safeArray(listing.vibes) : safeArray(embeddedItem?.vibes),
    gender: listing.gender || embeddedItem?.gender || '',
    fit: listing.fit || embeddedItem?.fit || '',
    sportMeta: listing.sportMeta || embeddedItem?.sportMeta || null,
    name: String(listing.title || embeddedItem?.name || listingId).trim(),
    entities: safeArray(listing.entities).length ? safeArray(listing.entities) : safeArray(embeddedItem?.entities),
    entityMeta: safeArray(listing.entityMeta).length ? safeArray(listing.entityMeta) : safeArray(embeddedItem?.entityMeta),
    occasion_tags: safeArray(listing.occasionTags).length ? safeArray(listing.occasionTags) : safeArray(embeddedItem?.occasion_tags),
    style_markers: safeArray(listing.styleMarkers).length ? safeArray(listing.styleMarkers) : safeArray(embeddedItem?.style_markers),
    formality_score: numberOrNull(listing.formalityScore ?? embeddedItem?.formality_score),
    streetwear_score: numberOrNull(listing.streetwearScore ?? embeddedItem?.streetwear_score),
    cleanliness_score: numberOrNull(listing.cleanlinessScore ?? embeddedItem?.cleanliness_score),
    confidence: listing.classifierConfidence || embeddedItem?.confidence || null,
  };
  const raw = classifierPayloadToCanonicalRaw(listingId, listing, { raw: mergedRaw });
  if (!raw) return null;
  return normalizeIndexItem(raw, '/tmp/live-listings.index.json');
}

function defaultFarfetchImageUrl(fileName) {
  const config = getFirebaseAdminConfig();
  const bucket =
    String(process.env.FARFETCH_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || config.storageBucket || '').trim();
  if (!bucket || !fileName) return '';
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(`catalog/farfetch/${fileName}`)}?alt=media`;
}

function resolveFarfetchImagePath(rawPath) {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return trimmed;
  if (/^(https?:)?\/\//i.test(trimmed) || /^gs:\/\//i.test(trimmed)) return trimmed;

  const fileName = path.basename(trimmed);
  if (!fileName) return trimmed;

  return `images farfetch/${fileName}`;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch {
    return fallback;
  }
}

function applyFarfetchRuntimeOverrides(item) {
  if (!item || typeof item !== 'object') return item;
  const rawId = String(item.id || '').trim();
  const override = FARFETCH_RUNTIME_OVERRIDES[rawId];
  if (!override) return item;

  const removePatterns = safeArray(override.removeEntityPatterns).map((entry) => normalizeText(entry));
  const filteredEntities = safeArray(item.entities).filter((entry) => {
    const norm = normalizeText(entry);
    return norm && !removePatterns.includes(norm);
  });
  const filteredEntityMeta = safeArray(item.entityMeta).filter((entry) => {
    const norm = normalizeText(entry?.text || '');
    return norm && !removePatterns.includes(norm);
  });

  return {
    ...item,
    gender: override.gender || item.gender,
    entities: filteredEntities.length ? filteredEntities : item.entities,
    entityMeta: filteredEntityMeta.length ? filteredEntityMeta : item.entityMeta,
    runtimeBlockFor: safeArray(override.blockFor),
  };
}

function namespaceSeedItems(items, prefix, imageResolver = null) {
  return safeArray(items)
    .map((item) => {
      const patched = prefix === 'seed:farfetch' ? applyFarfetchRuntimeOverrides(item) : item;
      const rawId = String(patched?.id || '').trim();
      if (!rawId) return null;
      return {
        ...patched,
        id: `${prefix}:${rawId}`,
        imagePath: imageResolver ? imageResolver(patched.imagePath) : patched.imagePath,
      };
    })
    .filter(Boolean);
}

function namespaceSidecar(sidecar, prefix, imageResolver = null) {
  const items = {};
  for (const entry of Object.values(sidecar?.items || {})) {
    const patched = prefix === 'seed:farfetch' ? applyFarfetchRuntimeOverrides(entry) : entry;
    const rawId = String(patched?.id || '').trim();
    if (!rawId) continue;
    const namespacedId = `${prefix}:${rawId}`;
    items[namespacedId] = {
      ...patched,
      id: namespacedId,
      imagePath: imageResolver ? imageResolver(patched.imagePath) : patched.imagePath,
    };
  }
  return {
    model: sidecar?.model || null,
    dimensions: Number.isFinite(sidecar?.dimensions) ? Number(sidecar.dimensions) : null,
    created_at: sidecar?.created_at || null,
    task_type: sidecar?.task_type || null,
    schema_version: Number.isFinite(sidecar?.schema_version) ? Number(sidecar.schema_version) : null,
    items,
  };
}

function emptyLoadedEmbeddings(meta = {}) {
  return {
    sidecar: {
      model: meta.model || null,
      dimensions: meta.dimensions || null,
      created_at: meta.createdAt || null,
      task_type: meta.taskType || null,
      schema_version: meta.schemaVersion || null,
      items: {},
    },
    sidecarPath: meta.sidecarPath || 'composite',
    model: meta.model || null,
    dimensions: meta.dimensions || null,
    createdAt: meta.createdAt || null,
    schemaVersion: meta.schemaVersion || null,
    taskType: meta.taskType || null,
    itemVectors: new Map(),
    identityVectors: new Map(),
    styleVectors: new Map(),
    slotVectors: { top: new Map(), bottom: new Map(), shoes: new Map(), mono: new Map() },
    slotIdentityVectors: { top: new Map(), bottom: new Map(), shoes: new Map(), mono: new Map() },
    slotStyleVectors: { top: new Map(), bottom: new Map(), shoes: new Map(), mono: new Map() },
  };
}

function applyEmbeddingEntry(loaded, entry) {
  if (!entry?.id) return;
  if (safeArray(entry.vector).length) loaded.itemVectors.set(entry.id, entry.vector);
  if (safeArray(entry.identity_vector).length) loaded.identityVectors.set(entry.id, entry.identity_vector);
  if (safeArray(entry.style_vector).length) loaded.styleVectors.set(entry.id, entry.style_vector);
  for (const slot of ['top', 'bottom', 'shoes', 'mono']) {
    if (safeArray(entry.slot_vectors?.[slot]).length) loaded.slotVectors[slot].set(entry.id, entry.slot_vectors[slot]);
    if (safeArray(entry.slot_identity_vectors?.[slot]).length) loaded.slotIdentityVectors[slot].set(entry.id, entry.slot_identity_vectors[slot]);
    if (safeArray(entry.slot_style_vectors?.[slot]).length) loaded.slotStyleVectors[slot].set(entry.id, entry.slot_style_vectors[slot]);
  }
}

function buildLoadedEmbeddingsFromEntries(entries, meta = {}) {
  const loaded = emptyLoadedEmbeddings(meta);
  for (const entry of entries.values()) applyEmbeddingEntry(loaded, entry);
  return loaded;
}

function buildEmbeddingDoc(item, contentHash, embeddingModel, bundle, vectors) {
  const slot = item.category;
  const entry = {
    id: item.id,
    text: bundle.general,
    vector: vectors.general,
    identity_text: bundle.identity,
    identity_vector: vectors.identity,
    style_text: bundle.style,
    style_vector: vectors.style,
    slot_texts: slot ? { [slot]: bundle.slots?.[slot] || bundle.general } : {},
    slot_vectors: slot && vectors.slot ? { [slot]: vectors.slot } : {},
    slot_identity_texts: slot && bundle.slot_identity?.[slot] ? { [slot]: bundle.slot_identity[slot] } : {},
    slot_identity_vectors: slot && vectors.slotIdentity ? { [slot]: vectors.slotIdentity } : {},
    slot_style_texts: slot && bundle.slot_style?.[slot] ? { [slot]: bundle.slot_style[slot] } : {},
    slot_style_vectors: slot && vectors.slotStyle ? { [slot]: vectors.slotStyle } : {},
  };

  return {
    listingId: item.id.replace(/^listing:/, ''),
    itemId: item.id,
    item,
    contentHash,
    model: embeddingModel,
    dimensions: safeArray(vectors.general).length || null,
    taskType: 'RETRIEVAL_DOCUMENT',
    schemaVersion: LIVE_EMBEDDING_SCHEMA_VERSION,
    updatedAt: nowIso(),
    ...entry,
  };
}

function buildListingSemanticBundle(item, items) {
  return buildItemSemanticBundle(item, {
    corpus: buildSemanticCorpusStats(items),
  });
}

function normalizeClosetCategory(value) {
  const raw = normalizeText(String(value || ''));
  if (!raw) return null;
  if (raw.includes('top')) return 'top';
  if (raw.includes('bottom')) return 'bottom';
  if (raw.includes('mono') || raw.includes('dress')) return 'mono';
  if (
    raw.includes('shoe') ||
    raw.includes('footwear') ||
    raw.includes('sneaker') ||
    raw.includes('boot') ||
    raw.includes('heel')
  ) return 'shoes';
  return null;
}

function closetDraftToSemanticItem(raw = {}) {
  const category = normalizeClosetCategory(raw.category);
  if (!category) return null;
  const brand = String(raw.brand || '').trim();
  const tags = uniqueStrings(safeArray(raw.tags).map((entry) => String(entry || '').trim()));
  const colour = String(raw.color || '').trim();
  const id = String(raw.id || '').trim() || `closet-${sha1(JSON.stringify([category, brand, colour, tags])).slice(0, 12)}`;
  const styleMarkers = tags.filter((entry) => normalizeText(entry) !== normalizeText(brand));
  return {
    id: `closet:${id}`,
    imagePath: `closet://${id}`,
    category,
    sub: null,
    colours: colour ? [colour] : [],
    vibes: normalizeVibes(tags),
    gender: normalizeListingGender(raw.gender || ''),
    fit: toFit(raw.fit || '') || null,
    sportMeta: null,
    name: brand ? `${brand} ${CATEGORY_DISPLAY[category] || category}` : `${CATEGORY_DISPLAY[category] || category} closet item`,
    name_normalized: normalizeText(brand ? `${brand} ${CATEGORY_DISPLAY[category] || category}` : `${CATEGORY_DISPLAY[category] || category} closet item`),
    entities: brand ? [brand] : [],
    entityMeta: brand ? [{ text: brand, weight: 1, type: 'brand' }] : [],
    occasion_tags: normalizeOccasionTags(tags),
    style_markers: styleMarkers,
    formality_score: null,
    streetwear_score: null,
    cleanliness_score: null,
    confidence: null,
  };
}

class CloudCatalogRepository {
  constructor(runtime) {
    this.runtime = runtime;
    this.baseRepository = new BaseCatalogRepository();
  }

  prepareRequest(seed) {
    this.baseRepository.prepareRequest(seed);
  }

  ensureCredentials(debug) {
    this.baseRepository.ensureCredentials(debug);
  }

  resolveProject(override) {
    return this.baseRepository.resolveProject(override);
  }

  loadIndex() {
    return this.runtime.getItems();
  }

  buildCorpusStats(items) {
    return this.runtime.getCorpusStats(items);
  }

  loadEmbeddings() {
    return this.runtime.getEmbeddings();
  }
}

export class RecommenderRuntime {
  constructor(options = {}) {
    this.options = options;
    this.service = new RecommendationService(
      undefined,
      new CloudCatalogRepository(this),
    );
    this.db = getAdminDb();
    this.staticItems = [];
    this.staticEmbeddingEntries = new Map();
    this.liveItems = new Map();
    this.liveEmbeddingEntries = new Map();
    this.combinedItems = [];
    this.combinedEmbeddings = emptyLoadedEmbeddings();
    this.combinedCorpusStats = buildSemanticCorpusStats([]);
    this.staticReady = false;
    this.liveReady = false;
    this.lastLiveRefreshAt = 0;
    this.lastVersionCheckAt = 0;
    this.liveCorpusVersion = null;
    this.checkedLiveCorpusVersion = null;
    this.readyPromise = this.initialize();
  }

  async initialize() {
    try {
      this.loadStaticCorpus();
      await this.refreshLiveOverlay(true);
    } catch (error) {
      this.readyPromise = null;
      throw error;
    }
  }

  loadStaticCorpus() {
    if (this.staticReady) return;
    const originalItems = namespaceSeedItems(readJson(this.options.originalIndexPath, []), 'seed:original');
    const farfetchItems = namespaceSeedItems(
      readJson(this.options.farfetchIndexPath, []),
      'seed:farfetch',
      resolveFarfetchImagePath,
    );
    this.staticItems = [...originalItems, ...farfetchItems];

    const originalSidecar = namespaceSidecar(readJson(this.options.originalEmbeddingPath, { items: {} }), 'seed:original');
    const farfetchSidecar = namespaceSidecar(
      readJson(this.options.farfetchEmbeddingPath, { items: {} }),
      'seed:farfetch',
      resolveFarfetchImagePath,
    );
    this.staticEmbeddingEntries = new Map([
      ...Object.values(originalSidecar.items || {}).map((entry) => [entry.id, entry]),
      ...Object.values(farfetchSidecar.items || {}).map((entry) => [entry.id, entry]),
    ]);
    precomputeItemFeatures(this.staticItems);

    this.staticReady = true;
    this.rebuildCompositeCache();
  }

  rebuildCompositeCache() {
    this.combinedItems = [...this.staticItems, ...this.liveItems.values()];
    precomputeItemFeatures(this.combinedItems);
    this.combinedCorpusStats = buildSemanticCorpusStats(this.combinedItems);
    this.combinedEmbeddings = buildLoadedEmbeddingsFromEntries(
      new Map([...this.staticEmbeddingEntries, ...this.liveEmbeddingEntries]),
      {
        sidecarPath: 'composite',
        model: String(process.env.RECOMMENDER_EMBEDDING_MODEL || 'gemini-embedding-001'),
        taskType: 'RETRIEVAL_DOCUMENT',
        schemaVersion: LIVE_EMBEDDING_SCHEMA_VERSION,
        createdAt: nowIso(),
      },
    );
  }

  async readLiveCorpusVersion(force = false) {
    const now = Date.now();
    if (!force && this.lastVersionCheckAt && now - this.lastVersionCheckAt < LIVE_VERSION_CHECK_INTERVAL_MS) {
      return this.checkedLiveCorpusVersion;
    }
    this.lastVersionCheckAt = now;
    try {
      const snapshot = await this.db.doc(LIVE_CORPUS_STATE_DOC).get();
      const data = snapshot.exists ? (snapshot.data() || {}) : {};
      this.checkedLiveCorpusVersion = String(data.version || '').trim() || null;
    } catch {
      if (force) throw new Error('live_corpus_version_check_failed');
    }
    return this.checkedLiveCorpusVersion;
  }

  async bumpLiveCorpusVersion() {
    const version = crypto.randomUUID();
    await this.db.doc(LIVE_CORPUS_STATE_DOC).set(
      {
        version,
        updatedAt: nowIso(),
      },
      { merge: true },
    );
    return version;
  }

  async refreshLiveOverlay(force = false) {
    const ttlMs = Math.max(15_000, Number(this.options.liveRefreshTtlMs || DEFAULT_LIVE_REFRESH_TTL_MS));
    const now = Date.now();
    const ttlExpired = force || !this.liveReady || now - this.lastLiveRefreshAt >= ttlMs;
    const observedVersion = await this.readLiveCorpusVersion(force).catch(() => null);
    const versionChanged = !!(this.liveReady && observedVersion && observedVersion !== this.liveCorpusVersion);
    if (!ttlExpired && !versionChanged) return;

    const [listingsSnap, embeddingsSnap] = await Promise.all([
      this.db.collection('listings').where('status', '==', 'active').get(),
      this.db.collection(LISTING_EMBEDDINGS_COLLECTION).get(),
    ]);

    const embeddingDocs = new Map();
    embeddingsSnap.forEach((doc) => {
      embeddingDocs.set(doc.id, doc.data() || {});
    });

    this.liveItems = new Map();
    this.liveEmbeddingEntries = new Map();

    listingsSnap.forEach((doc) => {
      const listingId = doc.id;
      const listing = doc.data() || {};
      const embeddingDoc = embeddingDocs.get(listingId) || null;
      const item = listingDocToCanonicalItem(listingId, listing, embeddingDoc);
      if (!item) return;
      this.liveItems.set(listingId, item);
      if (embeddingDoc?.itemId) {
        this.liveEmbeddingEntries.set(item.id, {
          id: embeddingDoc.itemId,
          text: embeddingDoc.text || '',
          vector: safeArray(embeddingDoc.vector),
          identity_text: embeddingDoc.identity_text || '',
          identity_vector: safeArray(embeddingDoc.identity_vector),
          style_text: embeddingDoc.style_text || '',
          style_vector: safeArray(embeddingDoc.style_vector),
          slot_texts: embeddingDoc.slot_texts || {},
          slot_vectors: embeddingDoc.slot_vectors || {},
          slot_identity_texts: embeddingDoc.slot_identity_texts || {},
          slot_identity_vectors: embeddingDoc.slot_identity_vectors || {},
          slot_style_texts: embeddingDoc.slot_style_texts || {},
          slot_style_vectors: embeddingDoc.slot_style_vectors || {},
        });
      }
    });
    precomputeItemFeatures(Array.from(this.liveItems.values()));

    this.liveReady = true;
    this.lastLiveRefreshAt = now;
    this.liveCorpusVersion = observedVersion || this.liveCorpusVersion || null;
    this.rebuildCompositeCache();
  }

  async ensureReady() {
    this.readyPromise ||= this.initialize();
    await this.readyPromise;
    await this.refreshLiveOverlay(false);
  }

  getItems() {
    return this.combinedItems;
  }

  getEmbeddings() {
    return this.combinedEmbeddings;
  }

  getCorpusStats() {
    return this.combinedCorpusStats;
  }

  async recommend(request) {
    const startedAt = Date.now();
    await this.ensureReady();
    if (TIMING_LOGS_ENABLED || request?.debug) {
      console.log('[recommender][timing]', JSON.stringify({
        stage: 'runtime_ready',
        ensure_ready_ms: Date.now() - startedAt,
        live_items: this.liveItems.size,
        static_items: this.staticItems.length,
        combined_items: this.combinedItems.length,
      }));
    }
    return this.service.recommend(request);
  }

  async buildListingEmbeddingDoc(item, embeddingModel) {
    const project =
      String(
        process.env.RECOMMENDER_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT ||
        '',
      ).trim();
    const location = String(process.env.RECOMMENDER_LOCATION || process.env.RECOMMENDER_GEMINI_LOCATION || 'global').trim();
    if (!project) {
      throw new Error('Missing recommender project for live embedding generation.');
    }

    const bundle = buildListingSemanticBundle(
      item,
      [...this.getItems().filter((entry) => entry?.id !== item.id), item],
    );
    const contentHash = sha1(
      JSON.stringify({
        item,
        bundle,
        embeddingModel,
      }),
    );
    return this.buildListingEmbeddingDocFromBundle(item, embeddingModel, bundle, contentHash, project, location);
  }

  async embedClosetItem(input = {}) {
    await this.ensureReady();
    const item = closetDraftToSemanticItem(input);
    if (!item) {
      throw new Error('Closet item category is required for embedding.');
    }
    const embeddingModel = String(process.env.RECOMMENDER_EMBEDDING_MODEL || 'gemini-embedding-001').trim();
    const bundle = buildListingSemanticBundle(
      item,
      [...this.getItems(), item],
    );
    const project =
      String(
        process.env.RECOMMENDER_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT ||
        '',
      ).trim();
    const location = String(process.env.RECOMMENDER_LOCATION || process.env.RECOMMENDER_GEMINI_LOCATION || 'global').trim();
    const contentHash = sha1(
      JSON.stringify({
        item,
        bundle,
        embeddingModel,
      }),
    );
    const embeddingDoc = await this.buildListingEmbeddingDocFromBundle(item, embeddingModel, bundle, contentHash, project, location);
    return {
      ok: true,
      embedding: {
        model: embeddingModel,
        slot: item.category,
        text: bundle.general,
        vector: safeArray(embeddingDoc.vector),
      },
    };
  }

  async buildListingEmbeddingDocFromBundle(item, embeddingModel, bundle, contentHash, project, location) {
    const refs = [
      bundle.general,
      bundle.identity,
      bundle.style,
      bundle.slots?.[item.category] || bundle.general,
      bundle.slot_identity?.[item.category] || bundle.identity,
      bundle.slot_style?.[item.category] || bundle.style,
    ];
    const ai = createGoogleGenAIClient(project, location);
    const [
      general = [],
      identity = [],
      style = [],
      slot = [],
      slotIdentity = [],
      slotStyle = [],
    ] = await embedTexts(ai, embeddingModel, refs, 'RETRIEVAL_DOCUMENT');

    return buildEmbeddingDoc(item, contentHash, embeddingModel, bundle, {
      general,
      identity,
      style,
      slot,
      slotIdentity,
      slotStyle,
    });
  }

  async reindexListing(listingId, { classifyImage, debug = false } = {}) {
    await this.ensureReady();
    const listingRef = this.db.collection('listings').doc(String(listingId || '').trim());
    const listingSnap = await listingRef.get();
    if (!listingSnap.exists) {
      await this.db.collection(LISTING_EMBEDDINGS_COLLECTION).doc(String(listingId || '').trim()).delete().catch(() => {});
      await this.bumpLiveCorpusVersion();
      this.lastVersionCheckAt = 0;
      return { ok: false, listingId, status: 'missing' };
    }

    const listing = listingSnap.data() || {};
    if (String(listing.status || '').trim().toLowerCase() !== 'active') {
      await this.db.collection(LISTING_EMBEDDINGS_COLLECTION).doc(listingId).delete().catch(() => {});
      await this.bumpLiveCorpusVersion();
      this.lastVersionCheckAt = 0;
      return { ok: true, listingId, status: 'removed_from_corpus' };
    }

    const imageUrl = extractListingImageUrl(listing);
    if (!imageUrl) {
      return { ok: false, listingId, status: 'missing_image' };
    }

    const classification = await classifyImage({
      imageUrl,
      minColours: 1,
    });
    const raw = classifierPayloadToCanonicalRaw(listingId, listing, classification);
    if (!raw) {
      return { ok: false, listingId, status: 'unsupported_category' };
    }

    const item = normalizeIndexItem(raw, '/tmp/live-listings.index.json');
    if (!item) {
      return { ok: false, listingId, status: 'normalize_failed' };
    }

    const embeddingModel = String(process.env.RECOMMENDER_EMBEDDING_MODEL || 'gemini-embedding-001').trim();
    const existingEmbeddingSnap = await this.db.collection(LISTING_EMBEDDINGS_COLLECTION).doc(listingId).get();
    const existingEmbeddingDoc = existingEmbeddingSnap.exists ? (existingEmbeddingSnap.data() || {}) : null;
    const bundle = buildListingSemanticBundle(
      item,
      [...this.getItems().filter((entry) => entry?.id !== item.id), item],
    );
    const contentHash = sha1(
      JSON.stringify({
        item,
        bundle,
        embeddingModel,
      }),
    );
    const sameHash = existingEmbeddingDoc?.contentHash && existingEmbeddingDoc.contentHash === contentHash;
    const embeddingDoc = sameHash ? {
      ...existingEmbeddingDoc,
      item,
      itemId: item.id,
      updatedAt: nowIso(),
    } : await this.buildListingEmbeddingDoc(item, embeddingModel);

    const mutationId = crypto.randomUUID();
    const listingPatch = {
      category: CATEGORY_DISPLAY[item.category] || String(listing.category || '').trim() || '',
      role: item.category,
      gender: item.gender || listing.gender || 'unisex',
      colors: uniqueStrings(item.colours || listing.colors || []),
      tags: uniqueStrings([...(safeArray(listing.tags)), ...(safeArray(classification.tags))]).slice(0, 40),
      fit: item.fit || '',
      vibes: safeArray(item.vibes),
      sportMeta: item.sportMeta || null,
      entities: safeArray(item.entities),
      entityMeta: safeArray(item.entityMeta),
      sub: item.sub || null,
      occasionTags: safeArray(item.occasion_tags),
      styleMarkers: safeArray(item.style_markers),
      formalityScore: numberOrNull(item.formality_score),
      streetwearScore: numberOrNull(item.streetwear_score),
      cleanlinessScore: numberOrNull(item.cleanliness_score),
      classifierConfidence: classification?.raw?.confidence || item.confidence || null,
      recommendationIndexedAt: nowIso(),
      recommendationMutationId: mutationId,
      embeddingContentHash: embeddingDoc.contentHash,
      embeddingModel,
    };

    if (debug) {
      console.log('[reindex]', listingId, {
        category: item.category,
        sub: item.sub,
        sameHash,
      });
    }

    await Promise.all([
      listingRef.set(listingPatch, { merge: true }),
      this.db.collection(LISTING_EMBEDDINGS_COLLECTION).doc(listingId).set(embeddingDoc, { merge: true }),
    ]);
    await this.bumpLiveCorpusVersion();
    this.lastVersionCheckAt = 0;

    return {
      ok: true,
      listingId,
      status: sameHash ? 'metadata_updated' : 'reindexed',
      itemId: item.id,
      contentHash: embeddingDoc.contentHash,
    };
  }

  async backfillActiveListings({ classifyImage, limit = null, debug = false } = {}) {
    await this.ensureReady();
    let query = this.db.collection('listings').where('status', '==', 'active');
    const snapshot = await query.get();
    const docs = snapshot.docs.slice(0, limit && limit > 0 ? limit : undefined);
    const results = [];
    for (const doc of docs) {
      try {
        results.push(await this.reindexListing(doc.id, { classifyImage, debug }));
      } catch (error) {
        results.push({
          ok: false,
          listingId: doc.id,
          status: 'failed',
          error: String(error?.message || error),
        });
      }
    }

    return {
      ok: true,
      scanned: docs.length,
      succeeded: results.filter((entry) => entry.ok).length,
      failed: results.filter((entry) => !entry.ok).length,
      results,
    };
  }
}

export function createRecommenderRuntime(options = {}) {
  return new RecommenderRuntime(options);
}
