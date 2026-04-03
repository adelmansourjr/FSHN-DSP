import fs from 'fs';
import path from 'path';
import { VertexAI } from '@google-cloud/vertexai';
import { loadDurablePairwiseScores, persistDurablePairwiseScores } from '../recommendation/DurablePromptCache.ts';
import {
  CATEGORY_PHRASES,
  SemanticCorpusStats,
  buildSemanticCorpusStats,
  filterCorpusTerms,
  loadCanonicalIndex,
} from '../canonical_index.ts';
import {
  ALLOWED_COLOURS,
  CategoryMain,
  Colour,
  EntityMeta,
  Fit,
  Gender,
  IndexItem,
  OccasionTag,
  PaletteMode,
  PaletteOverrideStrength,
  PromptIntent,
  SettingContext,
  ActivityContext,
  DaypartContext,
  RequirementMode,
  RequestedForm,
  SLOT_ORDER,
  SlotConstraint,
  Sport,
  Vibe,
  canonicalizeSubtype,
  categoriesForForm,
  deriveRequestedForm,
  emptyPromptIntent,
  expandEntityAliases,
  colourProfile,
  hasWholeWord,
  inferItemOccasionTags,
  isNeutralColour,
  isAthleticShoeSubtype,
  isFormalSubtype,
  isHeelFamilySubtype,
  isLoungeSubtype,
  isOpenCasualShoeSubtype,
  isSleepwearSubtype,
  isSmartCasualShoeSubtype,
  joinedAliasText,
  normalizeContextList,
  normalizeKeywordList,
  normalizeOccasionTags,
  normalizeText,
  normalizeVibes,
  subtypeFamily,
  toColour,
  toFit,
  toSport,
  uniqueColours,
} from '../fashion_taxonomy.ts';
import { uniq } from '../text.ts';
import { buildPromptSemanticBundle, deriveStyleSignals } from '../style_semantics.ts';
import {
  EmbeddingSidecar,
  createGoogleGenAIClient,
  embedTexts,
  loadPersistedVectorCache,
  persistVectorCache,
  resolvePromptEmbeddingCachePath,
  resolveEmbeddingSidecarPath,
  weightedAverageVectors,
} from '../semantic_embeddings.ts';
import {
  EmbeddingMode,
  GeminiIntentState,
  LoadedEmbeddings,
  OutputMode,
  ParserMode,
  PromptEmbeddingState,
  RecommendationRequest,
  RecommendationResponse,
  RequestMemo,
  ResolvedSlotConstraint,
  ItemColourProfile,
  PaletteEvaluation,
  SlotConstraintProfile,
  SlotLockMode,
  VariantMode,
  VariantSupportState,
  CandidateScore as ScoredItem,
  ScoredOutfit,
  Outfit,
  PhraseHit,
} from './types';

const DEFAULT_EPSILON = 0.08;
const DEFAULT_JITTER = 0.03;
const DEFAULT_GEMINI_TIMEOUT_MS = 6500;
const DEFAULT_PROMPT_EMBED_TIMEOUT_MS = 8000;
const ROLE_WEIGHTS: Record<CategoryMain, number> = {
  top: 0.95,
  bottom: 0.65,
  shoes: 0.4,
  mono: 1.0,
};
const DIVERSITY_ROLE_WEIGHTS: Record<CategoryMain, number> = {
  top: 2.2,
  bottom: 1.9,
  shoes: 0.65,
  mono: 1.0,
};
const BEAM_OUTFIT_PRODUCT_THRESHOLD = 30000;
const DEFAULT_BEAM_WIDTH = 256;
const SERVICE_ACCOUNT_CANDIDATES = ['fshn-6a61b-800e2677dc54.json'];
const STOPWORDS = new Set([
  'i', 'want', 'need', 'a', 'an', 'the', 'for', 'to', 'me', 'give', 'with', 'and', 'or', 'of', 'in',
  'from', 'by', 'on', 'at', 'into', 'onto', 'my', 'your',
  'outfit', 'fit', 'look', 'please', 'nice', 'go', 'out', 'something', 'just', 'only', 'really',
  'smart', 'casual', 'formal', 'fancy', 'classy', 'old', 'money', 'streetwear', 'sporty', 'comfy',
  'date', 'night', 'university', 'uni', 'campus',
]);
const GENDER_DESCRIPTOR_TOKENS = new Set([
  'women', 'woman', 'womens', 'womens', 'ladies', 'female', 'girls', 'girl',
  'men', 'man', 'mens', 'male', 'boys', 'boy',
]);
const NON_IDENTITY_SEGMENT_TOKENS = new Set([
  ...STOPWORDS,
  ...GENDER_DESCRIPTOR_TOKENS,
  'chic', 'elegant', 'preppy', 'ivy', 'minimal', 'neutral', 'clean', 'basics',
  'cozy', 'lounge', 'loungewear', 'sleepwear', 'nightwear', 'beach', 'resort',
  'vacation', 'holiday', 'party', 'dinner', 'evening', 'office', 'work', 'travel',
  'airport', 'playboi', 'playboy', 'carti', 'y2k', 'edgy',
]);
const COLOUR_SYNONYMS: Array<[RegExp, Colour]> = [
  [/\bnavy\b|\bindigo\b|\bcobalt\b|\bsky\b/, 'blue'],
  [/\bcream\b|\bivory\b|\boatmeal\b|\bsand\b|\bkhaki\b|\btan\b|\bcamel\b/, 'beige'],
  [/\bcharcoal\b|\bslate\b|\bgraphite\b/, 'grey'],
  [/\bburgundy\b|\bmaroon\b|\bcrimson\b|\bscarlet\b/, 'red'],
  [/\bforest\b|\bolive\b|\bsage\b|\bemerald\b|\blime\b/, 'green'],
  [/\bviolet\b|\blilac\b|\blavender\b|\bplum\b/, 'purple'],
  [/\bfuchsia\b|\bmagenta\b|\bcoral\b|\bblush\b|\brose\b/, 'pink'],
  [/\brust\b|\bburnt orange\b|\btangerine\b/, 'orange'],
  [/\bgold\b|\bmustard\b|\blemon\b|\bamber\b/, 'yellow'],
];
const ALLOWED_SETTINGS: readonly SettingContext[] = ['office', 'beach', 'nightlife', 'home', 'travel', 'resort', 'campus', 'formal_event'] as const;
const ALLOWED_ACTIVITIES: readonly ActivityContext[] = ['sleep', 'lounge', 'beach', 'sport', 'party', 'dinner', 'travel', 'work', 'study'] as const;
const ALLOWED_DAYPARTS: readonly DaypartContext[] = ['day', 'night', 'bedtime'] as const;

const GENERIC_GARMENT_TOKENS = new Set<string>(uniq([
  ...SLOT_ORDER,
  'shoe',
  'shoes',
  'top',
  'bottom',
  'mono',
  'dress',
  ...CATEGORY_PHRASES.map((entry) => normalizeText(entry.phrase)),
  ...CATEGORY_PHRASES.flatMap((entry) => normalizeText(entry.phrase).split(' ')),
]));
let REQUEST_MEMO: RequestMemo | null = null;
let REQUEST_RANDOM: () => number = Math.random;
let REQUEST_PAIRWISE_CORPUS_VERSION = 'default';
const GLOBAL_PAIRWISE_BASE_CACHE = new Map<string, number>();
type PrecomputedItemFeatures = {
  fingerprint: string;
  itemText: string;
  itemIdentityText: string;
  itemColourText: string;
  genderSemanticText: string;
  itemOccasions: OccasionTag[];
  itemSignals: ReturnType<typeof deriveStyleSignals>;
  itemFamily: string;
  itemBrand: string;
  itemColourFamily: string;
  itemColourProfile: ItemColourProfile;
  lexicalFlags: {
    feminineUnisexVeto: boolean;
    masculineUnisexVeto: boolean;
    refinedMensTopFeminine: boolean;
    ruggedBootCue: boolean;
    explicitBootCue: boolean;
    footballFootwearCue: boolean;
    basketballFootwearCue: boolean;
    premiumBasketballCue: boolean;
    runningFootwearCue: boolean;
    tennisFootwearCue: boolean;
    gymTrainingFootwearCue: boolean;
    refinedTopTeeCue: boolean;
    refinedTopTechnicalCue: boolean;
    refinedTopJerseyCue: boolean;
    footballTopCue: boolean;
    footballBottomCue: boolean;
    basketballTopCue: boolean;
    basketballBottomShortsCue: boolean;
    basketballBottomJoggerCue: boolean;
    basketballBottomTailoredCue: boolean;
    gymTopAthleticCue: boolean;
    gymTopBasicCue: boolean;
    gymTopFormalCue: boolean;
    gymTopOuterwearCue: boolean;
    gymBottomActiveCue: boolean;
    gymBottomTailoredCue: boolean;
  };
};
type PreparedSlotCandidate = {
  item: IndexItem;
  tier: number;
  specificity: number;
  family: string;
  brandKey: string;
  colourFamily: string;
  variantGroupKey: string;
  variantBoosted: boolean;
  negativeViolated: boolean;
  anchorPreservation: number;
  symbolic: number;
};
type PreparedSlotCandidateState = {
  slot: CategoryMain;
  intent: PromptIntent;
  slotConstraint: SlotConstraintProfile;
  symbolicContext: SymbolicSlotContext;
  semanticContext: SemanticSlotContext | null;
  anchoredConstraintMode: boolean;
  perRoleLimit: number;
  prepared: PreparedSlotCandidate[];
  timings: {
    baseMs: number;
    tierMs: number;
    prepMs: number;
    rawSlotItems: number;
    baseAll: number;
    base: number;
  };
};
type SymbolicSlotContext = {
  slotConstraint: SlotConstraintProfile | ResolvedSlotConstraint;
  slotConstraintKey: string;
  target: ReturnType<typeof styleTarget>;
  colours: Colour[];
  occasions: string[];
  vibes: string[];
  entities: string[];
  variantMode: VariantMode;
  variantGroupHints: string[];
  womenDateRefinedFootwear: boolean;
  oldMoneyMens: boolean;
};
type SemanticSlotContext = {
  slotConstraintKey: string;
  promptVector: number[];
  promptIdentity: number[];
  promptStyle: number[];
};
const GLOBAL_ITEM_FEATURES = new Map<string, PrecomputedItemFeatures>();
let pendingPairwisePersist: Map<string, number> | null = null;
let pairwisePersistScheduled = false;
const CANDIDATE_TIMING_LOGS_ENABLED = (process.env.RECOMMENDER_TIMING_LOGS || '0') === '1';

function logDebug(debug: boolean, ...args: any[]) {
  if (debug) console.error('[DEBUG]', ...args);
}

function logCandidateTiming(stage: string, payload: Record<string, unknown>) {
  if (!CANDIDATE_TIMING_LOGS_ENABLED) return;
  console.log('[recommender][timing]', JSON.stringify({ stage, ...payload }));
}

function createRequestMemo(): RequestMemo {
  return {
    itemText: new Map(),
    itemIdentityText: new Map(),
    itemColourText: new Map(),
    paletteColours: new Map(),
    keywordHit: new Map(),
    entityHit: new Map(),
    colourHit: new Map(),
    subtypeMatch: new Map(),
    itemOccasions: new Map(),
    itemSignals: new Map(),
    itemFamily: new Map(),
    itemBrand: new Map(),
    itemColourFamily: new Map(),
    itemColourProfile: new Map(),
    globalNegative: new Map(),
    genderCompat: new Map(),
    slotNegative: new Map(),
    exactnessTier: new Map(),
    anchorPreservation: new Map(),
    symbolicScore: new Map(),
    semanticScore: new Map(),
    slotConstraintKeys: new WeakMap(),
    vectorNorms: new WeakMap(),
    slotItems: {},
    slotGlobalEligible: {},
    slotGenderEligible: new Map(),
    preparedSlotCandidates: new Map(),
    pairwiseBase: new Map(),
  };
}

function vectorNormCached(vector: number[]): number {
  const ref = vector as unknown as object;
  const cached = REQUEST_MEMO?.vectorNorms.get(ref);
  if (cached !== undefined) return cached;
  let norm = 0;
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
  const value = norm > 0 ? Math.sqrt(norm) : 0;
  REQUEST_MEMO?.vectorNorms.set(ref, value);
  return value;
}

function cosineSimilarityCached(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  const aNorm = vectorNormCached(a);
  const bNorm = vectorNormCached(b);
  if (aNorm <= 0 || bNorm <= 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (aNorm * bNorm);
}

function itemsForSlot(items: IndexItem[], slot: CategoryMain): IndexItem[] {
  const cached = REQUEST_MEMO?.slotItems[slot];
  if (cached) return cached;
  const value = items.filter((item) => item.category === slot);
  if (REQUEST_MEMO) REQUEST_MEMO.slotItems[slot] = value;
  return value;
}

function globallyEligibleItemsForSlot(items: IndexItem[], slot: CategoryMain, intent: PromptIntent): IndexItem[] {
  const cached = REQUEST_MEMO?.slotGlobalEligible[slot];
  if (cached) return cached;
  const value = itemsForSlot(items, slot).filter((item) => applyGlobalNegatives(item, intent));
  if (REQUEST_MEMO) REQUEST_MEMO.slotGlobalEligible[slot] = value;
  return value;
}

function genderEligibleItemsForSlot(items: IndexItem[], slot: CategoryMain, intent: PromptIntent): IndexItem[] {
  const cacheKey = `${slot}::${intent.target_gender || 'any'}`;
  const cached = REQUEST_MEMO?.slotGenderEligible.get(cacheKey);
  if (cached) return cached;
  const value = globallyEligibleItemsForSlot(items, slot, intent)
    .filter((item) => effectiveGenderCompatible(item, intent.target_gender));
  REQUEST_MEMO?.slotGenderEligible.set(cacheKey, value);
  return value;
}

function normalizeKeyPart(value: string | null | undefined): string {
  return normalizeText(value || '').trim();
}

function stableListKey(values: Array<string | null | undefined>): string {
  return values
    .map((value) => normalizeKeyPart(value))
    .filter(Boolean)
    .sort()
    .join('|');
}

function stableColourListKey(values: Array<Colour | string | null | undefined>): string {
  return values
    .map((value) => normalizeKeyPart(String(value || '')))
    .filter(Boolean)
    .sort()
    .join('|');
}

function slotConstraintCacheKey(slotConstraint: ResolvedSlotConstraint | SlotConstraintProfile): string {
  const objectKey = slotConstraint as unknown as object;
  const cached = REQUEST_MEMO?.slotConstraintKeys.get(objectKey);
  if (cached) return cached;
  const profile = slotConstraint as Partial<SlotConstraintProfile>;
  const key = [
    stableListKey(slotConstraint.preferred_subs || []),
    stableListKey(slotConstraint.required_keywords || []),
    stableListKey(slotConstraint.anchor_keywords || []),
    stableListKey(slotConstraint.anchor_entities || []),
    stableColourListKey(slotConstraint.anchor_colours || []),
    stableListKey(slotConstraint.exact_item_phrases || []),
    stableListKey(slotConstraint.excluded_subs || []),
    stableListKey(slotConstraint.excluded_keywords || []),
    stableListKey(slotConstraint.excluded_entities || []),
    stableColourListKey(slotConstraint.excluded_colours || []),
    stableListKey(slotConstraint.occasion_hints || []),
    stableListKey(slotConstraint.vibe_hints || []),
    stableListKey(profile.variantGroupHints || []),
    normalizeKeyPart(profile.lockMode || ''),
    normalizeKeyPart(profile.variantMode || ''),
  ].join('::');
  REQUEST_MEMO?.slotConstraintKeys.set(objectKey, key);
  return key;
}

function createSeededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function schedulePairwisePersist() {
  if (pairwisePersistScheduled || !pendingPairwisePersist?.size) return;
  pairwisePersistScheduled = true;
  setTimeout(() => {
    pairwisePersistScheduled = false;
    const entries = Array.from((pendingPairwisePersist || new Map()).entries()).map(([key, value]) => ({ key, value }));
    pendingPairwisePersist = null;
    if (!entries.length) return;
    void persistDurablePairwiseScores(entries).catch(() => {});
  }, 0);
}

function rememberGlobalPairwiseBase(cacheKey: string, value: number, persist = true) {
  if (!Number.isFinite(value)) return;
  GLOBAL_PAIRWISE_BASE_CACHE.set(cacheKey, value);
  if (!persist) return;
  pendingPairwisePersist ||= new Map();
  pendingPairwisePersist.set(cacheKey, value);
  schedulePairwisePersist();
}

function pairwisePersistentKey(left: IndexItem, right: IndexItem): string {
  return `${REQUEST_PAIRWISE_CORPUS_VERSION}|${left.id}|${right.id}`;
}

export function setRequestPairwiseCorpusVersion(version: string | null | undefined): void {
  REQUEST_PAIRWISE_CORPUS_VERSION = String(version || '').trim() || 'default';
}

export function requestRandom(): number {
  return REQUEST_RANDOM();
}

function requestItemKey(item: Partial<IndexItem> | undefined): string | null {
  const id = typeof item?.id === 'string' ? item.id.trim() : '';
  return id || null;
}

function itemFeatureFingerprint(item: Partial<IndexItem>): string {
  return JSON.stringify({
    sub: item.sub || '',
    name: item.name || '',
    name_normalized: item.name_normalized || '',
    colours: item.colours || [],
    vibes: item.vibes || [],
    occasion_tags: item.occasion_tags || [],
    entities: item.entities || [],
    identity_entities: item.identity_entities || [],
    entityMeta: item.entityMeta || [],
    style_markers: item.style_markers || [],
    gender: item.gender || '',
  });
}

function computeItemFeatureRecord(item: IndexItem): PrecomputedItemFeatures {
  const itemTextValue = normalizeText([
    item.sub || '',
    item.name || '',
    item.name_normalized || '',
    ...(item.colours || []),
    ...(item.vibes || []),
    ...(item.occasion_tags || []),
    ...(item.entities || []),
    ...((item.entityMeta || []).map((entry) => entry.text)),
    ...(item.style_markers || []),
  ].join(' '));
  const itemIdentityTextValue = normalizeText([
    item.name || '',
    item.name_normalized || '',
    ...(item.identity_entities || []),
    ...((item.entityMeta || [])
      .filter((entry) => entry.type === 'brand' || entry.type === 'team' || entry.type === 'sponsor')
      .map((entry) => entry.text)),
  ].join(' '));
  const itemColourTextValue = normalizeText([
    ...(item.colours || []),
    item.name || '',
    item.name_normalized || '',
  ].join(' '));
  const genderSemanticTextValue = normalizeText(
    [
      item.name || '',
      item.sub || '',
      ...(item.style_markers || []),
      ...(item.occasion_tags || []),
      ...(item.entities || []),
    ].join(' '),
  );
  const occasionsValue = item.occasion_tags?.length ? item.occasion_tags : inferItemOccasionTags(item);
  const signalsValue = deriveStyleSignals(item);
  const itemFamilyValue = subtypeFamily(item.sub || '').find((family) => !family.includes('/')) || canonicalizeSubtype(item.sub || '');
  const brand = (item.entityMeta || []).find((entry) => entry.type === 'brand' && entry.text);
  const itemBrandValue = normalizeText(brand?.text || '');
  const colourFamilies = uniqueColours(item.colours || []);
  const canonical = colourFamilies
    .map((colour) => {
      const profile = colourProfile(colour);
      return profile ? { colour, profile } : null;
    })
    .filter((entry): entry is { colour: Colour; profile: NonNullable<ReturnType<typeof colourProfile>> } => !!entry);
  const neutrals = canonical.filter((entry) => entry.profile.neutral).map((entry) => entry.colour);
  const chromatic = canonical.filter((entry) => !entry.profile.neutral).map((entry) => entry.colour);
  const itemColourProfileValue: ItemColourProfile = {
    primary: chromatic[0] || colourFamilies[0] || null,
    accents: chromatic.slice(0, 2),
    neutrals,
    chromatic,
    families: colourFamilies,
    warmCount: canonical.filter((entry) => entry.profile.temperature === 'warm' && !entry.profile.neutral).length,
    coolCount: canonical.filter((entry) => entry.profile.temperature === 'cool' && !entry.profile.neutral).length,
    neutralCount: neutrals.length,
    canonical,
  };
  const chroma = colourFamilies
    .map((colour) => normalizeText(colour))
    .filter((colour) => colour && !['black', 'white', 'grey', 'beige', 'brown'].includes(colour));
  const itemColourFamilyValue = chroma.length
    ? uniq(chroma).sort().join('+')
    : uniq(colourFamilies.map((colour) => normalizeText(colour)).filter(Boolean)).sort().join('+');
  const lexicalFlags = {
    feminineUnisexVeto: FEMININE_UNISEX_VETO_RE.test(genderSemanticTextValue),
    masculineUnisexVeto: MASCULINE_UNISEX_VETO_RE.test(genderSemanticTextValue),
    refinedMensTopFeminine: REFINED_MENS_TOP_FEMININE_RE.test(itemTextValue),
    ruggedBootCue: /\bhiking\b|\bwork boot\b|\bworkboot\b|\bcombat\b|\btrek\b|\btrail\b|\bmountain\b|\boutdoor\b|\brock\b/.test(itemTextValue),
    explicitBootCue: /\bboot\b|\bboots\b/.test(itemTextValue),
    footballFootwearCue: /\bfootball\b|\bsoccer\b|\bcleat\b|\bcleats\b|\bfirm ground\b|\bsoft ground\b|\bartificial ground\b|\bturf\b|\bfg\b|\bsg\b|\bag\b|\bmercurial\b|\bpredator\b|\bphantom\b|\bf50\b/.test(itemTextValue),
    basketballFootwearCue: /\bbasketball\b|\bnba\b|\bjordan\b|\bair jordan\b|\blebron\b|\bkobe\b|\bdunk\b/.test(itemTextValue),
    premiumBasketballCue: /\bjordan\b|\bair jordan\b|\blebron\b|\bkobe\b|\bdunk\b/.test(itemTextValue),
    runningFootwearCue: /\brunning\b|\brunner\b|\bmarathon\b|\btempo\b|\bpegasus\b|\bvaporfly\b|\balphafly\b|\bgel kayano\b|\bgel-kayano\b|\bnovablast\b/.test(itemTextValue),
    tennisFootwearCue: /\btennis\b|\bcourt\b|\bclay\b|\bhard court\b|\bwimbledon\b/.test(itemTextValue),
    gymTrainingFootwearCue: /\bgym\b|\btraining\b|\btrainer\b|\bcross trainer\b|\bcross-training\b|\bmetcon\b/.test(itemTextValue),
    refinedTopTeeCue: canonicalizeSubtype(item.sub || '') === 'tshirt' || /\btshirt\b|\btee\b/.test(itemTextValue),
    refinedTopTechnicalCue: /\b(tech ?fleece|fleece|track jacket|zip hoodie|athletic|training|sporty)\b/.test(itemTextValue),
    refinedTopJerseyCue: /\b(jersey|kit|club|fc|uefa|premier league|champions league|nba)\b/.test(itemTextValue),
    footballTopCue: /\bfootball\b|\bsoccer\b|\bjersey\b|\bkit\b|\bshirt\b/.test(itemTextValue),
    footballBottomCue: /\bfootball\b|\bsoccer\b|\bkit\b|\bshorts?\b/.test(itemTextValue),
    basketballTopCue: /\bbasketball\b|\bnba\b|\bjersey\b|\bshirt\b/.test(itemTextValue),
    basketballBottomShortsCue: canonicalizeSubtype(item.sub || '') === 'shorts',
    basketballBottomJoggerCue: /\bjogger|joggers\b/.test(itemTextValue),
    basketballBottomTailoredCue: ['jeans', 'trousers', 'dress pants', 'tailored trousers'].includes(canonicalizeSubtype(item.sub || '')),
    gymTopAthleticCue: /\bgym\b|\btraining\b|\bworkout\b|\bperformance\b|\bathletic\b|\bactivewear\b|\btechnical\b|\bcompression\b/.test(itemTextValue),
    gymTopBasicCue: /\b(sports bra|sport bra|tank|tank top|crop top|tee|t-shirt|tshirt|top)\b/.test(itemTextValue),
    gymTopFormalCue: /\b(blazer|dress shirt|oxford|cardigan|coat|parka)\b/.test(itemTextValue),
    gymTopOuterwearCue: /\bhoodie|sweatshirt|windbreaker|field jacket|drizzler|bomber\b/.test(itemTextValue),
    gymBottomActiveCue: /\b(short|shorts|legging|leggings|jogger|joggers|training short|running short|track short)\b/.test(itemTextValue),
    gymBottomTailoredCue: /\b(trouser|trousers|jean|jeans|tailored|slack|slacks)\b/.test(itemTextValue),
  };

  return {
    fingerprint: itemFeatureFingerprint(item),
    itemText: itemTextValue,
    itemIdentityText: itemIdentityTextValue,
    itemColourText: itemColourTextValue,
    genderSemanticText: genderSemanticTextValue,
    itemOccasions: occasionsValue,
    itemSignals: signalsValue,
    itemFamily: itemFamilyValue,
    itemBrand: itemBrandValue,
    itemColourFamily: itemColourFamilyValue,
    itemColourProfile: itemColourProfileValue,
    lexicalFlags,
  };
}

function itemLexicalFlags(item: IndexItem) {
  const precomputed = readPrecomputedItemFeatures(item);
  return precomputed?.lexicalFlags || computeItemFeatureRecord(item).lexicalFlags;
}

function readPrecomputedItemFeatures(item: Partial<IndexItem> | undefined): PrecomputedItemFeatures | null {
  const cacheKey = requestItemKey(item);
  if (!cacheKey || !item) return null;
  const fingerprint = itemFeatureFingerprint(item);
  const cached = GLOBAL_ITEM_FEATURES.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint) return cached;
  const computed = computeItemFeatureRecord(item as IndexItem);
  GLOBAL_ITEM_FEATURES.set(cacheKey, computed);
  return computed;
}

export function precomputeItemFeatures(items: IndexItem[] | undefined | null): void {
  for (const item of items || []) readPrecomputedItemFeatures(item);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function setGoogleCredentialsIfAvailable(debug: boolean) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    for (const name of SERVICE_ACCOUNT_CANDIDATES) {
      const candidate = path.resolve(process.cwd(), name);
      if (fs.existsSync(candidate)) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = candidate;
        logDebug(debug, 'using service account', candidate);
        break;
      }
    }
  }
  if ((!process.env.GOOGLE_CLOUD_PROJECT || !process.env.GCLOUD_PROJECT) && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const raw = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')) as { project_id?: string };
      if (raw.project_id) {
        if (!process.env.GOOGLE_CLOUD_PROJECT) process.env.GOOGLE_CLOUD_PROJECT = raw.project_id;
        if (!process.env.GCLOUD_PROJECT) process.env.GCLOUD_PROJECT = raw.project_id;
      }
    } catch {
      // ignore
    }
  }
}

function resolveProject(override?: string | null): string | null {
  return override?.trim() || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || null;
}

function loadIndex(indexPath: string): IndexItem[] {
  return loadCanonicalIndex(indexPath);
}

function itemText(item: Partial<IndexItem>): string {
  const cacheKey = requestItemKey(item);
  if (cacheKey && REQUEST_MEMO?.itemText.has(cacheKey)) return REQUEST_MEMO.itemText.get(cacheKey)!;
  const precomputed = readPrecomputedItemFeatures(item);
  const value = precomputed?.itemText || normalizeText([
    item.sub || '',
    item.name || '',
    item.name_normalized || '',
    ...(item.colours || []),
    ...(item.vibes || []),
    ...(item.occasion_tags || []),
    ...(item.entities || []),
    ...((item.entityMeta || []).map((entry) => entry.text)),
    ...(item.style_markers || []),
  ].join(' '));
  if (cacheKey) REQUEST_MEMO?.itemText.set(cacheKey, value);
  return value;
}

function itemIdentityText(item: Partial<IndexItem>): string {
  const cacheKey = requestItemKey(item);
  if (cacheKey && REQUEST_MEMO?.itemIdentityText.has(cacheKey)) return REQUEST_MEMO.itemIdentityText.get(cacheKey)!;
  const precomputed = readPrecomputedItemFeatures(item);
  const value = precomputed?.itemIdentityText || normalizeText([
    item.name || '',
    item.name_normalized || '',
    ...(item.identity_entities || []),
    ...((item.entityMeta || [])
      .filter((entry) => entry.type === 'brand' || entry.type === 'team' || entry.type === 'sponsor')
      .map((entry) => entry.text)),
  ].join(' '));
  if (cacheKey) REQUEST_MEMO?.itemIdentityText.set(cacheKey, value);
  return value;
}

function itemHasKeyword(item: Partial<IndexItem>, keyword: string): boolean {
  const itemKey = requestItemKey(item) || String(item.id || 'item');
  const key = normalizeText(keyword);
  if (!key) return false;
  const cacheKey = `${itemKey}::${key}`;
  if (REQUEST_MEMO?.keywordHit.has(cacheKey)) return REQUEST_MEMO.keywordHit.get(cacheKey)!;
  const text = itemText(item);
  const value = hasWholeWord(text, key) || text.includes(key);
  REQUEST_MEMO?.keywordHit.set(cacheKey, value);
  return value;
}

function itemHasEntity(item: Partial<IndexItem>, value: string): boolean {
  const itemKey = requestItemKey(item) || String(item.id || 'item');
  const key = normalizeText(value);
  if (!key) return false;
  const cacheKey = `${itemKey}::${key}`;
  if (REQUEST_MEMO?.entityHit.has(cacheKey)) return REQUEST_MEMO.entityHit.get(cacheKey)!;
  const aliases = expandEntityAliases(value);
  const identityText = itemIdentityText(item);
  const semanticText = itemText(item);
  const hit = aliases.some((alias) => {
    if (!alias) return false;
    if (hasWholeWord(identityText, alias)) return true;
    if (hasWholeWord(semanticText, alias)) return true;
    return semanticText.includes(alias);
  });
  REQUEST_MEMO?.entityHit.set(cacheKey, hit);
  return hit;
}

function itemColourText(item: Partial<IndexItem>): string {
  const cacheKey = requestItemKey(item);
  if (cacheKey && REQUEST_MEMO?.itemColourText.has(cacheKey)) return REQUEST_MEMO.itemColourText.get(cacheKey)!;
  const precomputed = readPrecomputedItemFeatures(item);
  const value = precomputed?.itemColourText || normalizeText([
    ...(item.colours || []),
    item.name || '',
    item.name_normalized || '',
  ].join(' '));
  if (cacheKey) REQUEST_MEMO?.itemColourText.set(cacheKey, value);
  return value;
}

function itemHasColour(item: Partial<IndexItem>, colour: Colour): boolean {
  const itemKey = requestItemKey(item) || String(item.id || 'item');
  const cacheKey = `${itemKey}::${colour}`;
  if (REQUEST_MEMO?.colourHit.has(cacheKey)) return REQUEST_MEMO.colourHit.get(cacheKey)!;
  let value = false;
  if ((item.colours || []).includes(colour)) {
    REQUEST_MEMO?.colourHit.set(cacheKey, true);
    return true;
  }
  const text = itemColourText(item);
  if (hasWholeWord(text, colour)) value = true;
  if (!value) {
    for (const [pattern, canonical] of COLOUR_SYNONYMS) {
      if (canonical === colour && pattern.test(text)) {
        value = true;
        break;
      }
    }
  }
  REQUEST_MEMO?.colourHit.set(cacheKey, value);
  return value;
}

function normalizePromptColourHints(text: string): Colour[] {
  const out: Colour[] = [];
  const norm = normalizeText(text);
  for (const colour of ALLOWED_COLOURS) {
    if (hasWholeWord(norm, colour)) out.push(colour);
  }
  for (const [pattern, canonical] of COLOUR_SYNONYMS) {
    if (pattern.test(norm)) out.push(canonical);
  }
  return uniq(out);
}

function slotHasPositiveIdentity(constraint: SlotConstraint): boolean {
  return !!(
    constraint.preferred_subs.length ||
    constraint.required_keywords.length ||
    constraint.preferred_entities.length ||
    constraint.fit_hints.length
  );
}

function explicitSlotPaletteLocks(intent: PromptIntent): Partial<Record<CategoryMain, boolean>> {
  return Object.fromEntries(
    SLOT_ORDER
      .filter((slot) => intent.slot_constraints[slot].colour_hints.length > 0 && slotHasPositiveIdentity(intent.slot_constraints[slot]))
      .map((slot) => [slot, true]),
  ) as Partial<Record<CategoryMain, boolean>>;
}

function paletteStrength(mode: PaletteMode, override: PaletteOverrideStrength): number {
  if (override === 'hard') return 1;
  if (override === 'soft') return mode === 'colorful' ? 0.72 : 0.64;
  return 0;
}

function inferGlobalPaletteIntent(intent: PromptIntent, prompt: string): void {
  const norm = normalizeText(prompt);
  const colours = uniqueColours(intent.colour_hints || []);
  const slotLocks = explicitSlotPaletteLocks(intent);
  const slotLockedColours = new Set(
    SLOT_ORDER.flatMap((slot) => (slotLocks[slot] ? intent.slot_constraints[slot].colour_hints : [])),
  );
  const unscopedColours = colours.filter((colour) => !slotLockedColours.has(colour));
  const hasOutfitWords = /\boutfit|fit|look\b/.test(norm);
  const explicitAllColour = colours.find((colour) => new RegExp(`\\ball\\s+${colour}\\b`).test(norm)) || null;
  const explicitMonochrome = /\bmonochrome\b|\bsingle colour\b|\bsingle color\b|\bone colour\b|\bone color\b/.test(norm);
  const explicitTonal = /\btonal\b/.test(norm);
  const explicitMuted = /\bmuted\b|\bsubtle\b|\bsoft palette\b/.test(norm);
  const explicitColorful = /\bcolorful\b|\bcolourful\b|\bvibrant\b|\bbright\b/.test(norm);
  const leadingGlobalColour = colours.length === 1 && new RegExp(`^(?:all\\s+)?${colours[0]}\\b`).test(norm);

  intent.slot_palette_locked = slotLocks;
  if (explicitColorful) {
    intent.palette_mode = 'colorful';
    intent.palette_override_strength = 'soft';
    return;
  }
  if (explicitMuted) {
    intent.palette_mode = 'muted';
    intent.palette_override_strength = 'soft';
    return;
  }
  if ((explicitAllColour || explicitMonochrome) && colours.length) {
    intent.palette_mode = explicitTonal ? 'tonal' : 'monochrome';
    intent.global_palette_colours = explicitAllColour ? [explicitAllColour] : colours.slice(0, 1);
    intent.palette_override_strength = 'hard';
    return;
  }
  if (explicitTonal) {
    intent.palette_mode = 'tonal';
    intent.global_palette_colours = colours.slice(0, 1);
    intent.palette_override_strength = colours.length ? 'hard' : 'soft';
    return;
  }

  const globalColourCandidate =
    hasOutfitWords &&
    colours.length === 1 &&
    unscopedColours.length === 1 &&
    !SLOT_ORDER.some((slot) => slotHasPositiveIdentity(intent.slot_constraints[slot])) &&
    (leadingGlobalColour || !/\bwith\b/.test(norm));
  if (globalColourCandidate) {
    intent.palette_mode = 'monochrome';
    intent.global_palette_colours = unscopedColours;
    intent.palette_override_strength = 'hard';
  }
}

function explicitSlotColour(slot: CategoryMain, intent: PromptIntent, slotConstraint: SlotConstraintProfile | SlotConstraint): Colour[] {
  const colours = uniqueColours(slotConstraint.colour_hints || []);
  if (colours.length) return colours;
  if (intent.outfit_mode === 'single' && intent.required_categories.length === 1 && intent.required_categories[0] === slot) {
    return uniqueColours(intent.colour_hints || []);
  }
  return [];
}

function effectivePaletteColoursForSlot(
  intent: PromptIntent,
  slot: CategoryMain,
  slotConstraint: SlotConstraintProfile | SlotConstraint,
): Colour[] {
  const cacheKey = `${slot}::${slotConstraintCacheKey(slotConstraint as ResolvedSlotConstraint | SlotConstraintProfile)}`;
  if (REQUEST_MEMO?.paletteColours.has(cacheKey)) return REQUEST_MEMO.paletteColours.get(cacheKey)!;
  const slotColours = explicitSlotColour(slot, intent, slotConstraint);
  let value: Colour[] = [];
  if (slotColours.length) value = slotColours;
  else if (intent.global_palette_colours.length && intent.palette_mode !== 'unconstrained') value = intent.global_palette_colours;
  else if (intent.outfit_mode === 'single' && intent.required_categories.length === 1 && intent.required_categories[0] === slot) {
    value = uniqueColours(intent.colour_hints || []);
  }
  REQUEST_MEMO?.paletteColours.set(cacheKey, value);
  return value;
}

function inferPromptContexts(prompt: string): {
  settings: SettingContext[];
  activities: ActivityContext[];
  dayparts: DaypartContext[];
  personas: string[];
} {
  const norm = normalizeText(prompt);
  const settings: SettingContext[] = [];
  const activities: ActivityContext[] = [];
  const dayparts: DaypartContext[] = [];
  const personas: string[] = [];

  if (/\b(beach|seaside|coast|coastal)\b/.test(norm)) {
    settings.push('beach');
    activities.push('beach');
    dayparts.push('day');
  }
  if (/\b(resort|vacation|holiday|getaway|monaco)\b/.test(norm)) settings.push('resort');
  if (/\b(nightlife|club|party|going out|date night)\b/.test(norm)) {
    settings.push('nightlife');
    activities.push('party');
    dayparts.push('night');
  }
  if (/\b(office|work|business casual|meeting|corporate)\b/.test(norm)) {
    settings.push('office');
    activities.push('work');
    dayparts.push('day');
  }
  if (/\b(home|indoors)\b/.test(norm)) settings.push('home');
  if (/\b(airport|flight|travel|travelling|traveling)\b/.test(norm)) {
    settings.push('travel');
    activities.push('travel');
    dayparts.push('day');
  }
  if (/\b(university|college|campus|study)\b/.test(norm)) {
    settings.push('campus');
    activities.push('study');
    dayparts.push('day');
  }
  if (/\b(wedding|gala|formal event|black tie|cocktail)\b/.test(norm)) settings.push('formal_event');
  if (/\b(sleep|bedtime|nightwear|nightgown)\b/.test(norm)) {
    settings.push('home');
    activities.push('sleep');
    dayparts.push('bedtime');
  }
  if (/\b(lounge|loungewear|cozy|comfy)\b/.test(norm)) {
    settings.push('home');
    activities.push('lounge');
  }
  if (/\b(dinner|date night)\b/.test(norm)) activities.push('dinner');
  if (/\b(football|soccer|basketball|running|tennis|gym|workout|training)\b/.test(norm)) activities.push('sport');
  if (!dayparts.length && /\b(evening|night)\b/.test(norm)) dayparts.push('night');
  if (!dayparts.length && /\b(morning|daytime|day)\b/.test(norm)) dayparts.push('day');

  return {
    settings: normalizeContextList(settings, ALLOWED_SETTINGS),
    activities: normalizeContextList(activities, ALLOWED_ACTIVITIES),
    dayparts: normalizeContextList(dayparts, ALLOWED_DAYPARTS),
    personas: normalizeKeywordList(personas),
  };
}

function requirementMode(required: boolean, optional: boolean): RequirementMode {
  if (required) return 'required';
  if (optional) return 'optional';
  return 'none';
}

function detectSubtypePhrase(segment: string): { slot: CategoryMain; subtype: string | null; familyOnly: boolean } | null {
  const norm = normalizeText(segment);
  for (const entry of CATEGORY_PHRASES.sort((a, b) => b.phrase.length - a.phrase.length)) {
    if (hasWholeWord(norm, entry.phrase)) {
      return {
        slot: entry.slot,
        subtype: entry.subtype || null,
        familyOnly: !!entry.familyOnly,
      };
    }
  }
  return null;
}

function collectPhraseHits(segment: string): PhraseHit[] {
  const norm = normalizeText(segment);
  const tokens = norm.split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const entries = [...CATEGORY_PHRASES]
    .map((entry) => ({ ...entry, tokenCount: normalizeText(entry.phrase).split(' ').filter(Boolean).length }))
    .sort((a, b) => b.tokenCount - a.tokenCount);
  const hits: PhraseHit[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let match: typeof entries[number] | null = null;
    for (const entry of entries) {
      const phraseTokens = normalizeText(entry.phrase).split(' ').filter(Boolean);
      if (!phraseTokens.length || i + phraseTokens.length > tokens.length) continue;
      let ok = true;
      for (let j = 0; j < phraseTokens.length; j++) {
        if (tokens[i + j] !== phraseTokens[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        match = entry;
        break;
      }
    }
    if (!match) continue;
    hits.push({
      phrase: normalizeText(match.phrase),
      slot: match.slot,
      subtype: match.subtype || null,
      familyOnly: !!match.familyOnly,
      start: i,
      end: i + match.tokenCount - 1,
    });
    i += match.tokenCount - 1;
  }
  return hits;
}

function removeKnownTokens(segment: string): string[] {
  const colours = new Set(normalizePromptColourHints(segment));
  const norm = normalizeText(segment);
  const subtype = detectSubtypePhrase(segment);
  const cleaned = norm
    .replace(/\b(for women|for woman|for ladies|for female|for girls|for girl|for men|for man|for male|for boys|for boy)\b/g, ' ')
    .replace(/\b(outfit|fit|look|for|with|and|the|a|an|give|me|want|need|nice|go|out)\b/g, ' ')
    .replace(subtype?.subtype ? new RegExp(`\\b${subtype.subtype.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g') : /$^/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned
    .split(' ')
    .filter(Boolean)
    .filter((token) => !NON_IDENTITY_SEGMENT_TOKENS.has(token) && !colours.has(token as Colour) && !GENERIC_GARMENT_TOKENS.has(token));
}

function normalizeSegmentIdentityPhrase(segment: string, subtype: string | null, colours: Colour[], extras: string[]): string {
  const colourSet = new Set(colours);
  const keep = normalizeText(segment)
    .replace(/\b(for women|for woman|for ladies|for female|for girls|for girl|for men|for man|for male|for boys|for boy)\b/g, ' ')
    .split(' ')
    .filter(Boolean)
    .filter((token) => !NON_IDENTITY_SEGMENT_TOKENS.has(token))
    .filter((token) => !GENDER_DESCRIPTOR_TOKENS.has(token))
    .filter((token) => !GENERIC_GARMENT_TOKENS.has(token))
    .filter((token) => !colourSet.has(token as Colour));
  const ordered = uniq([
    ...colours,
    ...keep,
    ...(subtype ? normalizeText(subtype).split(' ').filter(Boolean) : []),
    ...extras,
  ].filter(Boolean));
  return normalizeText(ordered.join(' '));
}

function assignSegmentToIntent(intent: PromptIntent, rawSegment: string) {
  const segment = normalizeText(stripNegativeTail(rawSegment));
  if (!segment) return;
  const hit = detectSubtypePhrase(segment);
  if (!hit) return;
  const slot = intent.slot_constraints[hit.slot];
  if (hit.subtype) slot.preferred_subs = uniq([...slot.preferred_subs, hit.subtype]);
  const colours = normalizePromptColourHints(segment);
  if (colours.length) slot.colour_hints = uniq([...slot.colour_hints, ...colours]);
  const extras = removeKnownTokens(segment);
  const identityPhrase = normalizeSegmentIdentityPhrase(segment, hit.subtype, colours, extras);
  if (extras.length) {
    slot.preferred_entities = uniq([...slot.preferred_entities, ...extras]);
  }
  if ((extras.length || colours.length || hit.subtype) && identityPhrase) {
    slot.required_keywords = uniq([...slot.required_keywords, identityPhrase]);
  }
  if ((extras.length || colours.length || hit.subtype) && identityPhrase) {
    intent.specific_items = uniq([...intent.specific_items, identityPhrase]);
  }
}

function stripNegativeTail(segment: string): string {
  const norm = normalizeText(segment);
  const markerIndex = norm.search(/\b(?:but no|but not|without|anything but|no|not)\b/);
  if (markerIndex === 0) return '';
  if (markerIndex < 0) return norm;
  const before = norm.slice(0, markerIndex).trim();
  return before || norm;
}

function startsWithNegation(segment: string): boolean {
  return /^\s*(?:but no\b|but not\b|non\b|no\b|not\b|without\b|anything but\b)/.test(normalizeText(segment));
}

function densePromptSegments(prompt: string): string[] {
  const norm = normalizeText(prompt);
  const tokens = norm.split(' ').filter(Boolean);
  if (tokens.length < 4) return [];
  const hits = collectPhraseHits(norm);
  if (hits.length < 2) return [];
  const segments: string[] = [];
  let cursor = 0;
  for (const hit of hits) {
    const end = hit.end + 1;
    const phrase = tokens.slice(cursor, end).join(' ').trim();
    if (phrase) segments.push(phrase);
    cursor = end;
  }
  return uniq(segments.filter(Boolean));
}

interface ExtractedNegation {
  phrase: string;
  start: number;
}

function extractNegations(prompt: string): ExtractedNegation[] {
  const norm = normalizeText(prompt);
  const patterns = [
    /\b(?:anything but|without|but no|no|not)\s+([a-z0-9/ -]+)/g,
    /\bnon[- ]([a-z0-9/ -]+)/g,
  ];
  const out: ExtractedNegation[] = [];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(norm)) !== null) {
      const rawPhrase = normalizeText(match[1] || '');
      const phrase = rawPhrase
        .split(/\b(?:but|with|and|for|to)\b/)[0]
        .trim();
      if (!phrase) continue;
      out.push({ phrase, start: match.index });
    }
  }
  return out;
}

function positiveSignalSlots(intent: PromptIntent): CategoryMain[] {
  return SLOT_ORDER.filter((slot) => {
    const constraint = intent.slot_constraints[slot];
    return !!(
      constraint.preferred_subs.length ||
      constraint.required_keywords.length ||
      constraint.preferred_entities.length ||
      constraint.colour_hints.length
    );
  });
}

function inferNegationSlot(intent: PromptIntent, prompt: string, phrase: string, start: number): CategoryMain | null {
  const directHit = detectSubtypePhrase(phrase);
  if (directHit) return directHit.slot;
  const colours = normalizePromptColourHints(phrase);
  const entities = removeKnownTokens(phrase);
  const before = normalizeText(prompt).slice(0, start);
  const priorHits = collectPhraseHits(before);
  if ((colours.length || entities.length) && priorHits.length) {
    return priorHits[priorHits.length - 1].slot;
  }
  const activeSlots = positiveSignalSlots(intent);
  if ((colours.length || entities.length) && activeSlots.length === 1) return activeSlots[0];
  if ((colours.length || entities.length) && intent.required_categories.length === 1) return intent.required_categories[0];
  return null;
}

function applyNegationPhrase(
  intent: PromptIntent,
  prompt: string,
  phrase: string,
  start: number,
  corpusStats?: SemanticCorpusStats | null,
) {
  const slot = inferNegationSlot(intent, prompt, phrase, start);
  const colours = normalizePromptColourHints(phrase);
  const hit = detectSubtypePhrase(phrase);
  const entities = filterCorpusTerms(
    removeKnownTokens(phrase)
      .filter((token) => !GENERIC_GARMENT_TOKENS.has(token) && !STOPWORDS.has(token) && !toColour(token)),
    corpusStats,
    'entity',
  );

  if (hasWholeWord(phrase, 'logos') || hasWholeWord(phrase, 'logo')) {
    intent.negative_constraints.no_logos = true;
  }
  if (hasWholeWord(phrase, 'sport') || hasWholeWord(phrase, 'football kit')) {
    intent.negative_constraints.non_sport = true;
  }

  if (slot) {
    const target = intent.slot_constraints[slot];
    let structuredApplied = false;
    if (hit?.subtype) {
      structuredApplied = true;
      target.excluded_subs = uniq([...target.excluded_subs, hit.subtype]);
      if (slot === 'shoes' && (isAthleticShoeSubtype(hit.subtype) || hasWholeWord(phrase, 'trainer') || hasWholeWord(phrase, 'sneaker'))) {
        intent.negative_constraints.non_sport = true;
      }
      if (hasWholeWord(phrase, 'heels')) {
        intent.slot_constraints.shoes.excluded_subs = uniq([
          ...intent.slot_constraints.shoes.excluded_subs,
          'heels',
          'pumps',
          'stilettos',
          'kitten heels',
          'slingbacks',
        ]);
      }
    }
    if (colours.length) {
      structuredApplied = true;
      target.colour_hints = target.colour_hints.filter((colour) => !colours.includes(colour));
      intent.colour_hints = intent.colour_hints.filter((colour) => !colours.includes(colour));
      target.excluded_colours = uniq([...(target.excluded_colours || []), ...colours]);
    }
    if (entities.length) {
      structuredApplied = true;
      target.preferred_entities = target.preferred_entities.filter((entity) => !entities.includes(entity));
      target.excluded_entities = uniq([...(target.excluded_entities || []), ...entities]);
    }
    if (!structuredApplied) {
      target.excluded_keywords = uniq([...target.excluded_keywords, phrase]);
    }
  } else {
    intent.negative_constraints.excluded_keywords = uniq([...intent.negative_constraints.excluded_keywords, phrase]);
  }
}

function parseNegatives(intent: PromptIntent, prompt: string, corpusStats?: SemanticCorpusStats | null) {
  for (const entry of extractNegations(prompt)) {
    applyNegationPhrase(intent, prompt, entry.phrase, entry.start, corpusStats);
  }
}

function heuristicIntent(prompt: string, genderPref: Gender | 'any'): PromptIntent {
  const norm = normalizeText(prompt);
  const intent = emptyPromptIntent();
  intent.target_gender = genderPref;
  intent.colour_hints = normalizePromptColourHints(norm);
  const contexts = inferPromptContexts(prompt);
  intent.setting_context = contexts.settings;
  intent.activity_context = contexts.activities;
  intent.daypart_context = contexts.dayparts;
  intent.persona_terms = contexts.personas;

  if (/\bfor women|women s|womens|woman|ladies|female\b/.test(norm)) intent.target_gender = 'women';
  else if (/\bfor men|men s|mens|man|male\b/.test(norm)) intent.target_gender = 'men';
  else if (/\bunisex|androgynous\b/.test(norm)) intent.target_gender = 'any';

  if (/\boversized|baggy|boxy\b/.test(norm)) intent.fit_preference = 'oversized';
  else if (/\bslim|skinny|fitted\b/.test(norm)) intent.fit_preference = 'slim';
  else if (/\bcropped\b/.test(norm)) intent.fit_preference = 'cropped';

  if (/\bfootball|soccer|matchday|kit|cleats?\b/.test(norm)) intent.sport_context = 'football';
  else if (/\bbasketball|nba\b/.test(norm)) intent.sport_context = 'basketball';
  else if (/\brunning|runner\b/.test(norm)) intent.sport_context = 'running';
  else if (/\btennis\b/.test(norm)) intent.sport_context = 'tennis';
  else if (/\bgym|workout|training\b/.test(norm)) intent.sport_context = 'gym';

  intent.vibe_tags = normalizeVibes([
    /\bstreetwear|street\b/.test(norm) ? 'streetwear' : '',
    /\bold money|preppy|ivy|university|college|campus|smart casual\b/.test(norm) ? 'preppy' : '',
    /\bformal|fancy|dressy|date night|dinner|evening\b/.test(norm) ? 'formal' : '',
    /\bchic|classy|elegant\b/.test(norm) ? 'chic' : '',
    /\bminimal|neutral|clean basics?\b/.test(norm) ? 'minimal' : '',
    /\bsporty|athletic\b/.test(norm) ? 'sporty' : '',
    /\bcomfy|cozy|pajama|lounge\b/.test(norm) ? 'comfy' : '',
  ]);
  intent.occasion_tags = normalizeOccasionTags([
    /\bsmart casual|old money|preppy|university|college|campus\b/.test(norm) ? 'smart casual' : '',
    /\bformal|fancy|black tie|suit\b/.test(norm) ? 'formal' : '',
    /\bdate night|dinner|evening|cocktail\b/.test(norm) ? 'evening' : '',
    /\blounge|loungewear|comfy|cozy\b/.test(norm) ? 'lounge' : '',
    /\bpajama|sleepwear|nightgown|nightwear\b/.test(norm) ? 'sleepwear' : '',
  ]);

  const segments = norm.split(/\bwith\b|\band\b|,/).map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    if (startsWithNegation(segment)) continue;
    const denseSegments = densePromptSegments(segment);
    if (denseSegments.length) {
      for (const dense of denseSegments) assignSegmentToIntent(intent, dense);
      continue;
    }
    assignSegmentToIntent(intent, segment);
  }
  if (segments.length <= 1 && !startsWithNegation(norm)) {
    for (const segment of densePromptSegments(norm)) assignSegmentToIntent(intent, segment);
  }
  parseNegatives(intent, norm);
  inferGlobalPaletteIntent(intent, norm);

  const slotSignals = SLOT_ORDER.filter((slot) => {
    const constraint = intent.slot_constraints[slot];
    return (
      constraint.preferred_subs.length ||
      constraint.preferred_entities.length ||
      constraint.required_keywords.length ||
      constraint.colour_hints.length
    );
  });

  if (!slotSignals.length) {
    if (/\bdress|gown|jumpsuit|romper\b/.test(norm)) slotSignals.push('mono');
    else if (/\bjeans|trousers|pants|shorts|bottom\b/.test(norm)) slotSignals.push('bottom');
    else if (/\bboots|sneakers|heels|shoes|slippers|sandals|slides\b/.test(norm)) slotSignals.push('shoes');
    else if (/\bjacket|shirt|hoodie|sweater|cardigan|coat|top\b/.test(norm)) slotSignals.push('top');
  }

  const outfitWords = /\boutfit|fit|look\b/.test(norm);
  const monoSignal = slotSignals.includes('mono');
  const topSignal = slotSignals.includes('top');
  const bottomSignal = slotSignals.includes('bottom');
  const shoesSignal = slotSignals.includes('shoes');

  let requestedForm: RequestedForm;
  if (monoSignal && shoesSignal) requestedForm = 'mono_and_shoes';
  else if (monoSignal) requestedForm = 'mono_only';
  else if (topSignal && bottomSignal && shoesSignal) requestedForm = 'top_bottom_shoes';
  else if (topSignal && bottomSignal) requestedForm = 'top_bottom';
  else if (topSignal && shoesSignal) requestedForm = 'top_shoes';
  else if (bottomSignal && shoesSignal) requestedForm = 'bottom_shoes';
  else if (topSignal) requestedForm = 'top_only';
  else if (bottomSignal) requestedForm = 'bottom_only';
  else if (shoesSignal) requestedForm = 'shoes_only';
  else if (/\bpajama outfit|loungewear outfit|sleepwear outfit\b/.test(norm)) requestedForm = 'top_bottom';
  else if (outfitWords || intent.vibe_tags.length || intent.occasion_tags.length) requestedForm = 'top_bottom_shoes';
  else requestedForm = 'top_only';

  if (outfitWords) {
    if (requestedForm === 'top_only' || requestedForm === 'bottom_only' || requestedForm === 'shoes_only' || requestedForm === 'top_shoes' || requestedForm === 'bottom_shoes') {
      requestedForm = 'top_bottom_shoes';
    }
    if (requestedForm === 'mono_only' && !intent.negative_constraints.excluded_categories.includes('shoes')) {
      requestedForm = 'mono_and_shoes';
    }
  }

  if (/\bpajama outfit|loungewear outfit|sleepwear outfit\b/.test(norm)) {
    intent.optional_categories = ['shoes'];
  }
  if (/\bdress with shoes|dress and heels|black dress with shoes\b/.test(norm) && requestedForm === 'mono_only') {
    requestedForm = 'mono_and_shoes';
  }

  const categories = categoriesForForm(requestedForm);
  intent.requested_form = requestedForm;
  intent.required_categories = categories.required;
  intent.optional_categories = uniq([...intent.optional_categories, ...categories.optional]);
  intent.mono_requirement = requirementMode(intent.required_categories.includes('mono'), intent.optional_categories.includes('mono'));
  intent.shoe_requirement = requirementMode(intent.required_categories.includes('shoes'), intent.optional_categories.includes('shoes'));
  intent.outfit_mode = requestedForm.endsWith('_only') && categories.required.length === 1 && !outfitWords ? 'single' : 'outfit';

  const orphanColours = intent.colour_hints.filter((colour) => !SLOT_ORDER.some((slot) => intent.slot_constraints[slot].colour_hints.includes(colour)));
  if (orphanColours.length) {
    const slot = monoSignal ? 'mono' : topSignal ? 'top' : bottomSignal ? 'bottom' : shoesSignal ? 'shoes' : null;
    if (slot) intent.slot_constraints[slot].colour_hints = uniq([...intent.slot_constraints[slot].colour_hints, ...orphanColours]);
  }
  intent.slot_palette_locked = explicitSlotPaletteLocks(intent);

  if (intent.sport_context !== 'none') {
    const tokens = removeKnownTokens(norm).filter((token) => !['football', 'soccer', 'basketball', 'running', 'tennis', 'gym'].includes(token));
    if (tokens.length) intent.team_focus = uniq([...intent.team_focus, tokens.join(' ')]);
  }

  return intent;
}

function sanitizeIntent(value: any): PromptIntent {
  const base = emptyPromptIntent();
  if (!value || typeof value !== 'object') return base;
  const requestedForm = typeof value.requested_form === 'string' ? value.requested_form as RequestedForm : base.requested_form;
  const categories = categoriesForForm(requestedForm);
  base.requested_form = requestedForm;
  base.required_categories = Array.isArray(value.required_categories)
    ? value.required_categories.filter((slot: any) => SLOT_ORDER.includes(slot))
    : categories.required;
  if (!base.required_categories.length) base.required_categories = categories.required;
  base.optional_categories = Array.isArray(value.optional_categories)
    ? value.optional_categories.filter((slot: any) => SLOT_ORDER.includes(slot))
    : categories.optional;
  base.outfit_mode = value.outfit_mode === 'single' || (base.required_categories.length === 1 && !base.optional_categories.length) ? 'single' : 'outfit';
  base.target_gender = value.target_gender === 'men' || value.target_gender === 'women' || value.target_gender === 'unisex' ? value.target_gender : 'any';
  base.vibe_tags = normalizeVibes(value.vibe_tags || []);
  base.occasion_tags = normalizeOccasionTags(value.occasion_tags || []);
  base.colour_hints = uniqueColours(value.colour_hints || []);
  base.brand_focus = normalizeKeywordList(value.brand_focus || []);
  base.team_focus = normalizeKeywordList(value.team_focus || []);
  base.specific_items = normalizeKeywordList(value.specific_items || []);
  base.setting_context = normalizeContextList(value.setting_context || [], ALLOWED_SETTINGS);
  base.activity_context = normalizeContextList(value.activity_context || [], ALLOWED_ACTIVITIES);
  base.daypart_context = normalizeContextList(value.daypart_context || [], ALLOWED_DAYPARTS);
  base.persona_terms = normalizeKeywordList(value.persona_terms || []);
  base.palette_mode =
    value.palette_mode === 'monochrome' ||
    value.palette_mode === 'tonal' ||
    value.palette_mode === 'colorful' ||
    value.palette_mode === 'muted'
      ? value.palette_mode
      : 'unconstrained';
  base.global_palette_colours = uniqueColours(value.global_palette_colours || []);
  base.slot_palette_locked = Object.fromEntries(
    SLOT_ORDER
      .filter((slot) => !!value.slot_palette_locked?.[slot])
      .map((slot) => [slot, true]),
  ) as Partial<Record<CategoryMain, boolean>>;
  base.palette_override_strength =
    value.palette_override_strength === 'hard' || value.palette_override_strength === 'soft'
      ? value.palette_override_strength
      : 'none';
  base.fit_preference = value.fit_preference === 'mixed' ? 'mixed' : (toFit(value.fit_preference) || null);
  base.sport_context = toSport(value.sport_context) || 'none';
  base.mono_requirement = value.mono_requirement === 'required' || value.mono_requirement === 'optional' ? value.mono_requirement : requirementMode(base.required_categories.includes('mono'), base.optional_categories.includes('mono'));
  base.shoe_requirement = value.shoe_requirement === 'required' || value.shoe_requirement === 'optional' ? value.shoe_requirement : requirementMode(base.required_categories.includes('shoes'), base.optional_categories.includes('shoes'));

  for (const slot of SLOT_ORDER) {
    const src = value.slot_constraints?.[slot] || {};
    base.slot_constraints[slot] = {
      preferred_subs: normalizeKeywordList(src.preferred_subs || []).map(canonicalizeSubtype).filter(Boolean),
      required_keywords: normalizeKeywordList(src.required_keywords || []),
      preferred_entities: normalizeKeywordList(src.preferred_entities || []),
      colour_hints: uniqueColours(src.colour_hints || []),
      fit_hints: uniq((src.fit_hints || []).map((entry: any) => toFit(entry)).filter((entry: Fit | null): entry is Fit => !!entry)),
      vibe_hints: normalizeVibes(src.vibe_hints || []),
      occasion_hints: normalizeOccasionTags(src.occasion_hints || []),
      excluded_keywords: normalizeKeywordList(src.excluded_keywords || []),
      excluded_subs: normalizeKeywordList(src.excluded_subs || []).map(canonicalizeSubtype).filter(Boolean),
      excluded_entities: normalizeKeywordList(src.excluded_entities || []),
      excluded_colours: uniqueColours(src.excluded_colours || []),
    };
  }

  base.negative_constraints = {
    excluded_categories: Array.isArray(value.negative_constraints?.excluded_categories)
      ? value.negative_constraints.excluded_categories.filter((slot: any) => SLOT_ORDER.includes(slot))
      : [],
    excluded_keywords: normalizeKeywordList(value.negative_constraints?.excluded_keywords || []),
    excluded_subs: normalizeKeywordList(value.negative_constraints?.excluded_subs || []).map(canonicalizeSubtype).filter(Boolean),
    excluded_brands: normalizeKeywordList(value.negative_constraints?.excluded_brands || []),
    excluded_teams: normalizeKeywordList(value.negative_constraints?.excluded_teams || []),
    non_sport: !!value.negative_constraints?.non_sport,
    no_logos: !!value.negative_constraints?.no_logos,
  };

  return base;
}

function mergeIntents(primary: PromptIntent, secondary: PromptIntent): PromptIntent {
  const merged = sanitizeIntent(primary);
  merged.required_categories = uniq([...secondary.required_categories, ...merged.required_categories]);
  merged.optional_categories = uniq([...secondary.optional_categories, ...merged.optional_categories]).filter((slot) => !merged.required_categories.includes(slot));
  merged.requested_form = deriveRequestedForm(merged.required_categories, merged.optional_categories);
  merged.outfit_mode = merged.required_categories.length === 1 && !merged.optional_categories.length ? 'single' : 'outfit';
  merged.target_gender = primary.target_gender !== 'any' ? primary.target_gender : secondary.target_gender;
  merged.vibe_tags = uniq([...primary.vibe_tags, ...secondary.vibe_tags]);
  merged.occasion_tags = uniq([...primary.occasion_tags, ...secondary.occasion_tags]);
  merged.colour_hints = uniq([...primary.colour_hints, ...secondary.colour_hints]);
  merged.brand_focus = uniq([...primary.brand_focus, ...secondary.brand_focus]);
  merged.team_focus = uniq([...primary.team_focus, ...secondary.team_focus]);
  merged.specific_items = uniq([...primary.specific_items, ...secondary.specific_items]);
  merged.setting_context = uniq([...primary.setting_context, ...secondary.setting_context]);
  merged.activity_context = uniq([...primary.activity_context, ...secondary.activity_context]);
  merged.daypart_context = uniq([...primary.daypart_context, ...secondary.daypart_context]);
  merged.persona_terms = uniq([...primary.persona_terms, ...secondary.persona_terms]);
  merged.palette_mode = primary.palette_mode !== 'unconstrained' ? primary.palette_mode : secondary.palette_mode;
  merged.global_palette_colours = uniq([...primary.global_palette_colours, ...secondary.global_palette_colours]);
  merged.slot_palette_locked = Object.fromEntries(
    SLOT_ORDER
      .filter((slot) => !!primary.slot_palette_locked?.[slot] || !!secondary.slot_palette_locked?.[slot])
      .map((slot) => [slot, true]),
  ) as Partial<Record<CategoryMain, boolean>>;
  merged.palette_override_strength = primary.palette_override_strength !== 'none' ? primary.palette_override_strength : secondary.palette_override_strength;
  merged.fit_preference = primary.fit_preference || secondary.fit_preference;
  merged.sport_context = primary.sport_context !== 'none' ? primary.sport_context : secondary.sport_context;
  merged.mono_requirement = primary.mono_requirement !== 'none' ? primary.mono_requirement : secondary.mono_requirement;
  merged.shoe_requirement = primary.shoe_requirement !== 'none' ? primary.shoe_requirement : secondary.shoe_requirement;
  for (const slot of SLOT_ORDER) {
    const left = primary.slot_constraints[slot];
    const right = secondary.slot_constraints[slot];
    merged.slot_constraints[slot] = {
      preferred_subs: uniq([...left.preferred_subs, ...right.preferred_subs]),
      required_keywords: uniq([...left.required_keywords, ...right.required_keywords]),
      preferred_entities: uniq([...left.preferred_entities, ...right.preferred_entities]),
      colour_hints: uniq([...left.colour_hints, ...right.colour_hints]),
      fit_hints: uniq([...left.fit_hints, ...right.fit_hints]),
      vibe_hints: uniq([...left.vibe_hints, ...right.vibe_hints]),
      occasion_hints: uniq([...left.occasion_hints, ...right.occasion_hints]),
      excluded_keywords: uniq([...left.excluded_keywords, ...right.excluded_keywords]),
      excluded_subs: uniq([...left.excluded_subs, ...right.excluded_subs]),
      excluded_entities: uniq([...(left.excluded_entities || []), ...(right.excluded_entities || [])]),
      excluded_colours: uniq([...(left.excluded_colours || []), ...(right.excluded_colours || [])]),
    };
  }
  merged.negative_constraints = {
    excluded_categories: uniq([...primary.negative_constraints.excluded_categories, ...secondary.negative_constraints.excluded_categories]),
    excluded_keywords: uniq([...primary.negative_constraints.excluded_keywords, ...secondary.negative_constraints.excluded_keywords]),
    excluded_subs: uniq([...primary.negative_constraints.excluded_subs, ...secondary.negative_constraints.excluded_subs]),
    excluded_brands: uniq([...primary.negative_constraints.excluded_brands, ...secondary.negative_constraints.excluded_brands]),
    excluded_teams: uniq([...primary.negative_constraints.excluded_teams, ...secondary.negative_constraints.excluded_teams]),
    non_sport: primary.negative_constraints.non_sport || secondary.negative_constraints.non_sport,
    no_logos: primary.negative_constraints.no_logos || secondary.negative_constraints.no_logos,
  };
  return merged;
}

async function geminiIntent(
  prompt: string,
  genderPref: Gender | 'any',
  project: string | null,
  location: string,
  model: string,
  debug: boolean,
): Promise<PromptIntent | null> {
  if (!project) return null;
  try {
    const vertex = new VertexAI({ project, location });
    const systemPrompt = `
You are an intent parser for a fashion recommender.
Return one JSON object only.

Schema:
{
  "outfit_mode": "outfit" | "single",
  "requested_form": "top_bottom_shoes" | "top_bottom" | "top_shoes" | "bottom_shoes" | "mono_only" | "mono_and_shoes" | "top_only" | "bottom_only" | "shoes_only",
  "required_categories": ["top" | "bottom" | "shoes" | "mono"],
  "optional_categories": ["top" | "bottom" | "shoes" | "mono"],
  "target_gender": "men" | "women" | "unisex" | "any",
  "vibe_tags": ["streetwear" | "edgy" | "minimal" | "y2k" | "techwear" | "sporty" | "preppy" | "vintage" | "chic" | "formal" | "comfy"],
  "occasion_tags": ["smart_casual" | "formal" | "evening" | "lounge" | "sleepwear"],
  "colour_hints": ["black" | "white" | "grey" | "red" | "blue" | "green" | "beige" | "brown" | "pink" | "orange" | "yellow" | "purple"],
  "brand_focus": [string],
  "team_focus": [string],
  "sport_context": string,
  "fit_preference": "oversized" | "regular" | "slim" | "cropped" | "mixed" | null,
  "specific_items": [string],
  "setting_context": ["office" | "beach" | "nightlife" | "home" | "travel" | "resort" | "campus" | "formal_event"],
  "activity_context": ["sleep" | "lounge" | "beach" | "sport" | "party" | "dinner" | "travel" | "work" | "study"],
  "daypart_context": ["day" | "night" | "bedtime"],
  "persona_terms": [string],
  "palette_mode": "unconstrained" | "monochrome" | "tonal" | "colorful" | "muted",
  "global_palette_colours": ["black" | "white" | "grey" | "red" | "blue" | "green" | "beige" | "brown" | "pink" | "orange" | "yellow" | "purple"],
  "slot_palette_locked": {"top": boolean, "bottom": boolean, "shoes": boolean, "mono": boolean},
  "palette_override_strength": "none" | "soft" | "hard",
  "mono_requirement": "none" | "optional" | "required",
  "shoe_requirement": "none" | "optional" | "required",
  "slot_constraints": {
    "top": {"preferred_subs":[string],"required_keywords":[string],"preferred_entities":[string],"colour_hints":[string],"fit_hints":[string],"vibe_hints":[string],"occasion_hints":[string],"excluded_keywords":[string],"excluded_subs":[string]},
    "bottom": {"preferred_subs":[string],"required_keywords":[string],"preferred_entities":[string],"colour_hints":[string],"fit_hints":[string],"vibe_hints":[string],"occasion_hints":[string],"excluded_keywords":[string],"excluded_subs":[string]},
    "shoes": {"preferred_subs":[string],"required_keywords":[string],"preferred_entities":[string],"colour_hints":[string],"fit_hints":[string],"vibe_hints":[string],"occasion_hints":[string],"excluded_keywords":[string],"excluded_subs":[string]},
    "mono": {"preferred_subs":[string],"required_keywords":[string],"preferred_entities":[string],"colour_hints":[string],"fit_hints":[string],"vibe_hints":[string],"occasion_hints":[string],"excluded_keywords":[string],"excluded_subs":[string]}
  },
  "negative_constraints": {
    "excluded_categories": ["top" | "bottom" | "shoes" | "mono"],
    "excluded_keywords": [string],
    "excluded_subs": [string],
    "excluded_brands": [string],
    "excluded_teams": [string],
    "non_sport": boolean,
    "no_logos": boolean
  }
}
Rules:
- Keep abstract semantics generic. Use vibes and occasion tags rather than invented brands.
- Use setting/activity/daypart contexts when the prompt implies beach, nightlife, office, home, travel, sleep, or study.
- Keep persona terms style-first. Weak associated brands are allowed only as short optional style priors when they are strongly relevant.
- Keep explicit colours, entities, subtypes, and negatives attached to the correct slot when possible.
- Use palette fields only when the prompt clearly requests an outfit-wide color direction such as monochrome, tonal, muted, or colorful.
- Do not add unsupported categories.
- Return JSON only.
`.trim();
    const modelClient = vertex.getGenerativeModel({
      model,
      systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
    });
    const result = await modelClient.generateContent({
      contents: [{
        role: 'user',
        parts: [{ text: `Prompt: "${prompt}"\nGender hint: "${genderPref}"` }],
      }],
    });
    const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    return sanitizeIntent(JSON.parse(text.slice(first, last + 1)));
  } catch (error) {
    logDebug(debug, 'gemini parse failed', error);
    return null;
  }
}

async function resolveGeminiIntent(
  prompt: string,
  genderPref: Gender | 'any',
  parserMode: ParserMode,
  project: string | null,
  location: string,
  model: string,
  debug: boolean,
): Promise<GeminiIntentState> {
  if (parserMode === 'heuristic') return { active: false, reason: 'parser_mode_heuristic', intent: null };
  if (!project) return { active: false, reason: 'project_missing', intent: null };
  try {
    const intent = await withTimeout(
      geminiIntent(prompt, genderPref, project, location, model, debug),
      DEFAULT_GEMINI_TIMEOUT_MS,
      'gemini_intent',
    );
    if (!intent) return { active: false, reason: 'gemini_empty', intent: null };
    return { active: true, reason: null, intent };
  } catch (error) {
    logDebug(debug, 'gemini timed out or failed', error);
    return {
      active: false,
      reason: String((error as Error)?.message || 'gemini_failed'),
      intent: null,
    };
  }
}

function contentWordCount(value: string): number {
  return normalizeText(value)
    .split(' ')
    .filter(Boolean)
    .filter((token) => !STOPWORDS.has(token) && !GENERIC_GARMENT_TOKENS.has(token) && !toColour(token)).length;
}

function keywordQualityForSlot(keyword: string, slot: CategoryMain) {
  const norm = normalizeText(keyword);
  const hits = collectPhraseHits(norm);
  const sameSlotHits = hits.filter((hit) => hit.slot === slot);
  const otherSlotHits = hits.filter((hit) => hit.slot !== slot);
  const colours = normalizePromptColourHints(norm);
  const entityTokens = removeKnownTokens(norm).filter((token) => !GENERIC_GARMENT_TOKENS.has(token));
  const tokenCount = norm.split(' ').filter(Boolean).length;
  const score =
    (sameSlotHits.length * 4.2) +
    (colours.length * 1.1) +
    (entityTokens.length * 0.8) -
    (otherSlotHits.length * 3.4) -
    (Math.max(0, tokenCount - 4) * 0.35);
  return { text: norm, sameSlotHits, otherSlotHits, colours, entityTokens, score, tokenCount };
}

function promptSpecificity(slot: ResolvedSlotConstraint, intent: PromptIntent): number {
  const hasSub = slot.preferred_subs.length > 0;
  const hasColour = slot.anchor_colours.length > 0 || slot.colour_hints.length > 0;
  const hasEntity = slot.anchor_entities.length > 0 || slot.preferred_entities.length > 0;
  const hasKeyword = slot.anchor_keywords.length > 0 || slot.required_keywords.length > 0;
  const hasExactPhrase = slot.exact_item_phrases.length > 0;
  const hasSportOrTeam = intent.sport_context !== 'none' || intent.team_focus.length > 0;
  let level = 0;
  if (hasSub || hasColour) level = Math.max(level, 1);
  if (hasEntity || hasSportOrTeam || hasKeyword) level = Math.max(level, 2);
  if (hasColour && (hasSub || hasEntity)) level = Math.max(level, 3);
  if (hasEntity && hasColour && hasSub) level = Math.max(level, 4);
  if (hasExactPhrase) level = Math.max(level, 5);
  return level;
}

function phraseLooksExactItem(phrase: string, slot: CategoryMain, corpusStats: SemanticCorpusStats | null | undefined): boolean {
  const norm = normalizeText(phrase);
  const info = keywordQualityForSlot(norm, slot);
  const keptPhrase = filterCorpusTerms([norm], corpusStats, 'entity');
  return contentWordCount(norm) >= 3 &&
    info.sameSlotHits.length > 0 &&
    (info.entityTokens.length > 0 || info.colours.length > 0) &&
    keptPhrase.length > 0;
}

function resolveSlotConstraint(
  slot: CategoryMain,
  raw: SlotConstraint,
  intent: PromptIntent,
  corpusStats?: SemanticCorpusStats | null,
): ResolvedSlotConstraint {
  const preferredSubs = uniq((raw.preferred_subs || []).map(canonicalizeSubtype).filter(Boolean));
  const requiredKeywords = filterCorpusTerms(raw.required_keywords || [], corpusStats, 'entity');
  const preferredEntities = filterCorpusTerms(raw.preferred_entities || [], corpusStats, 'entity')
    .filter((entity) => !GENERIC_GARMENT_TOKENS.has(entity) && !STOPWORDS.has(entity) && !toColour(entity));
  const keywordCandidates = uniq([
    ...requiredKeywords,
    ...intent.specific_items.filter((entry) => {
      const info = keywordQualityForSlot(entry, slot);
      return info.sameSlotHits.length > 0;
    }),
  ]);
  const keywordInfos = keywordCandidates
    .map((entry) => keywordQualityForSlot(entry, slot))
    .filter((info) => info.sameSlotHits.length > 0 || info.entityTokens.length > 0 || info.colours.length > 0)
    .sort((a, b) => b.score - a.score || a.tokenCount - b.tokenCount);

  const anchorInfos = keywordInfos.length
    ? keywordInfos
      .filter((info) => info.score >= keywordInfos[0].score - 0.8)
      .slice(0, 2)
    : [];
  const anchorKeywords = anchorInfos.map((info) => info.text);
  const anchorColours = anchorInfos.find((info) => info.colours.length)?.colours || raw.colour_hints;
  const keywordEntityAnchor = anchorInfos.length
    ? filterCorpusTerms(
        uniq(anchorInfos.flatMap((info) => info.entityTokens)).filter((entity) => !GENERIC_GARMENT_TOKENS.has(entity)),
        corpusStats,
        'entity',
      )
    : [];
  const anchorEntities = keywordEntityAnchor.length ? keywordEntityAnchor : (anchorKeywords.length ? [] : preferredEntities);
  const inferredSubs = keywordInfos.flatMap((info) => info.sameSlotHits.map((hit) => hit.subtype).filter(Boolean) as string[]);
  const resolvedColours = anchorKeywords.length ? uniqueColours(anchorColours) : uniqueColours(raw.colour_hints || []);
  const resolvedKeywords = anchorKeywords.length ? anchorKeywords : requiredKeywords.filter((keyword) => keyword && !GENERIC_GARMENT_TOKENS.has(keyword));
  const exactItemPhrases = keywordCandidates
    .filter((keyword) => phraseLooksExactItem(keyword, slot, corpusStats))
    .slice(0, 2);

  return {
    preferred_subs: preferredSubs.length ? preferredSubs : uniq(inferredSubs.map(canonicalizeSubtype).filter(Boolean)),
    required_keywords: resolvedKeywords,
    preferred_entities: anchorEntities,
    colour_hints: resolvedColours,
    fit_hints: uniq(raw.fit_hints || []),
    vibe_hints: uniq(raw.vibe_hints || []),
    occasion_hints: uniq(raw.occasion_hints || []),
    excluded_keywords: uniq((raw.excluded_keywords || []).map((entry) => normalizeText(entry)).filter(Boolean)),
    excluded_subs: uniq((raw.excluded_subs || []).map(canonicalizeSubtype).filter(Boolean)),
    excluded_entities: uniq((raw.excluded_entities || []).map((entry) => normalizeText(entry)).filter(Boolean)),
    excluded_colours: uniqueColours(raw.excluded_colours || []),
    anchor_keywords: anchorKeywords,
    anchor_entities: anchorEntities,
    anchor_colours: uniqueColours(anchorColours),
    exact_item_phrases: exactItemPhrases,
  };
}

function itemEntityHitCount(item: IndexItem, values: string[]): number {
  return values.filter((value) => itemHasEntity(item, value)).length;
}

function slotNegativeViolation(item: IndexItem, slotConstraint: ResolvedSlotConstraint | SlotConstraintProfile): boolean {
  const cacheKey = `${requestItemKey(item) || item.id || 'item'}::${slotConstraintCacheKey(slotConstraint)}`;
  if (REQUEST_MEMO?.slotNegative.has(cacheKey)) return REQUEST_MEMO.slotNegative.get(cacheKey)!;
  const violated =
    slotConstraint.excluded_subs.some((sub) => slotSubtypeMatch(item, sub)) ||
    slotConstraint.excluded_keywords.some((keyword) => itemHasKeyword(item, keyword)) ||
    (slotConstraint.excluded_entities || []).some((entity) => itemHasEntity(item, entity)) ||
    (slotConstraint.excluded_colours || []).some((colour) => itemHasColour(item, colour));
  REQUEST_MEMO?.slotNegative.set(cacheKey, violated);
  return violated;
}

function analyzeVariantSupport(
  slot: CategoryMain,
  resolved: ResolvedSlotConstraint,
  items: IndexItem[],
): { mode: VariantMode; groupHints: string[]; disambiguatorStrength: number } {
  const strongKeywordIdentity = resolved.anchor_keywords.some((keyword) => {
    const info = keywordQualityForSlot(keyword, slot);
    return info.entityTokens.length > 0 || info.colours.length > 0 || contentWordCount(keyword) >= 3;
  });
  const strongIdentity =
    resolved.anchor_entities.length >= 1 ||
    strongKeywordIdentity ||
    resolved.exact_item_phrases.length >= 1;
  if (!strongIdentity) return { mode: 'none', groupHints: [], disambiguatorStrength: 0 };

  const groupMap = new Map<string, { items: IndexItem[]; score: number; viable: IndexItem[] }>();
  for (const item of items) {
    if (item.category !== slot || !item.variant_group_key) continue;
    const entityHits = itemEntityHitCount(item, resolved.anchor_entities);
    const keywordHits = resolved.anchor_keywords.filter((keyword) => itemHasKeyword(item, keyword) || itemExactPhraseMatch(item, keyword)).length;
    const requiredKeywordHits = resolved.required_keywords.filter((keyword) => itemHasKeyword(item, keyword)).length;
    const anchorEntityHits = (item.variant_anchor_entities || []).filter((entity) =>
      resolved.anchor_entities.some((anchor) => normalizeText(anchor) === normalizeText(entity)) ||
      resolved.anchor_keywords.some((keyword) => hasWholeWord(keyword, entity) || hasWholeWord(entity, keyword)),
    ).length;
    const anchorScore = entityHits * 2.8 + keywordHits * 2.0 + requiredKeywordHits * 1.1 + anchorEntityHits * 1.5;
    if (anchorScore < 2.8) continue;
    const entry = groupMap.get(item.variant_group_key) || { items: [], score: 0, viable: [] };
    entry.items.push(item);
    entry.score += anchorScore + (item.repair_confidence || 0.55);
    if (!slotNegativeViolation(item, resolved)) entry.viable.push(item);
    groupMap.set(item.variant_group_key, entry);
  }

  const best = Array.from(groupMap.entries())
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) =>
      b.viable.length - a.viable.length ||
      b.items.length - a.items.length ||
      b.score - a.score)
    [0];
  if (!best) return { mode: 'none', groupHints: [], disambiguatorStrength: 0 };

  const viableItems = best.viable.length ? best.viable : best.items;
  const disambiguatorStrength =
    (resolved.anchor_colours.length * 2.2) +
    (resolved.fit_hints.length * 1.4) +
    (resolved.exact_item_phrases.length * 3.5) +
    (resolved.excluded_colours.length * 1.6) +
    (resolved.excluded_entities.length * 1.2);
  const literalSubtypeSupported = !resolved.preferred_subs.length ||
    viableItems.some((item) => resolved.preferred_subs.some((sub) => slotSubtypeMatch(item, sub)));
  if (viableItems.length <= 1) {
    return { mode: 'locked', groupHints: [best.key], disambiguatorStrength: Math.max(disambiguatorStrength, 2.5) };
  }
  if (resolved.exact_item_phrases.length || resolved.anchor_colours.length || resolved.fit_hints.length) {
    return { mode: 'locked', groupHints: [best.key], disambiguatorStrength: Math.max(disambiguatorStrength, 2.5) };
  }
  if (!literalSubtypeSupported) {
    return { mode: 'open', groupHints: [best.key], disambiguatorStrength };
  }
  return {
    mode: disambiguatorStrength > 0 ? 'locked' : 'open',
    groupHints: [best.key],
    disambiguatorStrength,
  };
}

function slotLockMode(profile: ResolvedSlotConstraint, intent: PromptIntent): SlotLockMode {
  if (profile.exact_item_phrases.length) return 'exact';
  if (profile.preferred_subs.length && (profile.anchor_entities.length > 0 || profile.anchor_colours.length > 0)) return 'family';
  if (profile.anchor_entities.length >= 2 && profile.anchor_keywords.length) return 'family';
  if (
    profile.preferred_subs.length > 0 ||
    profile.anchor_colours.length > 0 ||
    profile.anchor_entities.length > 0 ||
    profile.fit_hints.length > 0 ||
    profile.required_keywords.length > 0 ||
    intent.sport_context !== 'none'
  ) {
    return 'attribute';
  }
  return 'broad';
}

function buildSlotProfiles(
  intent: PromptIntent,
  items: IndexItem[],
  corpusStats?: SemanticCorpusStats | null,
): Record<CategoryMain, SlotConstraintProfile> {
  return Object.fromEntries(
    SLOT_ORDER.map((slot) => {
      const resolved = resolveSlotConstraint(slot, intent.slot_constraints[slot], intent, corpusStats);
      const specificity = promptSpecificity(resolved, intent);
      const variantSupport = analyzeVariantSupport(slot, resolved, items);
      let lockMode = slotLockMode(resolved, intent);
      if (variantSupport.mode === 'open' && lockMode === 'family') lockMode = 'attribute';
      else if (variantSupport.mode === 'locked' && lockMode === 'attribute' && resolved.anchor_entities.length) lockMode = 'family';
      return [slot, {
        ...resolved,
        specificity,
        lockMode,
        diversityExempt: lockMode === 'exact' || variantSupport.mode === 'locked',
        variantMode: variantSupport.mode,
        variantGroupHints: variantSupport.groupHints,
        disambiguatorStrength: variantSupport.disambiguatorStrength,
      }];
    }),
  ) as Record<CategoryMain, SlotConstraintProfile>;
}

function embeddingRetrievalWeight(profile: SlotConstraintProfile): number {
  if (profile.lockMode === 'exact') return 0.18;
  if (profile.lockMode === 'family') return 0.32;
  if (profile.lockMode === 'attribute') return 0.55;
  return 0.88;
}

function embeddingOutfitWeight(slotProfiles: Record<CategoryMain, SlotConstraintProfile>, outfit: Outfit): number {
  const occupiedSlots = SLOT_ORDER.filter((slot) => !!outfit[slot]);
  if (!occupiedSlots.length) return 0.8;
  const broadness = occupiedSlots.reduce((sum, slot) => sum + slotBroadness(slotProfiles[slot]), 0) / occupiedSlots.length;
  return 0.55 + broadness * 0.75;
}

function candidatePoolLimit(profile: SlotConstraintProfile, baseLimit: number): number {
  if (profile.lockMode === 'exact') return Math.max(4, Math.ceil(baseLimit * 0.35));
  if (profile.lockMode === 'family') return Math.max(6, Math.ceil(baseLimit * 0.5));
  if (profile.lockMode === 'attribute') return Math.max(10, Math.ceil(baseLimit * 0.8));
  return Math.max(baseLimit, 24);
}

function frontierSoftLimit(profile: SlotConstraintProfile, baseLimit: number): number {
  const base = candidatePoolLimit(profile, baseLimit);
  if (profile.lockMode === 'exact' || profile.lockMode === 'family') return base;
  if (profile.lockMode === 'attribute') return Math.max(base, Math.ceil(baseLimit * 1.6), 24);
  return Math.max(base, Math.ceil(baseLimit * 2.1), 32);
}

function frontierScoreWindow(profile: SlotConstraintProfile): number {
  if (profile.lockMode === 'exact' || profile.lockMode === 'family') return 0;
  if (profile.lockMode === 'attribute') return 2.6;
  return 3.6;
}

function exactnessPenaltyWeight(profile: SlotConstraintProfile): number {
  if (profile.lockMode === 'exact') return 6.5;
  if (profile.lockMode === 'family') return 3.8;
  if (profile.lockMode === 'attribute') return 1.6;
  return 0.25;
}

function slotLockRank(profile: SlotConstraintProfile): number {
  if (profile.lockMode === 'exact') return 0;
  if (profile.lockMode === 'family') return 1;
  if (profile.lockMode === 'attribute') return 2;
  return 3;
}

function slotSubtypeMatch(item: IndexItem, subtype: string): boolean {
  const itemKey = requestItemKey(item) || item.id || 'item';
  const want = canonicalizeSubtype(subtype);
  const cacheKey = `${itemKey}::${want}`;
  if (REQUEST_MEMO?.subtypeMatch.has(cacheKey)) return REQUEST_MEMO.subtypeMatch.get(cacheKey)!;
  const itemSub = canonicalizeSubtype(item.sub || '');
  if (!want) return true;
  if (want === itemSub) {
    REQUEST_MEMO?.subtypeMatch.set(cacheKey, true);
    return true;
  }
  const families = new Set(subtypeFamily(itemSub));
  if (families.has(want)) {
    REQUEST_MEMO?.subtypeMatch.set(cacheKey, true);
    return true;
  }
  const targetFamilies = new Set(subtypeFamily(want));
  for (const family of targetFamilies) {
    if (families.has(family)) {
      REQUEST_MEMO?.subtypeMatch.set(cacheKey, true);
      return true;
    }
  }
  const value = itemHasKeyword(item, want);
  REQUEST_MEMO?.subtypeMatch.set(cacheKey, value);
  return value;
}

function slotBroadness(profile: SlotConstraintProfile): number {
  if (profile.lockMode === 'exact') return 0;
  if (profile.lockMode === 'family') return 0.15;
  if (profile.lockMode === 'attribute') return 0.72;
  return 1;
}

function intentAllowsBroadDiversity(intent: PromptIntent): boolean {
  return (
    intent.outfit_mode === 'outfit' &&
    !intent.specific_items.length &&
    !intent.brand_focus.length &&
    !intent.team_focus.length &&
    !intent.persona_terms.length &&
    intent.sport_context === 'none'
  );
}

function slotStructurallyBroadForDiversity(profile: SlotConstraintProfile, intent: PromptIntent): boolean {
  if (!intentAllowsBroadDiversity(intent)) return false;
  if (profile.lockMode === 'exact' || profile.lockMode === 'family' || profile.variantMode === 'locked') return false;
  return slotBroadness(profile) >= 0.45;
}

function compressOpenSlotSymbolic(symbolic: number, bestSymbolic: number, profile: SlotConstraintProfile): number {
  if (profile.lockMode === 'exact' || profile.lockMode === 'family') return symbolic;
  const diff = Math.max(0, bestSymbolic - symbolic);
  if (!diff) return symbolic;
  const factor = profile.lockMode === 'attribute' ? 0.62 : 0.38;
  return bestSymbolic - diff * factor;
}

function selectOpenSlotFrontier(
  scored: ScoredItem[],
  slot: CategoryMain,
  profile: SlotConstraintProfile,
  perRoleLimit: number,
): ScoredItem[] {
  if (!scored.length) return [];
  if (profile.lockMode === 'exact' || profile.lockMode === 'family') {
    return scored.slice(0, candidatePoolLimit(profile, perRoleLimit));
  }

  const limit = frontierSoftLimit(profile, perRoleLimit);
  const scoreFloor = scored[0].score - frontierScoreWindow(profile);
  const band = scored
    .filter((entry, index) => index < limit * 3 || entry.score >= scoreFloor)
    .slice(0, Math.max(limit * 4, limit));
  const selected: ScoredItem[] = [];
  const seenFamilies = new Set<string>();
  const seenBrands = new Set<string>();
  const seenColourFamilies = new Set<string>();
  const seenVariantIds = new Set<string>();
  const noveltyWeight = slot === 'bottom' ? 1.45 : slot === 'top' ? 1.1 : 0.9;
  const hasVariantBand = profile.variantMode === 'open' && band.some((candidate) => candidate.variantBoosted);

  while (selected.length < limit && band.length) {
    let bestIndex = 0;
    let bestAdjusted = -Infinity;
    for (let i = 0; i < band.length; i++) {
      const candidate = band[i];
      let adjusted = candidate.score;
      if (hasVariantBand) {
        if (candidate.variantBoosted && !seenVariantIds.has(candidate.item.id)) adjusted += 1.6 * noveltyWeight;
        else if (!candidate.variantBoosted) adjusted -= 1.8 * noveltyWeight;
      }
      if (candidate.family && !seenFamilies.has(candidate.family)) adjusted += 0.95 * noveltyWeight;
      else if (candidate.family) adjusted -= 0.3 * noveltyWeight;
      if (candidate.brandKey && !seenBrands.has(candidate.brandKey)) adjusted += 0.42 * noveltyWeight;
      else if (candidate.brandKey) adjusted -= 0.16 * noveltyWeight;
      if (candidate.colourFamily && !seenColourFamilies.has(candidate.colourFamily)) adjusted += 0.33 * noveltyWeight;
      else if (candidate.colourFamily) adjusted -= 0.12 * noveltyWeight;
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIndex = i;
      }
    }
    const chosen = band.splice(bestIndex, 1)[0];
    selected.push(chosen);
    if (chosen.variantBoosted) seenVariantIds.add(chosen.item.id);
    if (chosen.family) seenFamilies.add(chosen.family);
    if (chosen.brandKey) seenBrands.add(chosen.brandKey);
    if (chosen.colourFamily) seenColourFamilies.add(chosen.colourFamily);
  }

  return selected;
}

function itemExactPhraseMatch(item: IndexItem, phrase: string): boolean {
  const normPhrase = normalizeText(phrase);
  if (!normPhrase) return false;
  const identityText = itemIdentityText(item);
  if (hasWholeWord(identityText, normPhrase)) return true;
  return item.name_normalized ? hasWholeWord(item.name_normalized, normPhrase) : false;
}

function exactnessTier(item: IndexItem, slot: CategoryMain, slotConstraint: SlotConstraintProfile): number {
  const cacheKey = `${requestItemKey(item) || item.id || 'item'}::${slot}::${slotConstraintCacheKey(slotConstraint)}`;
  if (REQUEST_MEMO?.exactnessTier.has(cacheKey)) return REQUEST_MEMO.exactnessTier.get(cacheKey)!;
  const subExact = slotConstraint.preferred_subs.some((sub) => canonicalizeSubtype(sub) === canonicalizeSubtype(item.sub || ''));
  const subFamily = !subExact && slotConstraint.preferred_subs.some((sub) => slotSubtypeMatch(item, sub));
  const hasAllColours = !slotConstraint.anchor_colours.length || slotConstraint.anchor_colours.every((colour) => itemHasColour(item, colour));
  const hasAnyColour = !slotConstraint.anchor_colours.length || slotConstraint.anchor_colours.some((colour) => itemHasColour(item, colour));
  const hasAllEntities = !slotConstraint.anchor_entities.length || slotConstraint.anchor_entities.every((entity) => itemHasEntity(item, entity));
  const hasAnyEntity = !slotConstraint.anchor_entities.length || slotConstraint.anchor_entities.some((entity) => itemHasEntity(item, entity));
  const exactPhraseMatch = slotConstraint.exact_item_phrases.some((keyword) => itemExactPhraseMatch(item, keyword));
  const hasAnchorKeyword = slotConstraint.anchor_keywords.some((keyword) => itemHasKeyword(item, keyword) || itemExactPhraseMatch(item, keyword));
  const hasKeyword = slotConstraint.required_keywords.some((keyword) => itemHasKeyword(item, keyword));
  const inVariantGroup = !!(item.variant_group_key && slotConstraint.variantGroupHints.includes(item.variant_group_key));
  const anchored = slotConstraint.anchor_keywords.length > 0 || slotConstraint.anchor_entities.length > 0 || slotConstraint.anchor_colours.length > 0 || slotConstraint.preferred_subs.length > 0;

  let tier = 5;
  if (exactPhraseMatch) tier = 0;
  else if (slotConstraint.variantMode === 'locked' && inVariantGroup && hasAllEntities && hasAllColours) tier = 1;
  else if (slotConstraint.variantMode === 'open' && inVariantGroup && hasAllEntities && hasAllColours) tier = 1;
  else if (anchored && hasAllEntities && hasAllColours && (subExact || subFamily || inVariantGroup || slot === 'shoes' || slot === 'mono')) tier = 1;
  else if (hasAnchorKeyword && (subExact || subFamily || hasAllEntities || slotConstraint.preferred_subs.length === 0) && hasAllColours) tier = 2;
  else if (slotConstraint.variantMode !== 'none' && inVariantGroup && hasAllColours && (hasAnyEntity || hasAnchorKeyword)) tier = 2;
  else if (anchored && hasAnyEntity && hasAllColours && (subExact || subFamily || inVariantGroup || slotConstraint.preferred_subs.length === 0)) tier = 2;
  else if ((subExact || subFamily) && (hasAllColours || hasAnyColour || !slotConstraint.anchor_colours.length)) tier = 3;
  else if (slotConstraint.variantMode === 'open' && inVariantGroup && (hasAnyEntity || hasKeyword || hasAnyColour)) tier = 3;
  else if (hasKeyword || hasAnyEntity || hasAnyColour) tier = 4;
  REQUEST_MEMO?.exactnessTier.set(cacheKey, tier);
  return tier;
}

function slotHasExplicitConstraints(slotConstraint: SlotConstraintProfile): boolean {
  return !!(
    slotConstraint.excluded_subs.length ||
    slotConstraint.excluded_keywords.length ||
    (slotConstraint.excluded_entities || []).length ||
    (slotConstraint.excluded_colours || []).length
  );
}

function slotHasIdentityAnchors(slotConstraint: SlotConstraintProfile): boolean {
  return !!(
    slotConstraint.exact_item_phrases.length ||
    slotConstraint.anchor_entities.length ||
    slotConstraint.anchor_keywords.length
  );
}

function anchorPreservationScore(item: IndexItem, slotConstraint: SlotConstraintProfile): number {
  const cacheKey = `${requestItemKey(item) || item.id || 'item'}::${slotConstraintCacheKey(slotConstraint)}`;
  if (REQUEST_MEMO?.anchorPreservation.has(cacheKey)) return REQUEST_MEMO.anchorPreservation.get(cacheKey)!;
  const exactPhraseMatch = slotConstraint.exact_item_phrases.some((keyword) => itemExactPhraseMatch(item, keyword));
  const allEntities = slotConstraint.anchor_entities.length > 0 &&
    slotConstraint.anchor_entities.every((entity) => itemHasEntity(item, entity));
  const anyEntities = slotConstraint.anchor_entities.length > 0 &&
    slotConstraint.anchor_entities.some((entity) => itemHasEntity(item, entity));
  const allKeywords = slotConstraint.required_keywords.length > 0 &&
    slotConstraint.required_keywords.every((keyword) => itemHasKeyword(item, keyword));
  const anyKeywords = slotConstraint.required_keywords.length > 0 &&
    slotConstraint.required_keywords.some((keyword) => itemHasKeyword(item, keyword));
  const subtypeMatch = slotConstraint.preferred_subs.length > 0 &&
    slotConstraint.preferred_subs.some((sub) => slotSubtypeMatch(item, sub));
  const inVariantGroup = !!(item.variant_group_key && slotConstraint.variantGroupHints.includes(item.variant_group_key));

  if (
    !slotConstraint.exact_item_phrases.length &&
    !slotConstraint.anchor_entities.length &&
    !slotConstraint.required_keywords.length &&
    !slotConstraint.preferred_subs.length
  ) {
    REQUEST_MEMO?.anchorPreservation.set(cacheKey, 1);
    return 1;
  }

  let weighted = 0;
  let total = 0;
  const identityAnchored = slotConstraint.exact_item_phrases.length > 0 || slotConstraint.anchor_entities.length > 0;

  if (identityAnchored) {
    weighted += exactPhraseMatch ? 1.08 : allEntities ? 0.94 : anyEntities ? 0.4 : 0;
    total += 1.1;
  }
  if (slotConstraint.required_keywords.length) {
    weighted += allKeywords ? 0.7 : anyKeywords ? 0.34 : 0;
    total += identityAnchored ? 0.16 : 0.8;
  }
  if (slotConstraint.preferred_subs.length) {
    weighted += subtypeMatch ? 0.46 : 0;
    total += identityAnchored ? 0.12 : 0.35;
  }
  if (slotConstraint.variantGroupHints.length) {
    weighted += inVariantGroup ? 0.85 : 0;
    total += identityAnchored ? 0.24 : 0.45;
  }

  const value = total > 0 ? Math.max(0, Math.min(1, weighted / total)) : 1;
  REQUEST_MEMO?.anchorPreservation.set(cacheKey, value);
  return value;
}

function selectAnchoredConstraintFrontier(
  scored: ScoredItem[],
  slotConstraint: SlotConstraintProfile,
  perRoleLimit: number,
): ScoredItem[] {
  const limit = candidatePoolLimit(slotConstraint, perRoleLimit);
  const clean = scored.filter((entry) => !entry.negativeViolated);
  const pool = clean.length ? clean : scored;
  if (!pool.length) return [];

  const tierA = pool.filter((entry) =>
    anchorPreservationScore(entry.item, slotConstraint) >= 0.88 &&
    slotConstraint.preferred_subs.some((sub) => slotSubtypeMatch(entry.item, sub)) &&
    slotConstraint.required_keywords.some((keyword) => itemHasKeyword(entry.item, keyword)),
  );
  if (tierA.length) return tierA.slice(0, limit);

  const tierB = pool.filter((entry) =>
    anchorPreservationScore(entry.item, slotConstraint) >= 0.72 &&
    slotConstraint.required_keywords.some((keyword) => itemHasKeyword(entry.item, keyword)),
  );
  if (tierB.length) return tierB.slice(0, limit);

  const tierC = pool.filter((entry) => anchorPreservationScore(entry.item, slotConstraint) >= 0.58);
  if (tierC.length) return tierC.slice(0, limit);

  const tierD = pool.filter((entry) =>
    slotConstraint.required_keywords.some((keyword) => itemHasKeyword(entry.item, keyword)) ||
    slotConstraint.preferred_subs.some((sub) => slotSubtypeMatch(entry.item, sub)),
  );
  if (tierD.length) return tierD.slice(0, limit);

  return [];
}

function maxExactnessTierForProfile(profile: SlotConstraintProfile): number {
  if (profile.lockMode === 'exact') return 1;
  if (profile.lockMode === 'family') return 2;
  if (profile.lockMode === 'attribute') return 4;
  return 5;
}

function exactnessSlackForProfile(profile: SlotConstraintProfile): number {
  if (profile.lockMode === 'exact') return 0;
  if (profile.lockMode === 'family') return 0;
  if (profile.lockMode === 'attribute') return 1;
  return 2;
}

function itemOccasions(item: IndexItem): OccasionTag[] {
  const cacheKey = requestItemKey(item);
  if (cacheKey && REQUEST_MEMO?.itemOccasions.has(cacheKey)) return REQUEST_MEMO.itemOccasions.get(cacheKey)!;
  const precomputed = readPrecomputedItemFeatures(item);
  const value = precomputed?.itemOccasions || (item.occasion_tags?.length ? item.occasion_tags : inferItemOccasionTags(item));
  if (cacheKey) REQUEST_MEMO?.itemOccasions.set(cacheKey, value);
  return value;
}

function crossSlotSignalPenalty(item: IndexItem, slot: CategoryMain): number {
  const hits = collectPhraseHits(itemText(item));
  if (!hits.length) return 0;
  const same = hits
    .filter((hit) => hit.slot === slot)
    .reduce((sum, hit) => sum + (hit.familyOnly ? 0.9 : 1.4), 0);
  const other = hits
    .filter((hit) => hit.slot !== slot)
    .reduce((sum, hit) => sum + (hit.familyOnly ? 1.1 : 1.8), 0);
  return Math.max(0, other - same * 0.55);
}

function personaSemanticSignals(intent: PromptIntent): { refined: number; classic: number; streetwear: number; sport: number } {
  const subjects = (intent.semantic_subjects || []).filter((subject) => subject.kind === 'persona');
  const profile = intent.persona_profile;
  const terms = [
    ...subjects.flatMap((subject) => [
      ...(subject.style_axes || []),
      ...(subject.silhouette_terms || []),
      ...(subject.palette_terms || []),
    ]),
    ...(profile?.style_axes || []),
    ...(profile?.silhouette_terms || []),
    ...(profile?.palette_terms || []),
  ].map((value) => normalizeText(value || '')).filter(Boolean);
  if (!terms.length) return { refined: 0, classic: 0, streetwear: 0, sport: 0 };
  let refined = 0;
  let classic = 0;
  let streetwear = 0;
  let sport = 0;
  for (const term of terms) {
    if (/\b(refined|formal|chic|elegant|polished|tailored|smart casual|preppy|business casual)\b/.test(term)) refined += 1;
    if (/\b(classic|minimal|minimalist|understated|timeless|clean|quiet luxury|old money)\b/.test(term)) classic += 1;
    if (/\b(streetwear|edgy|y2k|oversized|graphic|grunge|distressed|urban|techwear|avant garde|avant-garde|baggy|relaxed)\b/.test(term)) streetwear += 1;
    if (/\b(sporty|athletic|training|performance|running|gym|football|basketball|tennis)\b/.test(term)) sport += 1;
  }
  const scale = Math.max(1, terms.length);
  return {
    refined: Math.min(1, refined / scale),
    classic: Math.min(1, classic / scale),
    streetwear: Math.min(1, streetwear / scale),
    sport: Math.min(1, sport / scale),
  };
}

function personaSoftBrandTerms(intent: PromptIntent, slot?: CategoryMain): string[] {
  const profileTerms = intent.persona_profile?.soft_brand_priors || [];
  const subjectTerms = (intent.semantic_subjects || [])
    .filter((subject) => subject.kind === 'persona' && (!slot || subject.scope === 'global' || !subject.slots?.length || subject.slots.includes(slot)))
    .flatMap((subject) => subject.soft_brand_priors || []);
  return normalizeKeywordList([...profileTerms, ...subjectTerms]);
}

function personaPrefersSlot(intent: PromptIntent, slot: CategoryMain): boolean {
  const profilePreferences = intent.persona_profile?.category_preferences || [];
  if (profilePreferences.includes(slot)) return true;
  return (intent.semantic_subjects || [])
    .filter((subject) => subject.kind === 'persona' && (subject.scope === 'global' || !subject.slots?.length || subject.slots.includes(slot)))
    .some((subject) => (subject.category_preferences || []).includes(slot));
}

function styleTarget(intent: PromptIntent) {
  const vibes = new Set(intent.vibe_tags);
  const occasions = new Set(intent.occasion_tags);
  const settings = new Set(intent.setting_context);
  const activities = new Set(intent.activity_context);
  const dayparts = new Set(intent.daypart_context);
  const personaSignal = personaSemanticSignals(intent);
  const refined =
    vibes.has('formal') ||
    vibes.has('chic') ||
    vibes.has('preppy') ||
    occasions.has('smart_casual') ||
    occasions.has('formal') ||
    occasions.has('evening') ||
    settings.has('office') ||
    settings.has('formal_event') ||
    personaSignal.refined >= 0.34 ||
    personaSignal.classic >= 0.42;
  const streetwear =
    vibes.has('streetwear') ||
    vibes.has('techwear') ||
    vibes.has('y2k') ||
    vibes.has('edgy') ||
    personaSignal.streetwear >= 0.34;
  const lounge =
    vibes.has('comfy') ||
    occasions.has('lounge') ||
    occasions.has('sleepwear') ||
    activities.has('lounge') ||
    activities.has('sleep') ||
    settings.has('home');
  return {
    refined,
    classic: refined || vibes.has('preppy') || settings.has('campus') || personaSignal.classic >= 0.34,
    streetwear,
    sport: intent.sport_context !== 'none' || vibes.has('sporty') || personaSignal.sport >= 0.34,
    lounge,
    sleep: occasions.has('sleepwear') || activities.has('sleep') || dayparts.has('bedtime'),
    beach: settings.has('beach') || activities.has('beach'),
    resort: settings.has('resort'),
    nightlife: settings.has('nightlife') || activities.has('party') || activities.has('dinner') || occasions.has('evening') || dayparts.has('night'),
    office: settings.has('office') || activities.has('work'),
    travel: settings.has('travel') || activities.has('travel'),
    persona_street: personaSignal.streetwear > Math.max(0.28, personaSignal.refined + 0.08),
    monoPreferred: intent.required_categories.includes('mono') || intent.optional_categories.includes('mono'),
    paletteMode: intent.palette_mode,
    paletteColours: intent.global_palette_colours,
    paletteStrength: paletteStrength(intent.palette_mode, intent.palette_override_strength),
  };
}

function oldMoneyMensIntent(intent: PromptIntent): boolean {
  if (normalizeText(intent.target_gender || '') !== 'men') return false;
  const subjectHit = (intent.semantic_subjects || []).some((subject) =>
    subject.kind === 'style_archetype' &&
    /\b(old money|quiet luxury|stealth wealth)\b/.test(normalizeText(subject.label || '')),
  );
  if (subjectHit) return true;
  const vibes = new Set((intent.vibe_tags || []).map((entry) => normalizeText(entry)));
  const occasions = new Set((intent.occasion_tags || []).map((entry) => normalizeText(entry)));
  return (
    vibes.has('preppy') &&
    (vibes.has('formal') || vibes.has('chic') || vibes.has('minimal') || occasions.has('smart_casual')) &&
    !vibes.has('streetwear') &&
    normalizeText(intent.sport_context || 'none') === 'none'
  );
}

function refinedMenswearTopSubtype(sub: string): boolean {
  return [
    'shirt',
    'dress shirt',
    'oxford shirt',
    'polo',
    'sweater',
    'cardigan',
    'jumper',
    'blazer',
    'suit jacket',
    'turtleneck',
    'zip sweater',
  ].includes(canonicalizeSubtype(sub || ''));
}

function meaningfulIdentityTokens(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) =>
      token.length >= 4 &&
      !STOPWORDS.has(token) &&
      !GENERIC_GARMENT_TOKENS.has(token) &&
      !GENDER_DESCRIPTOR_TOKENS.has(token),
    );
}

function lowInformationRefinedMensTopPenalty(item: IndexItem): number {
  const sub = canonicalizeSubtype(item.sub || '');
  const text = itemText(item);
  const identityText = itemIdentityText(item);
  const informativeIdentity = meaningfulIdentityTokens(identityText);
  let evidence = 0;
  if (refinedMenswearTopSubtype(sub)) evidence += 1.1;
  if (/\b(oxford|dress shirt|button down|button-down|collared|polo|cardigan|sweater|jumper|knit|knitwear|crewneck|cashmere|merino|wool|quarter zip|quarter-zip|zip sweater|turtleneck|blazer|tailored)\b/.test(text)) evidence += 1.6;
  if ((item.style_markers || []).length) evidence += 0.55;
  if ((item.occasion_tags || []).some((entry) => ['smart_casual', 'formal', 'evening', 'office'].includes(normalizeText(entry)))) evidence += 0.85;
  if ((item.entityMeta || []).some((entry) => ['brand', 'material', 'sponsor'].includes(normalizeText(entry.type || '')))) evidence += 0.7;
  if (informativeIdentity.length >= 2) evidence += 1.15;
  else if (informativeIdentity.length === 1) evidence += 0.35;
  if (evidence >= 2.2) return 0;
  if (evidence >= 1.45) return -2.8;
  return -6.9;
}

function lowInformationRefinedBottomPenalty(item: IndexItem): number {
  const sub = canonicalizeSubtype(item.sub || '');
  const text = itemText(item);
  const identityText = itemIdentityText(item);
  const informativeIdentity = meaningfulIdentityTokens(identityText);
  const normalizedIdentity = normalizeText(identityText);
  const identityTokens = normalizedIdentity.split(/\s+/).filter(Boolean);
  const opaqueNumericIdentity =
    (identityTokens.length > 0 && identityTokens.every((token) => /^\d+$/.test(token))) ||
    /\b\d{6,}\b/.test(normalizedIdentity);
  let evidence = 0;
  if (['trousers', 'tailored trousers', 'dress pants', 'chinos'].includes(sub)) evidence += 1.2;
  if (/\b(trouser|trousers|slack|slacks|chino|chinos|linen|tailored|pleated|straight leg|straight-leg)\b/.test(text)) evidence += 1.4;
  if ((item.style_markers || []).length) evidence += 0.45;
  if ((item.occasion_tags || []).some((entry) => ['smart_casual', 'formal', 'evening', 'office'].includes(normalizeText(entry)))) evidence += 0.75;
  if ((item.entityMeta || []).some((entry) => ['brand', 'material'].includes(normalizeText(entry.type || '')))) evidence += 0.6;
  if (informativeIdentity.length >= 2) evidence += 1.05;
  else if (informativeIdentity.length === 1) evidence += 0.3;
  if (evidence >= 2.1) return 0;
  if (opaqueNumericIdentity) return -7.2;
  if (informativeIdentity.length === 0 && evidence < 1.6) return -5.9;
  if (evidence >= 1.35) return -2.8;
  return -5.2;
}

function oldMoneyMensTopTextScore(item: IndexItem): number {
  const text = itemText(item);
  const sub = canonicalizeSubtype(item.sub || '');
  let score = 0;
  if (refinedMenswearTopSubtype(sub)) score += 3.4;
  if (/\b(oxford|dress shirt|button down|button-down|collared|polo|cardigan|knit|knitwear|crewneck|cashmere|merino|wool|quarter zip|quarter-zip|zip sweater|turtleneck|blazer|tailored)\b/.test(text)) score += 2.6;
  if (/\b(overshirt|drizzler)\b/.test(text) && !/\b(workwear|utility|patch pocket|field jacket|carhartt)\b/.test(text)) score += 1.2;
  if (/\b(t-shirt|tshirt|tee)\b/.test(text)) score -= 5.1;
  if (/\b(tech ?fleece|fleece|track jacket|zip hoodie|athletic|training|sporty)\b/.test(text)) score -= 5.6;
  if (REFINED_MENS_TOP_FEMININE_RE.test(text)) score -= 7.4;
  if (/\b(graphic|logo|distressed|washed|jersey|hoodie|sweatshirt|windbreaker|bomber|field jacket|parka|leather jacket)\b/.test(text)) score -= 4.8;
  if (/\b(workwear|utility|patch pocket|carhartt|technical|cargo|leather jacket)\b/.test(text)) score -= 5.6;
  if (/\b(sport|training|football|basketball|track|running)\b/.test(text)) score -= 4.1;
  score += lowInformationRefinedMensTopPenalty(item);
  return score;
}

function itemSignals(item: IndexItem) {
  const cacheKey = requestItemKey(item);
  if (cacheKey && REQUEST_MEMO?.itemSignals.has(cacheKey)) return REQUEST_MEMO.itemSignals.get(cacheKey)!;
  const precomputed = readPrecomputedItemFeatures(item);
  const value = precomputed?.itemSignals || deriveStyleSignals(item);
  if (cacheKey) REQUEST_MEMO?.itemSignals.set(cacheKey, value);
  return value;
}

function hasAnyMarker(item: IndexItem, markers: string[]): boolean {
  const styleMarkers = item.style_markers || itemSignals(item).style_markers;
  return markers.some((marker) => styleMarkers.includes(marker));
}

const FEMININE_UNISEX_VETO_RE =
  /\b(ruffled|blouse|camisole|tie neck|tie-neck|crop top|plunge|pointelle|lace-detail|corset|sleeveless|tank top|bralette|bodysuit|self-portrait|patou|max mara ribbed polo top|pump|pumps|heel|heels|stiletto|stilettos|slingback|slingbacks|mary jane|mary janes|kitten heel|kitten heels|legging|leggings|tights|stockings|hosiery|jeggings)\b/;
const MASCULINE_UNISEX_VETO_RE =
  /\b(boxy fit|workwear|field jacket|bomber|cargo trousers|drizzler|rugged|combat boot|heavyweight tee|menswear)\b/;
const REFINED_MENS_TOP_FEMININE_RE =
  /\b(lace|lace-detail|ribbon|ruffled|blouse|camisole|tie neck|tie-neck|crop top|pointelle|corset|tank top|sleeveless|bow detail|bow-detail)\b/;

function normalizeEffectiveGender(value?: string | null): Gender | 'unisex' | null {
  const raw = normalizeText(String(value || ''));
  if (!raw) return null;
  if (/\b(unisex|all|any|gender neutral|gender-neutral)\b/.test(raw)) return 'unisex';
  if (/\b(men|mens|men s|man|male|boy|boys)\b/.test(raw)) return 'men';
  if (/\b(women|womens|women s|woman|female|girl|girls|lady|ladies)\b/.test(raw)) return 'women';
  return null;
}

function itemGenderSemanticText(item: IndexItem): string {
  const precomputed = readPrecomputedItemFeatures(item);
  return precomputed?.genderSemanticText || normalizeText(
    [
      item.name || '',
      item.sub || '',
      ...(item.style_markers || []),
      ...(item.occasion_tags || []),
      ...(item.entities || []),
    ].join(' '),
  );
}

function effectiveGenderCompatible(item: IndexItem, target: Gender | 'any'): boolean {
  if (target === 'any') return true;
  const cacheKey = `${requestItemKey(item) || item.id || 'item'}::${target}`;
  if (REQUEST_MEMO?.genderCompat.has(cacheKey)) return REQUEST_MEMO.genderCompat.get(cacheKey)!;
  let allowed = true;
  const normalizedGender = normalizeEffectiveGender(item.gender);
  if (normalizedGender === 'women') allowed = target === 'women';
  else if (normalizedGender === 'men') allowed = target === 'men';
  else {
    const flags = itemLexicalFlags(item);
    if (target === 'men' && flags.feminineUnisexVeto) allowed = false;
    if (target === 'women' && flags.masculineUnisexVeto) allowed = false;
  }
  REQUEST_MEMO?.genderCompat.set(cacheKey, allowed);
  return allowed;
}

function itemHasBrand(item: IndexItem, brand: string): boolean {
  return (item.entityMeta || [])
    .filter((entry) => entry.type === 'brand')
    .some((entry) => itemHasEntity(item, entry.text) && itemHasEntity(item, brand));
}

function itemHasTeam(item: IndexItem, team: string): boolean {
  if ((item.sportMeta?.teams || []).some((entry) => hasWholeWord(normalizeText(entry), team))) return true;
  if ((item.entities || []).some((entry) => hasWholeWord(normalizeText(entry), team))) return true;
  if ((item.identity_entities || []).some((entry) => hasWholeWord(normalizeText(entry), team))) return true;
  if (hasWholeWord(itemText(item), team)) return true;
  return (item.entityMeta || []).some((entry) => entry.type === 'team' && itemHasEntity(item, team));
}

function itemTeamHitCount(item: IndexItem, teams: string[]): number {
  return teams.filter((team) => itemHasTeam(item, team)).length;
}

function itemHasCompetingTeam(item: IndexItem, teams: string[]): boolean {
  const normalizedTargets = teams.map((team) => normalizeText(team)).filter(Boolean);
  if (!normalizedTargets.length) return false;
  const candidates = [
    ...(Array.isArray(item.sportMeta?.teams) ? item.sportMeta.teams : []),
    ...((item.entityMeta || []).filter((entry) => entry.type === 'team').map((entry) => entry.text || '')),
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);
  return candidates.some((candidate) => !normalizedTargets.some((team) => hasWholeWord(candidate, team) || hasWholeWord(team, candidate)));
}

function applyGlobalNegatives(item: IndexItem, intent: PromptIntent): boolean {
  const cacheKey = requestItemKey(item) || item.id || 'item';
  if (REQUEST_MEMO?.globalNegative.has(cacheKey)) return REQUEST_MEMO.globalNegative.get(cacheKey)!;
  const negatives = intent.negative_constraints;
  const allowed = !(
    negatives.excluded_categories.includes(item.category) ||
    (negatives.non_sport && (
      (item.sportMeta?.sport || 'none') !== 'none' ||
      (item.category === 'shoes' && (isAthleticShoeSubtype(item.sub) || itemHasKeyword(item, 'sneaker') || itemHasKeyword(item, 'trainer')))
    )) ||
    (negatives.no_logos && hasAnyMarker(item, ['logo', 'graphic'])) ||
    negatives.excluded_subs.some((sub) => slotSubtypeMatch(item, sub)) ||
    negatives.excluded_keywords.some((keyword) => itemHasKeyword(item, keyword)) ||
    negatives.excluded_brands.some((brand) => itemHasBrand(item, brand)) ||
    negatives.excluded_teams.some((team) => itemHasTeam(item, team))
  );
  REQUEST_MEMO?.globalNegative.set(cacheKey, allowed);
  return allowed;
}

function sportFootwearText(item: IndexItem): string {
  return itemText(item);
}

function sportFootwearSignal(item: IndexItem, sport: Sport): { boost: number; penalty: number } {
  const sub = canonicalizeSubtype(item.sub || '');
  const flags = itemLexicalFlags(item);
  const metaSport = item.sportMeta?.sport || 'none';
  let boost = 0;
  let penalty = 0;

  if (metaSport !== 'none' && metaSport !== sport) penalty += 1.8;
  if (isFormalSubtype(sub) || isOpenCasualShoeSubtype(sub)) penalty += 1.2;

  if (sport === 'football') {
    const explicitFootball = flags.footballFootwearCue;
    if (metaSport === 'football') boost += 3.2;
    if (sub === 'boots') boost += 2.2;
    if (explicitFootball) boost += 3.4;
    if (!explicitFootball && sub !== 'boots') penalty += isAthleticShoeSubtype(sub) ? 1.6 : 3.2;
  } else if (sport === 'basketball') {
    const explicitBasketball = flags.basketballFootwearCue;
    const premiumBasketball = flags.premiumBasketballCue;
    if (metaSport === 'basketball') boost += explicitBasketball ? 2.2 : 0.75;
    if (explicitBasketball) boost += premiumBasketball ? 4.2 : 2.4;
    if (isAthleticShoeSubtype(sub)) boost += explicitBasketball ? 1.0 : 0.18;
    if (flags.ruggedBootCue || flags.explicitBootCue) penalty += premiumBasketball ? 0.6 : 5.4;
    if (!explicitBasketball && metaSport !== 'basketball') penalty += isAthleticShoeSubtype(sub) ? 1.2 : 2.9;
    if (!explicitBasketball && metaSport === 'basketball') penalty += isAthleticShoeSubtype(sub) ? 1.8 : 3.4;
  } else if (sport === 'running') {
    const explicitRunning = flags.runningFootwearCue;
    if (metaSport === 'running') boost += 3.0;
    if (explicitRunning) boost += 2.6;
    if (isAthleticShoeSubtype(sub)) boost += 1.0;
    if (!explicitRunning && metaSport !== 'running') penalty += isAthleticShoeSubtype(sub) ? 0.8 : 2.4;
  } else if (sport === 'tennis') {
    const explicitTennis = flags.tennisFootwearCue;
    if (metaSport === 'tennis') boost += 3.0;
    if (explicitTennis) boost += 2.6;
    if (isAthleticShoeSubtype(sub)) boost += 0.9;
    if (!explicitTennis && metaSport !== 'tennis') penalty += isAthleticShoeSubtype(sub) ? 0.8 : 2.2;
  } else if (sport === 'gym') {
    const explicitTraining = flags.gymTrainingFootwearCue;
    if (metaSport === 'gym') boost += 2.8;
    if (explicitTraining) boost += 2.2;
    if (isAthleticShoeSubtype(sub)) boost += 0.9;
    if (!explicitTraining && metaSport !== 'gym') penalty += isAthleticShoeSubtype(sub) ? 0.6 : 2.0;
  } else if (sport !== 'none') {
    if (metaSport === sport) boost += 2.8;
    if (isAthleticShoeSubtype(sub)) boost += 0.8;
  }

  return { boost, penalty };
}

function buildSymbolicSlotContext(
  slot: CategoryMain,
  intent: PromptIntent,
  slotConstraint: SlotConstraintProfile | ResolvedSlotConstraint,
): SymbolicSlotContext {
  return {
    slotConstraint,
    slotConstraintKey: slotConstraintCacheKey(slotConstraint),
    target: styleTarget(intent),
    colours: effectivePaletteColoursForSlot(intent, slot, slotConstraint),
    occasions: uniq([...intent.occasion_tags, ...slotConstraint.occasion_hints]),
    vibes: uniq([...intent.vibe_tags, ...slotConstraint.vibe_hints]),
    entities: uniq([...intent.brand_focus, ...intent.team_focus, ...slotConstraint.preferred_entities]),
    variantMode: (slotConstraint as Partial<SlotConstraintProfile>).variantMode || 'none',
    variantGroupHints: (slotConstraint as Partial<SlotConstraintProfile>).variantGroupHints || [],
    womenDateRefinedFootwear:
      slot === 'shoes' &&
      intent.target_gender === 'women' &&
      intent.sport_context === 'none' &&
      (
        intent.activity_context.includes('dinner') ||
        intent.occasion_tags.includes('evening') ||
        intent.occasion_tags.includes('date_night') ||
        intent.vibe_tags.includes('chic') ||
        intent.vibe_tags.includes('formal')
      ),
    oldMoneyMens: slot === 'top' && oldMoneyMensIntent(intent),
  };
}

function symbolicItemScore(
  item: IndexItem,
  slot: CategoryMain,
  intent: PromptIntent,
  slotConstraintOverride?: SlotConstraintProfile,
  contextOverride?: SymbolicSlotContext,
): number {
  const slotConstraint = slotConstraintOverride || intent.slot_constraints[slot];
  const context = contextOverride || buildSymbolicSlotContext(slot, intent, slotConstraint);
  const cacheKey = `${requestItemKey(item) || item.id || 'item'}::${slot}::${context.slotConstraintKey}`;
  if (REQUEST_MEMO?.symbolicScore.has(cacheKey)) return REQUEST_MEMO.symbolicScore.get(cacheKey)!;
  const target = context.target;
  const signals = itemSignals(item);
  const colours = context.colours;
  const occasions = context.occasions;
  const vibes = context.vibes;
  const entities = context.entities;
  const variantMode = context.variantMode;
  const variantGroupHints = context.variantGroupHints;
  const inVariantGroup = !!(item.variant_group_key && variantGroupHints.includes(item.variant_group_key));
  const itemTextValue = itemText(item);
  const flags = itemLexicalFlags(item);
  const womenDateRefinedFootwear = context.womenDateRefinedFootwear;
  let score = 0;

  if (slotConstraint.preferred_subs.length) {
    const exact = slotConstraint.preferred_subs.some((sub) => canonicalizeSubtype(sub) === canonicalizeSubtype(item.sub || ''));
    const family = slotConstraint.preferred_subs.some((sub) => slotSubtypeMatch(item, sub));
    if (exact) score += 4.8;
    else if (family) score += 2.8;
    else if (inVariantGroup) score += 1.4;
    else score -= 4.5;
  }
  if (slotConstraint.required_keywords.length) {
    const keywordHits = slotConstraint.required_keywords.filter((keyword) => itemHasKeyword(item, keyword)).length;
    score += keywordHits * 2.2;
    if (!keywordHits) score -= 3.2;
  }
  if (entities.length) {
    const entityHits = entities.filter((entity) => itemHasEntity(item, entity)).length;
    score += entityHits * 2.0;
  }
  const personaBrandTerms = personaSoftBrandTerms(intent, slot);
  if (personaBrandTerms.length) {
    const personaBrandHits = personaBrandTerms.filter((term) => itemHasEntity(item, term) || itemHasKeyword(item, term)).length;
    if (personaBrandHits) score += Math.min(1.35, personaBrandHits * 0.72);
  }
  if (personaPrefersSlot(intent, slot)) score += 0.22;
  if (intent.team_focus.length) {
    const teamHits = itemTeamHitCount(item, intent.team_focus);
    if (teamHits) {
      const teamWeight = slot === 'top' ? 5.8 : slot === 'bottom' ? 4.6 : slot === 'shoes' ? 2.1 : 3.2;
      score += teamHits * teamWeight;
      if ((item.sportMeta?.sport || 'none') === intent.sport_context && intent.sport_context !== 'none') score += 0.9;
      if (intent.sport_context === 'football') {
        const footballText = itemText(item);
        if (slot === 'top' && /\bfootball\b|\bsoccer\b|\bjersey\b|\bkit\b|\bshirt\b/.test(footballText)) score += 3.4;
        if (slot === 'bottom' && canonicalizeSubtype(item.sub || '') === 'shorts') score += 4.2;
        if (slot === 'bottom' && !/\bshorts?\b/.test(footballText)) score -= 3.4;
      } else if (intent.sport_context === 'basketball') {
        const basketballText = itemText(item);
        if (slot === 'top' && /\bbasketball\b|\bnba\b|\bjersey\b|\bshirt\b/.test(basketballText)) score += 3.1;
        if (slot === 'bottom' && canonicalizeSubtype(item.sub || '') === 'shorts') score += 4.4;
        if (slot === 'bottom' && /\bjogger|joggers\b/.test(basketballText)) score += 1.2;
        if (slot === 'bottom' && ['jeans', 'trousers', 'dress pants', 'tailored trousers'].includes(canonicalizeSubtype(item.sub || ''))) score -= 3.6;
      }
    } else if (intent.sport_context !== 'none' && itemHasCompetingTeam(item, intent.team_focus)) {
      score -= slot === 'top' ? 5.4 : slot === 'bottom' ? 4.2 : 1.8;
    }
  }
  if (colours.length) {
    const colourHits = colours.filter((colour) => itemHasColour(item, colour)).length;
    score += colourHits * 1.8;
    if (!colourHits) score -= 2.5;
  }
  if (target.paletteMode === 'colorful') {
    const profile = itemColourProfile(item);
    score += profile.chromatic.length ? Math.min(1.8, profile.chromatic.length * 0.7) : -1.4;
  } else if (target.paletteMode === 'muted') {
    const profile = itemColourProfile(item);
    score += profile.neutralCount ? 0.8 : 0;
    if (profile.chromatic.some((colour) => {
      const meta = colourProfile(colour);
      return meta?.chroma === 'high';
    })) score -= 1.2;
  } else if ((target.paletteMode === 'monochrome' || target.paletteMode === 'tonal') && target.paletteColours.length) {
    const paletteHits = target.paletteColours.filter((colour) => itemHasColour(item, colour)).length;
    const profile = itemColourProfile(item);
    const foreignFamilies = profile.families.filter((colour) => !target.paletteColours.includes(colour));
    if (paletteHits) {
      score += target.paletteStrength * (
        intent.palette_override_strength === 'hard'
          ? (target.paletteMode === 'monochrome' ? 4.4 : 3.4)
          : 2.6
      );
    } else if (target.paletteMode === 'monochrome' && intent.palette_override_strength === 'hard') {
      score -= 4.2;
    }
    if (foreignFamilies.length) {
      const foreignPenalty =
        target.paletteMode === 'monochrome' && intent.palette_override_strength === 'hard'
          ? 7.2
          : target.paletteMode === 'monochrome'
            ? 0.7
            : 0.35;
      score -= foreignFamilies.length * foreignPenalty;
    } else if (paletteHits && target.paletteMode === 'monochrome' && intent.palette_override_strength === 'hard') {
      score += 1.8;
    }
  }
  if (vibes.length) {
    score += vibes.filter((vibe) => item.vibes.includes(vibe)).length * 0.9;
  }
  if (occasions.length) {
    score += occasions.filter((occasion) => itemOccasions(item).includes(occasion)).length * 1.0;
  }
  if (intent.fit_preference && intent.fit_preference !== 'mixed') {
    score += item.fit === intent.fit_preference ? 0.8 : -0.2;
  }
  score += ((item.repair_confidence ?? 0.55) - 0.55) * 1.2;

  if (slotConstraint.excluded_subs.some((sub) => slotSubtypeMatch(item, sub))) score -= 6;
  if (slotConstraint.excluded_keywords.some((keyword) => itemHasKeyword(item, keyword))) score -= 6;
  if ((slotConstraint.excluded_entities || []).some((entity) => itemHasEntity(item, entity))) score -= 8;
  if ((slotConstraint.excluded_colours || []).some((colour) => itemHasColour(item, colour))) score -= 8;
  score -= crossSlotSignalPenalty(item, slot) * 2.2;

  if (variantMode !== 'none' && variantGroupHints.length) {
    if (inVariantGroup) {
      score += variantMode === 'locked' ? 5.2 : 4.1;
    } else {
      score -= variantMode === 'locked' ? 8.5 : 5.6;
    }
  }

  if (intent.sport_context !== 'none') {
    if ((item.sportMeta?.sport || 'none') === intent.sport_context) score += 1.4;
    else if (slot === 'shoes' && intent.sport_context === 'football' && canonicalizeSubtype(item.sub || '') === 'boots') score += 1.4;
    else if ((item.sportMeta?.sport || 'none') !== 'none') score -= 0.8;
    if (slot === 'shoes') {
      const footwearSignal = sportFootwearSignal(item, intent.sport_context);
      score += footwearSignal.boost;
      score -= footwearSignal.penalty;
      if (intent.sport_context === 'basketball') {
        if (flags.premiumBasketballCue) score += 4.2;
        if (!flags.basketballFootwearCue && flags.explicitBootCue) score -= 4.8;
      }
      if (intent.sport_context === 'football') {
        if (flags.footballFootwearCue) score += 3.6;
      }
    } else if (intent.sport_context === 'basketball') {
      if (slot === 'top') {
        if (flags.basketballTopCue) score += 2.8;
        else if (['shirt', 'dress shirt', 'oxford shirt', 'blazer', 'suit jacket'].includes(canonicalizeSubtype(item.sub || ''))) score -= 1.6;
      }
      if (slot === 'bottom') {
        if (flags.basketballBottomShortsCue) score += 3.8;
        else if (flags.basketballBottomJoggerCue) score += 1.1;
        if (flags.basketballBottomTailoredCue) score -= 3.0;
      }
    } else if (intent.sport_context === 'football') {
      if (slot === 'top') {
        if (flags.footballTopCue) score += 2.9;
      }
      if (slot === 'bottom') {
        if (flags.basketballBottomShortsCue) score += 3.8;
        if (!flags.footballBottomCue && flags.basketballBottomTailoredCue) score -= 3.0;
      }
    } else if (intent.sport_context === 'gym') {
      if (slot === 'top') {
        if (flags.gymTopAthleticCue) score += 2.8;
        if (flags.gymTopBasicCue) score += 1.8;
        if (flags.gymTopFormalCue) score -= 3.6;
        if (flags.gymTopOuterwearCue) score -= 1.6;
      }
      if (slot === 'bottom') {
        if (flags.gymBottomActiveCue) score += 2.4;
        if (flags.gymBottomTailoredCue) score -= 3.6;
      }
    }
  }

  if (target.refined) {
    score += (signals.formality_score * 3.0) + (signals.cleanliness_score * 2.4) + (signals.classic_score * 1.8) - (signals.streetwear_score * 0.6);
    if ((item.sportMeta?.sport || 'none') !== 'none' && intent.sport_context === 'none') score -= 3.2;
    if (slot === 'top' && flags.refinedTopTeeCue) score -= 4.1;
    if (slot === 'top' && flags.refinedTopTechnicalCue) score -= 4.8;
    if (slot === 'top' && flags.refinedTopJerseyCue) score -= 6.2;
    if (slot === 'top' && (item.entityMeta || []).some((entry) => ['team', 'sponsor'].includes(normalizeText(entry.type || '')))) score -= 7.4;
    if (slot === 'top' && ((item.vibes || []).some((entry) => ['sporty', 'streetwear'].includes(normalizeText(entry))) || signals.streetwear_score >= 0.48 || signals.sportiness_score >= 0.42)) score -= 4.4;
    if (slot === 'top' && normalizeText(intent.target_gender || '') === 'men' && flags.refinedMensTopFeminine) score -= 6.8;
    if (slot === 'top' && normalizeText(intent.target_gender || '') === 'men') score += lowInformationRefinedMensTopPenalty(item) * 0.42;
    if (slot === 'top' && !hasAnyMarker(item, ['graphic', 'logo']) && ['shirt', 'dress shirt', 'oxford shirt', 'polo', 'sweater', 'cardigan', 'blazer', 'suit jacket', 'zip sweater', 'turtleneck'].includes(canonicalizeSubtype(item.sub || ''))) score += 2.1;
    if (slot === 'bottom' && hasAnyMarker(item, ['distressed', 'camouflage', 'technical', 'embellished'])) score -= 4.5;
    if (slot === 'bottom' && (itemHasKeyword(item, 'cargo') || itemHasKeyword(item, 'track') || itemHasKeyword(item, 'jogger') || itemHasKeyword(item, 'drawstring') || itemHasKeyword(item, 'ripped') || itemHasKeyword(item, 'distressed'))) score -= 5.2;
    if (slot === 'bottom' && ((item.vibes || []).some((entry) => ['sporty', 'streetwear', 'techwear', 'edgy'].includes(normalizeText(entry))) || signals.streetwear_score >= 0.44 || signals.sportiness_score >= 0.36)) score -= 2.8;
    if (slot === 'bottom' && (item.entityMeta || []).some((entry) => ['team', 'sponsor'].includes(normalizeText(entry.type || '')))) score -= 4.4;
    if (slot === 'bottom') score += lowInformationRefinedBottomPenalty(item);
    if (slot === 'bottom' && ['tailored trousers', 'dress pants', 'trousers', 'jeans'].includes(canonicalizeSubtype(item.sub || ''))) score += 1.1;
    if (slot === 'shoes' && (isOpenCasualShoeSubtype(item.sub) || isAthleticShoeSubtype(item.sub))) score -= 4.5;
    if (slot === 'shoes' && isHeelFamilySubtype(item.sub) && intent.target_gender !== 'women' && !intent.required_categories.includes('mono')) score -= 4;
    if (slot === 'shoes' && ['loafers', 'boat shoes', 'oxford/derby', 'formal shoes'].includes(canonicalizeSubtype(item.sub || ''))) score += 1.2;
  }
  if (target.classic) {
    score += (signals.classic_score * 2.0) + (signals.cleanliness_score * 0.9) - (signals.streetwear_score * 0.25);
    if (slot === 'top' && ['shirt', 'dress shirt', 'oxford shirt', 'polo', 'cardigan', 'sweater', 'blazer'].includes(canonicalizeSubtype(item.sub || ''))) score += 1.1;
    if (slot === 'bottom' && ['tailored trousers', 'dress pants', 'trousers', 'jeans'].includes(canonicalizeSubtype(item.sub || ''))) score += 1.0;
    if (slot === 'shoes' && ['loafers', 'boat shoes', 'oxford/derby', 'formal shoes'].includes(canonicalizeSubtype(item.sub || ''))) score += 1.1;
  }
  if (context.oldMoneyMens) {
    score += oldMoneyMensTopTextScore(item);
  }
  if (target.streetwear) {
    score += (signals.streetwear_score * 2.8) - (signals.formality_score * 0.25);
    if (target.persona_street) score += (signals.streetwear_score * 0.8) + (hasAnyMarker(item, ['graphic', 'logo', 'distressed']) ? 0.8 : 0);
    if (slot === 'shoes' && isFormalSubtype(item.sub) && !slotConstraint.preferred_subs.length) score -= 2.2;
  }
  if (target.sport) {
    if ((item.sportMeta?.sport || 'none') !== 'none') score += 1.8;
    score += signals.sportiness_score * 2.2;
    if (slot === 'shoes' && (isAthleticShoeSubtype(item.sub) || canonicalizeSubtype(item.sub || '') === 'boots')) score += 1.6;
    if (slot === 'shoes' && isHeelFamilySubtype(item.sub)) score -= 5;
    if (intent.sport_context === 'football') {
      const footballText = itemText(item);
      if (slot === 'top') {
        if (/\bfootball\b|\bsoccer\b|\bjersey\b|\bkit\b/.test(footballText) || (item.sportMeta?.sport || 'none') === 'football') score += 2.6;
      }
      if (slot === 'bottom') {
        if (canonicalizeSubtype(item.sub || '') === 'shorts') score += 2.8;
        if (/\bfootball\b|\bsoccer\b|\bkit\b/.test(footballText)) score += 1.8;
        if (!/\bfootball\b|\bsoccer\b|\bkit\b/.test(footballText) && ['jeans', 'trousers', 'dress pants', 'tailored trousers'].includes(canonicalizeSubtype(item.sub || ''))) score -= 2.6;
      }
      if (slot === 'shoes' && canonicalizeSubtype(item.sub || '') === 'boots') score += 1.2;
    }
  }
  if (target.lounge) {
    if (isLoungeSubtype(item.sub) || isSleepwearSubtype(item.sub) || itemOccasions(item).some((occasion) => occasion === 'lounge' || occasion === 'sleepwear')) score += 3.2;
    else if (slot === 'shoes' && !isOpenCasualShoeSubtype(item.sub)) score -= 2.0;
    score += signals.comfort_score * 1.8;
  }
  if (target.sleep) {
    if (isSleepwearSubtype(item.sub) || itemOccasions(item).includes('sleepwear')) score += 3.5;
    else if (slot === 'top' || slot === 'bottom') score -= 2.8;
    if (slot === 'shoes' && isOpenCasualShoeSubtype(item.sub)) score += 1.4;
    if (slot === 'shoes' && !isOpenCasualShoeSubtype(item.sub) && !isLoungeSubtype(item.sub)) score -= 3.2;
    score += signals.comfort_score * 1.6;
  }
  if (target.beach || target.resort) {
    score += signals.openness_score * 2.4;
    if (slot === 'top' && ['shirt', 'polo', 'tshirt'].includes(canonicalizeSubtype(item.sub || ''))) score += 0.9;
    if (slot === 'bottom' && ['shorts', 'trousers', 'jeans'].includes(canonicalizeSubtype(item.sub || ''))) score += canonicalizeSubtype(item.sub || '') === 'shorts' ? 1.3 : 0.2;
    if (slot === 'shoes' && isOpenCasualShoeSubtype(item.sub)) score += 2.1;
    if (slot === 'shoes' && (canonicalizeSubtype(item.sub || '') === 'boots' || isFormalSubtype(item.sub))) score -= 3.4;
    if (hasAnyMarker(item, ['outerwear', 'technical'])) score -= 1.4;
  }
  if (target.nightlife) {
    score += (signals.formality_score * 1.4) + (signals.cleanliness_score * 0.8);
    if (slot === 'mono' && isFormalSubtype(item.sub)) score += 1.2;
    if (slot === 'shoes' && (isHeelFamilySubtype(item.sub) || isFormalSubtype(item.sub))) score += 1.5;
    if (slot === 'shoes' && isAthleticShoeSubtype(item.sub)) score -= 2.2;
  }
  if (womenDateRefinedFootwear) {
    if (isHeelFamilySubtype(item.sub) || /\bpump|pumps|heel|heels|slingback|mary jane|kitten heel|ankle boot|ankle boots|mule|mules|sandal|sandals\b/.test(itemTextValue)) score += 4.8;
    if (/\bloafer|loafers|boat shoe|boat shoes|oxford|oxfords|derby|derbies\b/.test(itemTextValue)) score -= 2.1;
    if (isAthleticShoeSubtype(item.sub)) score -= 3.4;
  }
  if (target.office) {
    score += (signals.classic_score * 1.8) + (signals.cleanliness_score * 1.2);
    if (slot === 'top' && ['shirt', 'dress shirt', 'oxford shirt', 'polo', 'cardigan', 'blazer', 'sweater'].includes(canonicalizeSubtype(item.sub || ''))) score += 1.1;
    if (slot === 'bottom' && ['tailored trousers', 'dress pants', 'trousers'].includes(canonicalizeSubtype(item.sub || ''))) score += 1.0;
    if (slot === 'shoes' && ['loafers', 'boat shoes', 'oxford/derby', 'formal shoes'].includes(canonicalizeSubtype(item.sub || ''))) score += 1.2;
  }
  if (target.travel) {
    score += (signals.comfort_score * 1.1) + (signals.cleanliness_score * 0.8);
    if (slot === 'shoes' && (isAthleticShoeSubtype(item.sub) || canonicalizeSubtype(item.sub || '') === 'boots')) score += 0.8;
  }

  if (slot === 'bottom' && canonicalizeSubtype(item.sub || '') === 'jeans' && itemHasColour(item, 'blue')) score += 0.5;
  if (slot === 'shoes' && canonicalizeSubtype(item.sub || '') === 'boots') score += 0.25;
  if (slot === 'mono' && isFormalSubtype(item.sub)) score += 0.4;

  REQUEST_MEMO?.symbolicScore.set(cacheKey, score);
  return score;
}

function itemColourProfile(item: IndexItem | undefined): ItemColourProfile {
  if (!item) {
    return {
      primary: null,
      accents: [],
      neutrals: [],
      chromatic: [],
      families: [],
      warmCount: 0,
      coolCount: 0,
      neutralCount: 0,
      canonical: [],
    };
  }
  const cacheKey = requestItemKey(item);
  if (cacheKey && REQUEST_MEMO?.itemColourProfile.has(cacheKey)) return REQUEST_MEMO.itemColourProfile.get(cacheKey)!;
  const precomputed = readPrecomputedItemFeatures(item);
  const value: ItemColourProfile = precomputed?.itemColourProfile || (() => {
    const families = uniqueColours(item.colours || []);
    const canonical = families
      .map((colour) => {
        const profile = colourProfile(colour);
        return profile ? { colour, profile } : null;
      })
      .filter((entry): entry is { colour: Colour; profile: NonNullable<ReturnType<typeof colourProfile>> } => !!entry);
    const neutrals = canonical.filter((entry) => entry.profile.neutral).map((entry) => entry.colour);
    const chromatic = canonical.filter((entry) => !entry.profile.neutral).map((entry) => entry.colour);
    const primary = chromatic[0] || families[0] || null;
    return {
      primary,
      accents: chromatic.slice(0, 2),
      neutrals,
      chromatic,
      families,
      warmCount: canonical.filter((entry) => entry.profile.temperature === 'warm' && !entry.profile.neutral).length,
      coolCount: canonical.filter((entry) => entry.profile.temperature === 'cool' && !entry.profile.neutral).length,
      neutralCount: neutrals.length,
      canonical,
    };
  })();
  if (cacheKey) REQUEST_MEMO?.itemColourProfile.set(cacheKey, value);
  return value;
}

function hueDistance(left: Colour, right: Colour): number {
  const leftHue = colourProfile(left)?.hue;
  const rightHue = colourProfile(right)?.hue;
  if (!Number.isFinite(leftHue as number) || !Number.isFinite(rightHue as number)) return 180;
  const raw = Math.abs(Number(leftHue) - Number(rightHue));
  return Math.min(raw, 360 - raw);
}

function pairColourRelation(left: Colour, right: Colour): number {
  if (left === right) return 1.35;
  if (isNeutralColour(left) && isNeutralColour(right)) return 1.0;
  if (isNeutralColour(left) || isNeutralColour(right)) return 0.88;
  const distance = hueDistance(left, right);
  if (distance <= 34) return 1.14;
  if (distance <= 70) return 0.92;
  if (distance >= 150 && distance <= 210) return 0.78;
  if (distance >= 95 && distance < 150) return 0.18;
  return 0.44;
}

function colourHarmony(a: IndexItem, b: IndexItem): number {
  const aColours = uniqueColours(a.colours || []);
  const bColours = uniqueColours(b.colours || []);
  if (!aColours.length || !bColours.length) return 0;
  let best = 0;
  for (const left of aColours) {
    for (const right of bColours) {
      best = Math.max(best, pairColourRelation(left, right));
    }
  }
  return best;
}

function slotColourLocked(intent: PromptIntent, slot: CategoryMain): boolean {
  if (intent.slot_palette_locked?.[slot]) return true;
  if (
    intent.palette_override_strength === 'hard' &&
    intent.global_palette_colours.length &&
    (intent.palette_mode === 'monochrome' || intent.palette_mode === 'tonal')
  ) {
    return true;
  }
  return false;
}

function tonalSupportMatch(item: IndexItem | undefined, targets: Colour[]): boolean {
  if (!item || !targets.length) return false;
  const profile = itemColourProfile(item);
  if (!profile.families.length) return false;
  return targets.some((target) => {
    if (profile.families.includes(target)) return true;
    return profile.families.some((colour) => {
      if (isNeutralColour(target) && isNeutralColour(colour)) return true;
      if (isNeutralColour(target) || isNeutralColour(colour)) return false;
      return hueDistance(target, colour) <= 34;
    });
  });
}

function paletteSignature(outfit: Outfit): string {
  const chromatic = uniq(outfitItems(outfit).flatMap((item) => itemColourProfile(item).chromatic)).sort();
  const neutrals = uniq(outfitItems(outfit).flatMap((item) => itemColourProfile(item).neutrals)).sort();
  return `c:${chromatic.join('+') || 'none'}|n:${neutrals.join('+') || 'none'}`;
}

function evaluateOutfitPalette(
  outfit: Outfit,
  intent: PromptIntent,
): PaletteEvaluation {
  const items = SLOT_ORDER
    .map((slot) => ({ slot, item: outfit[slot] }))
    .filter((entry): entry is { slot: CategoryMain; item: IndexItem } => !!entry.item);
  const chromaticFamilies = uniq(items.flatMap((entry) => itemColourProfile(entry.item).chromatic)).sort();
  const neutralFamilies = uniq(items.flatMap((entry) => itemColourProfile(entry.item).neutrals)).sort();
  const mode = intent.palette_mode;
  let score = 0;

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const left = items[i];
      const right = items[j];
      const leftProfile = itemColourProfile(left.item);
      const rightProfile = itemColourProfile(right.item);
      if (!leftProfile.primary || !rightProfile.primary) continue;
      const relation = pairColourRelation(leftProfile.primary, rightProfile.primary);
      const lockedPair = slotColourLocked(intent, left.slot) || slotColourLocked(intent, right.slot);
      if (relation >= 0.75) score += relation * 0.36;
      else if (!lockedPair) score += (relation - 0.42) * 0.44;
    }
  }

  if (mode === 'colorful') {
    if (chromaticFamilies.length >= 2 && chromaticFamilies.length <= 3) score += 3.0;
    else if (chromaticFamilies.length === 1) score += 0.6;
    else if (!chromaticFamilies.length) score -= 3.2;
    else score -= 1.9;
    if (neutralFamilies.length) score += 0.55;
    if (chromaticFamilies.length >= 4) score -= 1.4;
  } else if (mode === 'muted') {
    score += neutralFamilies.length * 0.55;
    if (!chromaticFamilies.length) score += 1.1;
    for (const colour of chromaticFamilies) {
      const meta = colourProfile(colour);
      if (meta?.chroma === 'high') score -= 0.9;
      if (meta?.chroma === 'muted' || meta?.chroma === 'medium') score += 0.18;
    }
  } else if (mode === 'monochrome' || mode === 'tonal') {
    const targets = intent.global_palette_colours;
    if (targets.length) {
      for (const { slot, item } of items) {
        const profile = itemColourProfile(item);
        const foreignFamilies = profile.families.filter((colour) => !targets.includes(colour));
        if (tonalSupportMatch(item, targets)) {
          score += mode === 'monochrome'
            ? (intent.palette_override_strength === 'hard' ? 2.25 : 1.35)
            : (intent.palette_override_strength === 'hard' ? 1.55 : 1.05);
        } else {
          score -= intent.palette_override_strength === 'hard'
            ? (slotColourLocked(intent, slot) ? 4.6 : 1.55)
            : (!slotColourLocked(intent, slot) ? 0.75 : 0);
        }
        if (foreignFamilies.length) {
          score -= foreignFamilies.length * (
            mode === 'monochrome' && intent.palette_override_strength === 'hard'
              ? 4.4
              : mode === 'monochrome'
                ? 0.28
                : 0.12
          );
        } else if (mode === 'monochrome' && intent.palette_override_strength === 'hard' && tonalSupportMatch(item, targets)) {
          score += 0.9;
        }
      }
    }
    if (items.length >= 3) {
      const coherentSlots = items.filter(({ item }) => tonalSupportMatch(item, targets)).length;
      if (coherentSlots >= Math.max(2, items.length - 1)) {
        score += mode === 'monochrome'
          ? (intent.palette_override_strength === 'hard' ? 0.85 : 0.45)
          : (intent.palette_override_strength === 'hard' ? 0.5 : 0.28);
      }
    }
    if (chromaticFamilies.length <= 1) score += mode === 'monochrome'
      ? (intent.palette_override_strength === 'hard' ? 2.4 : 1.6)
      : 1.2;
    else if (chromaticFamilies.length === 2 && mode === 'tonal') score += 0.2;
    else score -= mode === 'monochrome'
      ? (intent.palette_override_strength === 'hard' ? 3.4 : 1.8)
      : 1.0;
  } else {
    if (chromaticFamilies.length >= 4 && !neutralFamilies.length) score -= 1.8;
    if (chromaticFamilies.length === 2 && neutralFamilies.length) score += 0.45;
    if (chromaticFamilies.length <= 1 && neutralFamilies.length >= 1) score += 0.35;
  }

  const target = styleTarget(intent);
  if (target.refined || target.classic || target.office) {
    if (chromaticFamilies.length >= 3) score -= 1.8;
    if (neutralFamilies.length) score += 0.6;
  }
  if (target.streetwear) {
    if (chromaticFamilies.length >= 2 && chromaticFamilies.length <= 3) score += 0.55;
    if (chromaticFamilies.length >= 4) score -= 0.55;
  }
  if (target.beach || target.resort) {
    const airy = chromaticFamilies.filter((colour) => ['blue', 'green', 'white', 'beige', 'pink', 'yellow'].includes(colour)).length;
    if (airy) score += 0.4;
  }
  if (target.lounge || target.sleep) {
    if (chromaticFamilies.length >= 3) score -= 1.0;
    if (neutralFamilies.length) score += 0.55;
  }
  if (target.nightlife) {
    if (chromaticFamilies.length === 0 && neutralFamilies.includes('black')) score += 0.7;
    if (chromaticFamilies.length >= 2) score += 0.35;
  }

  return {
    score,
    signature: paletteSignature(outfit),
    chromaticFamilies,
    neutralFamilies,
    mode,
  };
}

function pairwiseBaseScore(a: IndexItem, b: IndexItem): number {
  const left = a.id < b.id ? a : b;
  const right = a.id < b.id ? b : a;
  const cacheKey = `${left.id}|${right.id}`;
  if (REQUEST_MEMO?.pairwiseBase.has(cacheKey)) return REQUEST_MEMO.pairwiseBase.get(cacheKey)!;
  const persistentKey = pairwisePersistentKey(left, right);
  if (GLOBAL_PAIRWISE_BASE_CACHE.has(persistentKey)) {
    const cached = GLOBAL_PAIRWISE_BASE_CACHE.get(persistentKey)!;
    REQUEST_MEMO?.pairwiseBase.set(cacheKey, cached);
    return cached;
  }
  const leftSignals = itemSignals(left);
  const rightSignals = itemSignals(right);
  const value =
    (colourHarmony(left, right) * 0.8) +
    (1.2 - Math.abs(leftSignals.formality_score - rightSignals.formality_score) * 0.9) +
    (1.0 - Math.abs(leftSignals.streetwear_score - rightSignals.streetwear_score) * 0.5) +
    (0.8 - Math.abs(leftSignals.classic_score - rightSignals.classic_score) * 0.45) +
    (0.7 - Math.abs(leftSignals.comfort_score - rightSignals.comfort_score) * 0.35);
  REQUEST_MEMO?.pairwiseBase.set(cacheKey, value);
  rememberGlobalPairwiseBase(persistentKey, value);
  return value;
}

function pairwiseScore(outfit: Outfit, intent: PromptIntent): number {
  const target = styleTarget(intent);
  const items = SLOT_ORDER.map((slot) => outfit[slot]).filter((item): item is IndexItem => !!item);
  let score = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      score += pairwiseBaseScore(items[i], items[j]);
    }
  }

  if (target.refined) {
    if (outfit.shoes && (isOpenCasualShoeSubtype(outfit.shoes.sub) || isAthleticShoeSubtype(outfit.shoes.sub))) score -= 5;
    if (outfit.bottom && hasAnyMarker(outfit.bottom, ['distressed', 'camouflage', 'technical', 'embellished'])) score -= 5;
  }
  if (target.classic) {
    if (outfit.shoes && isAthleticShoeSubtype(outfit.shoes.sub)) score -= 3.4;
    if (outfit.bottom && hasAnyMarker(outfit.bottom, ['distressed', 'camouflage'])) score -= 3.2;
  }
  if (target.streetwear && outfit.shoes && isFormalSubtype(outfit.shoes.sub)) score -= 4;
  if (target.sport && outfit.shoes && isHeelFamilySubtype(outfit.shoes.sub)) score -= 5;
  if ((target.beach || target.resort) && outfit.shoes && !isOpenCasualShoeSubtype(outfit.shoes.sub)) score -= 2.6;
  if ((target.beach || target.resort) && outfit.top && hasAnyMarker(outfit.top, ['outerwear', 'technical'])) score -= 1.8;
  if ((target.lounge || target.sleep) && outfit.shoes && !isOpenCasualShoeSubtype(outfit.shoes.sub) && !isLoungeSubtype(outfit.shoes.sub)) score -= 2.6;
  if (target.office && outfit.shoes && (isOpenCasualShoeSubtype(outfit.shoes.sub) || isAthleticShoeSubtype(outfit.shoes.sub))) score -= 3.2;
  if (target.nightlife && outfit.shoes && isAthleticShoeSubtype(outfit.shoes.sub)) score -= 3.5;
  if (target.travel && outfit.shoes && isHeelFamilySubtype(outfit.shoes.sub)) score -= 2.4;
  if (outfit.mono && outfit.shoes) {
    if (target.sleep) {
      if (isOpenCasualShoeSubtype(outfit.shoes.sub) || isLoungeSubtype(outfit.shoes.sub)) score += 1.5;
      if (isAthleticShoeSubtype(outfit.shoes.sub)) score -= 2.4;
    } else if (target.beach || target.resort) {
      if (isOpenCasualShoeSubtype(outfit.shoes.sub)) score += 1.4;
      if (canonicalizeSubtype(outfit.shoes.sub || '') === 'boots') score -= 2.6;
    } else {
      if (isHeelFamilySubtype(outfit.shoes.sub) || isFormalSubtype(outfit.shoes.sub)) score += 1.6;
      if (isAthleticShoeSubtype(outfit.shoes.sub)) score -= 1.8;
    }
  }
  score += evaluateOutfitPalette(outfit, intent).score;
  return score;
}

function loadEmbeddings(indexPath: string, override: string | null, debug: boolean): LoadedEmbeddings {
  const sidecarPath = resolveEmbeddingSidecarPath(indexPath, override || undefined);
  if (!fs.existsSync(sidecarPath)) {
    logDebug(debug, 'embedding sidecar missing', sidecarPath);
    return {
      sidecar: null,
      sidecarPath,
      itemVectors: new Map(),
      identityVectors: new Map(),
      styleVectors: new Map(),
      slotVectors: { top: new Map(), bottom: new Map(), shoes: new Map(), mono: new Map() },
      slotIdentityVectors: { top: new Map(), bottom: new Map(), shoes: new Map(), mono: new Map() },
      slotStyleVectors: { top: new Map(), bottom: new Map(), shoes: new Map(), mono: new Map() },
    };
  }
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as EmbeddingSidecar;
  const itemVectors = new Map<string, number[]>();
  const identityVectors = new Map<string, number[]>();
  const styleVectors = new Map<string, number[]>();
  const slotVectors: Record<CategoryMain, Map<string, number[]>> = {
    top: new Map(),
    bottom: new Map(),
    shoes: new Map(),
    mono: new Map(),
  };
  const slotIdentityVectors: Record<CategoryMain, Map<string, number[]>> = {
    top: new Map(),
    bottom: new Map(),
    shoes: new Map(),
    mono: new Map(),
  };
  const slotStyleVectors: Record<CategoryMain, Map<string, number[]>> = {
    top: new Map(),
    bottom: new Map(),
    shoes: new Map(),
    mono: new Map(),
  };
  for (const entry of Object.values(sidecar.items || {})) {
    if (entry.vector?.length) itemVectors.set(entry.id, entry.vector);
    if (entry.identity_vector?.length) identityVectors.set(entry.id, entry.identity_vector);
    if (entry.style_vector?.length) styleVectors.set(entry.id, entry.style_vector);
    for (const slot of SLOT_ORDER) {
      const slotVector = entry.slot_vectors?.[slot];
      const slotIdentityVector = entry.slot_identity_vectors?.[slot];
      const slotStyleVector = entry.slot_style_vectors?.[slot];
      if (slotVector?.length) slotVectors[slot].set(entry.id, slotVector);
      if (slotIdentityVector?.length) slotIdentityVectors[slot].set(entry.id, slotIdentityVector);
      if (slotStyleVector?.length) slotStyleVectors[slot].set(entry.id, slotStyleVector);
    }
  }
  return { sidecar, sidecarPath, itemVectors, identityVectors, styleVectors, slotVectors, slotIdentityVectors, slotStyleVectors };
}

const PROMPT_EMBEDDING_CACHE = new Map<string, number[]>();
const PROMPT_EMBEDDING_CACHE_PATH = resolvePromptEmbeddingCachePath(process.cwd());
let PERSISTED_PROMPT_EMBEDDING_CACHE: Record<string, { vector: number[]; source: 'live'; created_at: string }> | null = null;

function getPersistedPromptEmbeddingCache() {
  if (!PERSISTED_PROMPT_EMBEDDING_CACHE) {
    PERSISTED_PROMPT_EMBEDDING_CACHE = loadPersistedVectorCache(PROMPT_EMBEDDING_CACHE_PATH);
  }
  return PERSISTED_PROMPT_EMBEDDING_CACHE;
}

function rememberPromptEmbedding(key: string, vector: number[]) {
  if (!vector.length) return;
  PROMPT_EMBEDDING_CACHE.set(key, vector);
  const cache = getPersistedPromptEmbeddingCache();
  cache[key] = {
    vector,
    source: 'live',
    created_at: new Date().toISOString(),
  };
  persistVectorCache(PROMPT_EMBEDDING_CACHE_PATH, cache);
}

async function resolvePromptEmbeddings(
  prompt: string,
  intent: PromptIntent,
  mode: EmbeddingMode,
  project: string | null,
  location: string,
  embeddingModel: string,
  embeddings: LoadedEmbeddings,
  corpusStats: SemanticCorpusStats,
  debug: boolean,
): Promise<PromptEmbeddingState> {
  if (mode === 'off') {
    return {
      active: false,
      available: false,
      source: 'off',
      reason: 'embedding_mode_off',
      promptVector: [],
      identityVector: [],
      styleVector: [],
      slotPromptVectors: {},
      slotIdentityVectors: {},
      slotStyleVectors: {},
    };
  }
  if (!embeddings.sidecar) {
    return {
      active: false,
      available: false,
      source: 'missing',
      reason: 'sidecar_missing',
      promptVector: [],
      identityVector: [],
      styleVector: [],
      slotPromptVectors: {},
      slotIdentityVectors: {},
      slotStyleVectors: {},
    };
  }
  try {
    const bundle = buildPromptSemanticBundle(prompt, intent, { corpus: corpusStats });
    const refs: Array<{ key: string; text: string; slot?: CategoryMain; kind: 'general' | 'identity' | 'style' | 'slot_general' | 'slot_identity' | 'slot_style' }> = [
      { key: `${embeddingModel}::general::${bundle.general}`, text: bundle.general, kind: 'general' },
      { key: `${embeddingModel}::identity::${bundle.identity}`, text: bundle.identity, kind: 'identity' },
      { key: `${embeddingModel}::style::${bundle.style}`, text: bundle.style, kind: 'style' },
    ];
    for (const slot of SLOT_ORDER) {
      if (bundle.slots[slot]) refs.push({ key: `${embeddingModel}::slot_general::${slot}::${bundle.slots[slot]}`, text: bundle.slots[slot] || '', slot, kind: 'slot_general' });
      if (bundle.slot_identity[slot]) refs.push({ key: `${embeddingModel}::slot_identity::${slot}::${bundle.slot_identity[slot]}`, text: bundle.slot_identity[slot] || '', slot, kind: 'slot_identity' });
      if (bundle.slot_style[slot]) refs.push({ key: `${embeddingModel}::slot_style::${slot}::${bundle.slot_style[slot]}`, text: bundle.slot_style[slot] || '', slot, kind: 'slot_style' });
    }

    const persistedCache = getPersistedPromptEmbeddingCache();
    const resolvedVectors = new Map<string, number[]>();
    const missingRefs: typeof refs = [];
    for (const ref of refs) {
      if (PROMPT_EMBEDDING_CACHE.has(ref.key)) {
        resolvedVectors.set(ref.key, PROMPT_EMBEDDING_CACHE.get(ref.key) || []);
        continue;
      }
      if (persistedCache[ref.key]?.source === 'live' && persistedCache[ref.key].vector?.length) {
        PROMPT_EMBEDDING_CACHE.set(ref.key, persistedCache[ref.key].vector);
        resolvedVectors.set(ref.key, persistedCache[ref.key].vector);
        continue;
      }
      missingRefs.push(ref);
    }

    if (missingRefs.length) {
      if (!project) {
        return {
          active: false,
          available: false,
          source: 'missing',
          reason: 'project_missing',
          promptVector: [],
          identityVector: [],
          styleVector: [],
          slotPromptVectors: {},
          slotIdentityVectors: {},
          slotStyleVectors: {},
        };
      }
      const ai = createGoogleGenAIClient(project, location);
      const uniqueMissingTexts = Array.from(new Set(missingRefs.map((ref) => ref.text)));
      const vectors = await withTimeout(
        embedTexts(ai, embeddingModel, uniqueMissingTexts, 'RETRIEVAL_QUERY'),
        DEFAULT_PROMPT_EMBED_TIMEOUT_MS,
        'prompt_embedding',
      );
      const vectorsByText = new Map<string, number[]>();
      for (let i = 0; i < uniqueMissingTexts.length; i++) {
        const vector = vectors[i] || [];
        if (!vector.length) continue;
        vectorsByText.set(uniqueMissingTexts[i], vector);
      }
      for (let i = 0; i < missingRefs.length; i++) {
        const vector = vectorsByText.get(missingRefs[i].text) || [];
        if (!vector.length) continue;
        resolvedVectors.set(missingRefs[i].key, vector);
        rememberPromptEmbedding(missingRefs[i].key, vector);
      }
    }

    const promptVector = resolvedVectors.get(refs[0].key) || [];
    const identityVector = resolvedVectors.get(refs[1].key) || [];
    const styleVector = resolvedVectors.get(refs[2].key) || [];
    const slotPromptVectors: Partial<Record<CategoryMain, number[]>> = {};
    const slotIdentityVectors: Partial<Record<CategoryMain, number[]>> = {};
    const slotStyleVectors: Partial<Record<CategoryMain, number[]>> = {};
    for (const ref of refs) {
      if (!ref.slot) continue;
      const vector = resolvedVectors.get(ref.key) || [];
      if (!vector.length) continue;
      if (ref.kind === 'slot_general') slotPromptVectors[ref.slot] = vector;
      if (ref.kind === 'slot_identity') slotIdentityVectors[ref.slot] = vector;
      if (ref.kind === 'slot_style') slotStyleVectors[ref.slot] = vector;
    }
    const available = !!(promptVector.length || identityVector.length || styleVector.length);
    if (!available) {
      return {
        active: false,
        available: false,
        source: 'missing',
        reason: 'prompt_embedding_empty',
        promptVector: [],
        identityVector: [],
        styleVector: [],
        slotPromptVectors: {},
        slotIdentityVectors: {},
        slotStyleVectors: {},
      };
    }
    return {
      active: true,
      available: true,
      source: missingRefs.length ? 'live' : 'cache_live',
      reason: null,
      promptVector,
      identityVector,
      styleVector,
      slotPromptVectors,
      slotIdentityVectors,
      slotStyleVectors,
    };
  } catch (error) {
    logDebug(debug, 'prompt embedding failed', error);
    return {
      active: false,
      available: false,
      source: 'missing',
      reason: 'prompt_embedding_failed',
      promptVector: [],
      identityVector: [],
      styleVector: [],
      slotPromptVectors: {},
      slotIdentityVectors: {},
      slotStyleVectors: {},
    };
  }
}

function buildSemanticSlotContext(
  slot: CategoryMain,
  slotProfile: SlotConstraintProfile,
  promptEmbeddings: PromptEmbeddingState,
): SemanticSlotContext {
  const promptVector = promptEmbeddings.slotPromptVectors[slot] || promptEmbeddings.promptVector;
  const promptIdentity = promptEmbeddings.slotIdentityVectors[slot] || promptEmbeddings.identityVector || promptVector;
  const promptStyle = promptEmbeddings.slotStyleVectors[slot] || promptEmbeddings.styleVector || promptVector;
  return {
    slotConstraintKey: slotConstraintCacheKey(slotProfile),
    promptVector,
    promptIdentity,
    promptStyle,
  };
}

function semanticItemScore(
  item: IndexItem,
  slot: CategoryMain,
  slotProfile: SlotConstraintProfile,
  promptEmbeddings: PromptEmbeddingState,
  embeddings: LoadedEmbeddings,
  contextOverride?: SemanticSlotContext,
): number {
  const context = contextOverride || buildSemanticSlotContext(slot, slotProfile, promptEmbeddings);
  const cacheKey = `${requestItemKey(item) || item.id || 'item'}::${slot}::${context.slotConstraintKey}::semantic`;
  if (REQUEST_MEMO?.semanticScore.has(cacheKey)) return REQUEST_MEMO.semanticScore.get(cacheKey)!;
  if (!promptEmbeddings.available) return 0;
  const itemVector = embeddings.itemVectors.get(item.id) || [];
  const identityItemVector = embeddings.slotIdentityVectors[slot].get(item.id) || embeddings.identityVectors.get(item.id) || itemVector;
  const styleItemVector = embeddings.slotStyleVectors[slot].get(item.id) || embeddings.styleVectors.get(item.id) || itemVector;
  const promptVector = context.promptVector;
  const promptIdentity = context.promptIdentity;
  const promptStyle = context.promptStyle;
  const combinedScore = promptVector.length && itemVector.length ? cosineSimilarityCached(promptVector, itemVector) : 0;
  const identityScore = promptIdentity.length && identityItemVector.length ? cosineSimilarityCached(promptIdentity, identityItemVector) : combinedScore;
  const styleScore = promptStyle.length && styleItemVector.length ? cosineSimilarityCached(promptStyle, styleItemVector) : combinedScore;
  let value = 0;
  if (slotProfile.lockMode === 'exact') value = (identityScore * 0.72) + (combinedScore * 0.2) + (styleScore * 0.08);
  else if (slotProfile.lockMode === 'family') value = (identityScore * 0.56) + (combinedScore * 0.24) + (styleScore * 0.2);
  else if (slotProfile.lockMode === 'attribute') value = (identityScore * 0.36) + (styleScore * 0.34) + (combinedScore * 0.3);
  else value = (styleScore * 0.54) + (combinedScore * 0.32) + (identityScore * 0.14);
  REQUEST_MEMO?.semanticScore.set(cacheKey, value);
  return value;
}

function semanticOutfitScore(
  outfit: Outfit,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  promptEmbeddings: PromptEmbeddingState,
  embeddings: LoadedEmbeddings,
): { score: number; vector: number[] } {
  if (!promptEmbeddings.available) return { score: 0, vector: [] };
  const vectors: Array<{ vector: number[]; weight: number }> = [];
  const styleVectors: Array<{ vector: number[]; weight: number }> = [];
  const slotIdentityScores: number[] = [];
  const slotStyleScores: number[] = [];
  for (const slot of SLOT_ORDER) {
    const item = outfit[slot];
    if (!item) continue;
    const itemVector = embeddings.itemVectors.get(item.id) || [];
    const identityItemVector = embeddings.slotIdentityVectors[slot].get(item.id) || embeddings.identityVectors.get(item.id) || itemVector;
    const styleItemVector = embeddings.slotStyleVectors[slot].get(item.id) || embeddings.styleVectors.get(item.id) || itemVector;
    if (itemVector.length) vectors.push({ vector: itemVector, weight: ROLE_WEIGHTS[slot] });
    if (styleItemVector.length) styleVectors.push({ vector: styleItemVector, weight: ROLE_WEIGHTS[slot] });
    const promptVector = promptEmbeddings.slotPromptVectors[slot] || promptEmbeddings.promptVector;
    const promptIdentity = promptEmbeddings.slotIdentityVectors[slot] || promptEmbeddings.identityVector || promptVector;
    const promptStyle = promptEmbeddings.slotStyleVectors[slot] || promptEmbeddings.styleVector || promptVector;
    if (promptIdentity?.length && identityItemVector.length) slotIdentityScores.push(cosineSimilarityCached(promptIdentity, identityItemVector) * ROLE_WEIGHTS[slot]);
    if (promptStyle?.length && styleItemVector.length) slotStyleScores.push(cosineSimilarityCached(promptStyle, styleItemVector) * ROLE_WEIGHTS[slot]);
  }
  const outfitVector = weightedAverageVectors(vectors);
  const outfitStyleVector = weightedAverageVectors(styleVectors);
  const overall = outfitVector.length ? cosineSimilarityCached(promptEmbeddings.promptVector, outfitVector) : 0;
  const styleOverall = outfitStyleVector.length && promptEmbeddings.styleVector.length
    ? cosineSimilarityCached(promptEmbeddings.styleVector, outfitStyleVector)
    : overall;
  const identityMean = slotIdentityScores.length ? slotIdentityScores.reduce((sum, value) => sum + value, 0) / slotIdentityScores.length : 0;
  const styleMean = slotStyleScores.length ? slotStyleScores.reduce((sum, value) => sum + value, 0) / slotStyleScores.length : 0;
  const broadness = SLOT_ORDER
    .filter((slot) => !!outfit[slot])
    .reduce((sum, slot) => sum + slotBroadness(slotProfiles[slot]), 0) / Math.max(1, SLOT_ORDER.filter((slot) => !!outfit[slot]).length);
  return {
    score: (styleOverall * (0.34 + broadness * 0.18)) + (styleMean * 0.24) + (identityMean * (0.32 - broadness * 0.12)) + (overall * 0.18),
    vector: outfitVector,
  };
}

function prepareCandidatesForSlot(
  items: IndexItem[],
  slot: CategoryMain,
  intent: PromptIntent,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  perRoleLimit: number,
  promptEmbeddings: PromptEmbeddingState,
  semanticWide = false,
): PreparedSlotCandidateState {
  const debug = process.env.DEBUG_OUTFITS === '1';
  const slotConstraint = slotProfiles[slot];
  const specificity = slotConstraint.specificity;
  const baseStartedAt = Date.now();
  const rawSlotItems = itemsForSlot(items, slot);
  const slotItems = globallyEligibleItemsForSlot(items, slot, intent);
  const compatibleItems = genderEligibleItemsForSlot(items, slot, intent);
  const symbolicContext = buildSymbolicSlotContext(slot, intent, slotConstraint);
  const semanticContext = buildSemanticSlotContext(slot, slotConstraint, promptEmbeddings);
  const shouldRelaxGenderForAnchors = slotHasIdentityAnchors(slotConstraint) && slotHasExplicitConstraints(slotConstraint);
  const genderedAnchorCoverage = compatibleItems.some((item) =>
    !slotNegativeViolation(item, slotConstraint) &&
    anchorPreservationScore(item, slotConstraint) >= 0.58,
  );
  const anchorFallbackItems = shouldRelaxGenderForAnchors && !genderedAnchorCoverage
    ? slotItems.filter((item) =>
        !effectiveGenderCompatible(item, intent.target_gender) &&
        !slotNegativeViolation(item, slotConstraint) &&
        anchorPreservationScore(item, slotConstraint) >= 0.58,
      )
    : [];
  const baseAll = anchorFallbackItems.length
    ? [...compatibleItems, ...anchorFallbackItems.filter((item) => !compatibleItems.some((entry) => entry.id === item.id))]
    : compatibleItems;
  const base = (() => {
    const filtered = baseAll.filter((item) => !slotNegativeViolation(item, slotConstraint));
    return filtered.length ? filtered : baseAll;
  })();
  const baseMs = Date.now() - baseStartedAt;
  if (debug) {
    console.error('[DEBUG]', 'filterCandidatesForSlot', slot, {
      baseAll: baseAll.length,
      base: base.length,
      specificity,
      lockMode: slotConstraint.lockMode,
      variantMode: slotConstraint.variantMode,
      preferred_subs: slotConstraint.preferred_subs,
      anchor_entities: slotConstraint.anchor_entities,
      anchor_colours: slotConstraint.anchor_colours,
      required_keywords: slotConstraint.required_keywords,
      excluded_subs: slotConstraint.excluded_subs,
      excluded_entities: slotConstraint.excluded_entities,
      excluded_colours: slotConstraint.excluded_colours,
      excluded_keywords: slotConstraint.excluded_keywords,
    });
  }
  const maxTier = maxExactnessTierForProfile(slotConstraint);
  const tierStartedAt = Date.now();
  const tieredSource = semanticWide ? baseAll : base;
  const tiered = tieredSource.map((item) => ({
    item,
    tier: exactnessTier(item, slot, slotConstraint),
  }));
  const survivors = tiered.filter((entry) => entry.tier <= maxTier);
  const relaxedPool = survivors.length ? survivors : tiered.filter(({ item }) => {
    const subMatch = slotConstraint.preferred_subs.some((sub) => slotSubtypeMatch(item, sub));
    const entityMatch = slotConstraint.anchor_entities.some((entity) => itemHasEntity(item, entity));
    const keywordMatch = slotConstraint.required_keywords.some((keyword) => itemHasKeyword(item, keyword));
    const colourMatch = slotConstraint.anchor_colours.some((colour) => itemHasColour(item, colour));
    return subMatch || entityMatch || keywordMatch || colourMatch;
  });
  const workingPool = relaxedPool.length ? relaxedPool : survivors;
  const bestTier = workingPool.length ? Math.min(...workingPool.map((entry) => entry.tier)) : maxTier;
  const tierCeiling = workingPool === survivors
    ? Math.min(maxTier, bestTier + exactnessSlackForProfile(slotConstraint))
    : Math.min(5, bestTier + Math.max(2, exactnessSlackForProfile(slotConstraint)));
  const narrowed = workingPool.filter((entry) => entry.tier <= tierCeiling);
  const anchoredConstraintMode =
    (intent.outfit_mode === 'single' && intent.required_categories.length === 1 && intent.required_categories[0] === slot && slotHasIdentityAnchors(slotConstraint)) ||
    (slotConstraint.lockMode !== 'broad' && slotHasIdentityAnchors(slotConstraint) && slotHasExplicitConstraints(slotConstraint));
  const semanticSpillover = (() => {
    if (!promptEmbeddings.available) return [] as typeof narrowed;
    if (slotConstraint.lockMode === 'exact' || slotConstraint.lockMode === 'family') return [] as typeof narrowed;
    const seen = new Set(narrowed.map((entry) => entry.item.id));
    const spillTierCeiling = semanticWide
      ? Math.min(
          8,
          slotConstraint.lockMode === 'broad'
            ? Math.max(6, tierCeiling + 3)
            : Math.max(6, tierCeiling + 2),
        )
      : Math.min(5, tierCeiling + (slotConstraint.lockMode === 'broad' ? 2 : 1));
    const spillLimit = semanticWide
      ? Math.min(Math.max(perRoleLimit * 2, 48), 144)
      : Math.min(Math.max(perRoleLimit, 24), 96);
    const source = tiered;
    return source
      .filter((entry) =>
        !seen.has(entry.item.id) &&
        entry.tier <= spillTierCeiling &&
        !slotNegativeViolation(entry.item, slotConstraint) &&
        (!anchoredConstraintMode || anchorPreservationScore(entry.item, slotConstraint) >= (semanticWide ? 0.34 : 0.42)),
      )
      .sort((a, b) =>
        a.tier - b.tier ||
        (anchorPreservationScore(b.item, slotConstraint) - anchorPreservationScore(a.item, slotConstraint))
      )
      .slice(0, spillLimit);
  })();
  const scoringPool = (() => {
    const merged = [...narrowed];
    const seen = new Set(merged.map((entry) => entry.item.id));
    if (anchoredConstraintMode) {
      const extras = tiered.filter(({ item }) =>
        !slotNegativeViolation(item, slotConstraint) &&
        anchorPreservationScore(item, slotConstraint) >= 0.58,
      );
      for (const entry of extras) {
        if (seen.has(entry.item.id)) continue;
        merged.push(entry);
        seen.add(entry.item.id);
      }
    }
    for (const entry of semanticSpillover) {
      if (seen.has(entry.item.id)) continue;
      merged.push(entry);
      seen.add(entry.item.id);
    }
    return merged;
  })();
  const tierMs = Date.now() - tierStartedAt;
  const prepStartedAt = Date.now();
  const prepared = scoringPool.map(({ item, tier }) => {
    const symbolic = symbolicItemScore(item, slot, intent, slotConstraint, symbolicContext);
    const variantGroupKey = item.variant_group_key || '';
    const variantBoosted = !!(variantGroupKey && slotConstraint.variantGroupHints.includes(variantGroupKey));
    const negativeViolated = slotNegativeViolation(item, slotConstraint);
    return {
      item,
      symbolic,
      stage: tier,
      specificity,
      family: itemFamily(item),
      brandKey: itemBrandKey(item),
      colourFamily: itemColourFamily(item),
      variantGroupKey,
      variantBoosted,
      negativeViolated,
      anchorPreservation: anchorPreservationScore(item, slotConstraint),
    };
  });
  const prepMs = Date.now() - prepStartedAt;
  return {
    slot,
    intent,
    slotConstraint,
    symbolicContext,
    semanticContext,
    anchoredConstraintMode,
    perRoleLimit,
    prepared,
    timings: {
      baseMs,
      tierMs,
      prepMs,
      rawSlotItems: rawSlotItems.length,
      baseAll: baseAll.length,
      base: base.length,
    },
  };
}

function getPreparedCandidatesForSlot(
  items: IndexItem[],
  slot: CategoryMain,
  intent: PromptIntent,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  perRoleLimit: number,
  promptEmbeddings: PromptEmbeddingState,
  semanticWide = false,
): PreparedSlotCandidateState {
  const key = `${slot}::${perRoleLimit}::${semanticWide ? 'semantic' : 'standard'}`;
  const cached = REQUEST_MEMO?.preparedSlotCandidates.get(key) as PreparedSlotCandidateState | undefined;
  if (cached) return cached;
  const prepared = prepareCandidatesForSlot(items, slot, intent, slotProfiles, perRoleLimit, promptEmbeddings, semanticWide);
  REQUEST_MEMO?.preparedSlotCandidates.set(key, prepared);
  return prepared;
}

function finalizePreparedCandidatesForSlot(
  preparedState: PreparedSlotCandidateState,
  promptEmbeddings: PromptEmbeddingState,
  embeddings: LoadedEmbeddings,
  embeddingMode: EmbeddingMode,
): { output: ScoredItem[]; scored: ScoredItem[]; scoreMs: number; selectMs: number } {
  const { slot, slotConstraint, semanticContext, anchoredConstraintMode, perRoleLimit, prepared } = preparedState;
  const scoreStartedAt = Date.now();
  const scored = prepared.map((entry) => {
    const semantic = embeddingMode === 'hybrid'
      ? semanticItemScore(entry.item, slot, slotConstraint, promptEmbeddings, embeddings, semanticContext || undefined)
      : 0;
    return {
      item: entry.item,
      symbolic: entry.symbolic,
      outfitSymbolic: entry.symbolic,
      semantic,
      stage: entry.stage,
      specificity: entry.specificity,
      family: entry.family,
      brandKey: entry.brandKey,
      colourFamily: entry.colourFamily,
      variantGroupKey: entry.variantGroupKey,
      variantBoosted: entry.variantBoosted,
      negativeViolated: entry.negativeViolated,
      anchorPreservation: entry.anchorPreservation,
      score:
        entry.symbolic +
        semantic * embeddingRetrievalWeight(slotConstraint) -
        entry.stage * exactnessPenaltyWeight(slotConstraint) -
        (entry.negativeViolated ? 8.5 : 0),
    } satisfies ScoredItem;
  });
  const scoreMs = Date.now() - scoreStartedAt;
  const selectStartedAt = Date.now();
  const semanticFrontierMode =
    embeddingMode === 'hybrid' &&
    promptEmbeddings.available &&
    slotConstraint.lockMode !== 'exact' &&
    slotConstraint.lockMode !== 'family';
  scored.sort((a, b) => {
    if (semanticFrontierMode) {
      const scoreGap = Math.abs((b.score || 0) - (a.score || 0));
      if (a.stage !== b.stage && scoreGap < (slotConstraint.lockMode === 'broad' ? 2.4 : 1.6)) {
        return a.stage - b.stage;
      }
      if (a.variantBoosted !== b.variantBoosted) return a.variantBoosted ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      if (b.semantic !== a.semantic) return b.semantic - a.semantic;
      if (b.symbolic !== a.symbolic) return b.symbolic - a.symbolic;
      if (a.stage !== b.stage) return a.stage - b.stage;
      return 0;
    }
    if (a.stage !== b.stage) return a.stage - b.stage;
    if (a.variantBoosted !== b.variantBoosted) return a.variantBoosted ? -1 : 1;
    if (b.symbolic !== a.symbolic) return b.symbolic - a.symbolic;
    if (b.semantic !== a.semantic) return b.semantic - a.semantic;
    return b.score - a.score;
  });
  const frontierInput = (() => {
    if (!semanticFrontierMode) return scored;
    const limit = frontierSoftLimit(slotConstraint, perRoleLimit);
    const symbolicLeaders = scored.slice(0, Math.max(limit * 2, limit + 4));
    const semanticLeaders = [...scored]
      .sort((a, b) => (b.semantic - a.semantic) || (b.score - a.score) || (b.symbolic - a.symbolic))
      .slice(0, Math.max(4, Math.ceil(limit * 0.55)));
    const seenFamilies = new Set<string>();
    const seenBrands = new Set<string>();
    const seenColours = new Set<string>();
    const novelSemantic: ScoredItem[] = [];
    for (const candidate of semanticLeaders) {
      const familyNovel = candidate.family && !seenFamilies.has(candidate.family);
      const brandNovel = candidate.brandKey && !seenBrands.has(candidate.brandKey);
      const colourNovel = candidate.colourFamily && !seenColours.has(candidate.colourFamily);
      if (familyNovel || brandNovel || colourNovel || novelSemantic.length < Math.max(2, Math.ceil(limit / 3))) {
        novelSemantic.push(candidate);
        if (candidate.family) seenFamilies.add(candidate.family);
        if (candidate.brandKey) seenBrands.add(candidate.brandKey);
        if (candidate.colourFamily) seenColours.add(candidate.colourFamily);
      }
      if (novelSemantic.length >= Math.max(3, Math.ceil(limit * 0.35))) break;
    }
    const union: ScoredItem[] = [];
    const seenIds = new Set<string>();
    for (const candidate of [...symbolicLeaders, ...semanticLeaders, ...novelSemantic]) {
      if (seenIds.has(candidate.item.id)) continue;
      seenIds.add(candidate.item.id);
      union.push(candidate);
    }
    return union;
  })();
  const anchoredSelected = anchoredConstraintMode
    ? selectAnchoredConstraintFrontier(frontierInput, slotConstraint, perRoleLimit)
    : [];
  const selected = anchoredSelected.length
    ? anchoredSelected
    : selectOpenSlotFrontier(frontierInput, slot, slotConstraint, perRoleLimit);
  const bestSymbolic = selected.reduce((best, entry) => Math.max(best, entry.symbolic), -Infinity);
  const bestVariantSymbolic = selected
    .filter((entry) => entry.variantBoosted)
    .reduce((best, entry) => Math.max(best, entry.symbolic), -Infinity);
  const output = selected.map((entry) => ({
    ...entry,
    outfitSymbolic: Number.isFinite(bestSymbolic)
      ? (
        entry.variantBoosted &&
        slotConstraint.variantMode === 'open' &&
        Number.isFinite(bestVariantSymbolic)
          ? compressOpenSlotSymbolic(entry.symbolic, bestVariantSymbolic, slotConstraint)
          : compressOpenSlotSymbolic(entry.symbolic, bestSymbolic, slotConstraint)
      )
      : entry.symbolic,
  }));
  const selectMs = Date.now() - selectStartedAt;
  return { output, scored, scoreMs, selectMs };
}

function semanticPoolExplorationBias(
  intent: PromptIntent,
  slotConstraint: SlotConstraintProfile,
  promptEmbeddings: PromptEmbeddingState,
): number {
  const semanticSubjects = (intent.semantic_subjects || []).length;
  const vibeCount = (intent.vibe_tags || []).length;
  const occasionCount = (intent.occasion_tags || []).length;
  const activityCount = (intent.activity_context || []).length;
  const requestedSlots = uniq([...intent.required_categories, ...intent.optional_categories]).length;
  const explicitSignals =
    slotConstraint.preferred_subs.length +
    slotConstraint.required_keywords.length +
    slotConstraint.anchor_entities.length +
    slotConstraint.anchor_keywords.length +
    slotConstraint.anchor_colours.length +
    slotConstraint.exact_item_phrases.length;
  const broadness =
    slotConstraint.lockMode === 'broad'
      ? 0.28
      : slotConstraint.lockMode === 'attribute'
        ? 0.14
        : 0;
  const informativity = clamp01(promptEmbeddings.semanticInformativeness ?? 0);
  return clamp01(
    0.06 +
    broadness +
    Math.min(0.24, semanticSubjects * 0.06) +
    Math.min(0.16, vibeCount * 0.035) +
    Math.min(0.1, occasionCount * 0.02) +
    Math.min(0.08, activityCount * 0.02) +
    Math.min(0.08, Math.max(0, requestedSlots - 1) * 0.03) +
    informativity * 0.24 -
    Math.min(0.34, explicitSignals * 0.055),
  );
}

function semanticPoolOutputLimit(
  slotConstraint: SlotConstraintProfile,
  perRoleLimit: number,
  explorationBias: number,
): number {
  const frontierLimit = frontierSoftLimit(slotConstraint, perRoleLimit);
  const expansion = Math.ceil(perRoleLimit * (0.45 + explorationBias * 0.85));
  return Math.max(
    perRoleLimit,
    Math.min(96, frontierLimit, perRoleLimit + expansion),
  );
}

function semanticPoolConstraintCleanliness(
  item: IndexItem,
  slot: CategoryMain,
  slotConstraint: SlotConstraintProfile,
  anchorPreservation: number,
  negativeViolated: boolean,
): number {
  if (negativeViolated) return 0;
  const crossSlotPenalty = crossSlotSignalPenalty(item, slot);
  let value = 1 - Math.min(0.58, crossSlotPenalty * 0.16);
  if (slotHasExplicitConstraints(slotConstraint) || slotHasIdentityAnchors(slotConstraint)) {
    value = Math.min(value, 0.4 + anchorPreservation * 0.6);
  }
  if (slotConstraint.preferred_subs.length && !slotConstraint.preferred_subs.some((sub) => slotSubtypeMatch(item, sub))) {
    value -= slotConstraint.lockMode === 'attribute' ? 0.08 : 0.14;
  }
  if (slotConstraint.excluded_keywords.some((keyword) => itemHasKeyword(item, keyword))) value -= 0.36;
  if ((slotConstraint.excluded_entities || []).some((entity) => itemHasEntity(item, entity))) value -= 0.44;
  if ((slotConstraint.excluded_colours || []).some((colour) => itemHasColour(item, colour))) value -= 0.4;
  if (slotConstraint.excluded_subs.some((sub) => slotSubtypeMatch(item, sub))) value -= 0.34;
  return clamp01(value);
}

function semanticPoolRoleFit(
  item: IndexItem,
  slot: CategoryMain,
  intent: PromptIntent,
): number {
  const target = styleTarget(intent);
  const signals = itemSignals(item);
  const sub = canonicalizeSubtype(item.sub || '');
  let raw = 0;

  if (target.refined || target.classic || target.office || target.nightlife) {
    raw += (signals.formality_score * 0.85) + (signals.cleanliness_score * 0.72) + (signals.classic_score * 0.58);
    raw -= (signals.streetwear_score * 0.34) + (signals.sportiness_score * 0.24);
    if (slot === 'shoes') {
      if (isFormalSubtype(sub) || isHeelFamilySubtype(sub)) raw += 0.28;
      if (isAthleticShoeSubtype(sub)) raw -= 0.34;
      if (isOpenCasualShoeSubtype(sub) && !target.beach && !target.resort) raw -= 0.18;
    }
  }

  if (target.streetwear || target.persona_street) {
    raw += signals.streetwear_score * 0.92;
    raw -= signals.formality_score * 0.18;
    if (slot === 'shoes' && isFormalSubtype(sub)) raw -= 0.22;
  }

  if (target.sport) {
    raw += signals.sportiness_score * 0.96;
    if ((item.sportMeta?.sport || 'none') === intent.sport_context && intent.sport_context !== 'none') raw += 0.28;
    if (slot === 'shoes' && isAthleticShoeSubtype(sub)) raw += 0.3;
    if (slot === 'shoes' && isHeelFamilySubtype(sub)) raw -= 0.46;
  }

  if (target.lounge || target.sleep || target.travel) {
    raw += signals.comfort_score * 0.72;
    if (target.sleep && slot === 'shoes' && !isOpenCasualShoeSubtype(sub) && !isLoungeSubtype(sub)) raw -= 0.28;
  }

  if (target.beach || target.resort) {
    raw += signals.openness_score * 0.72;
    if (slot === 'shoes' && isOpenCasualShoeSubtype(sub)) raw += 0.22;
    if (slot === 'shoes' && canonicalizeSubtype(sub) === 'boots') raw -= 0.28;
  }

  if (intent.sport_context === 'gym') {
    if (slot === 'top') {
      if (itemLexicalFlags(item).gymTopAthleticCue || itemLexicalFlags(item).gymTopBasicCue) raw += 0.34;
      if (itemLexicalFlags(item).gymTopFormalCue) raw -= 0.42;
    } else if (slot === 'bottom') {
      if (itemLexicalFlags(item).gymBottomActiveCue) raw += 0.34;
      if (itemLexicalFlags(item).gymBottomTailoredCue) raw -= 0.42;
    } else if (slot === 'shoes') {
      if (isAthleticShoeSubtype(sub)) raw += 0.28;
      if (isFormalSubtype(sub) || isHeelFamilySubtype(sub)) raw -= 0.42;
    }
  }

  if (oldMoneyMensIntent(intent) && slot === 'top') {
    raw += oldMoneyMensTopTextScore(item) * 0.06;
  }

  const womenEveningRefinedFootwear =
    slot === 'shoes' &&
    intent.target_gender === 'women' &&
    intent.sport_context === 'none' &&
    (
      intent.activity_context.includes('dinner') ||
      intent.occasion_tags.includes('evening') ||
      intent.occasion_tags.includes('date_night') ||
      intent.vibe_tags.includes('chic') ||
      intent.vibe_tags.includes('formal')
    );
  if (womenEveningRefinedFootwear) {
    const text = itemText(item);
    if (isHeelFamilySubtype(sub) || /\bpump|pumps|heel|heels|slingback|mary jane|kitten heel|ankle boot|ankle boots|mule|mules|sandal|sandals\b/.test(text)) raw += 0.34;
    if (/\bloafer|loafers|boat shoe|boat shoes|oxford|oxfords|derby|derbies\b/.test(text)) raw -= 0.22;
    if (isAthleticShoeSubtype(sub)) raw -= 0.34;
  }

  return clamp01(0.5 + raw * 0.34);
}

function semanticPoolPaletteFit(item: IndexItem, intent: PromptIntent): number {
  const target = styleTarget(intent);
  const profile = itemColourProfile(item);

  if ((target.paletteMode === 'monochrome' || target.paletteMode === 'tonal') && target.paletteColours.length) {
    const hits = target.paletteColours.filter((colour) => itemHasColour(item, colour)).length;
    const foreignFamilies = profile.families.filter((colour) => !target.paletteColours.includes(colour));
    const tonalSupport = tonalSupportMatch(item, target.paletteColours);
    const aligned =
      (hits ? 0.66 + Math.min(0.24, hits * 0.13) : tonalSupport ? 0.42 : 0.08) -
      foreignFamilies.length * (target.paletteMode === 'monochrome' ? 0.28 : 0.16);
    return clamp01(aligned);
  }

  if (target.paletteMode === 'muted') {
    const loud = profile.chromatic.filter((colour) => colourProfile(colour)?.chroma === 'high').length;
    return clamp01(0.52 + profile.neutralCount * 0.12 - loud * 0.16);
  }

  if (target.paletteMode === 'colorful') {
    return clamp01(0.32 + Math.min(0.5, profile.chromatic.length * 0.18));
  }

  if (target.refined || target.classic || target.office) {
    return clamp01(0.48 + profile.neutralCount * 0.1 - Math.max(0, profile.chromatic.length - 1) * 0.08);
  }

  return 0.5;
}

function buildSemanticPoolForSlot(
  items: IndexItem[],
  slot: CategoryMain,
  intent: PromptIntent,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  perRoleLimit: number,
  promptEmbeddings: PromptEmbeddingState,
  embeddings: LoadedEmbeddings,
  preparedState?: PreparedSlotCandidateState,
): ScoredItem[] {
  const slotConstraint = preparedState?.slotConstraint || slotProfiles[slot];
  if (!promptEmbeddings.available || slotConstraint.lockMode === 'exact' || slotConstraint.lockMode === 'family') {
    return [];
  }
  const semanticContext = preparedState?.semanticContext || buildSemanticSlotContext(slot, slotConstraint, promptEmbeddings);
  const symbolicContext = preparedState?.symbolicContext || buildSymbolicSlotContext(slot, intent, slotConstraint);
  const preparedSource = preparedState?.prepared || [];
  const preparedMap = preparedSource.length
    ? new Map(preparedSource.map((entry) => [entry.item.id, entry]))
    : null;
  if (!preparedSource.length && !items.length) return [];

  const explorationBias = semanticPoolExplorationBias(intent, slotConstraint, promptEmbeddings);
  const anchoredConstraintMode = preparedState
    ? preparedState.anchoredConstraintMode
    : (
      (intent.outfit_mode === 'single' && intent.required_categories.length === 1 && intent.required_categories[0] === slot && slotHasIdentityAnchors(slotConstraint)) ||
      (slotConstraint.lockMode !== 'broad' && slotHasIdentityAnchors(slotConstraint) && slotHasExplicitConstraints(slotConstraint))
    );
  const anchorFloor = anchoredConstraintMode
    ? Math.max(0.34, 0.62 - explorationBias * 0.22)
    : 0;
  const stageCeiling =
    slotConstraint.lockMode === 'attribute'
      ? Math.min(5, 4 + Math.round(explorationBias))
      : 5;
  const target = styleTarget(intent);
  const semanticWeight =
    slotConstraint.lockMode === 'broad'
      ? 3.2 + explorationBias * 1.35
      : 2.55 + explorationBias * 1.1;
  const symbolicWeight =
    slotConstraint.lockMode === 'broad'
      ? 0.14 + (1 - explorationBias) * 0.1
      : 0.22 + (1 - explorationBias) * 0.16;
  const exactnessWeight = exactnessPenaltyWeight(slotConstraint) * (
    slotConstraint.lockMode === 'broad'
      ? (0.08 + (1 - explorationBias) * 0.08)
      : (0.14 + (1 - explorationBias) * 0.14)
  );
  const anchorWeight = anchoredConstraintMode ? 1.35 : 0.45;
  const poolLimit = semanticPoolOutputLimit(slotConstraint, perRoleLimit, explorationBias);

  const scored = (preparedSource.length ? preparedSource.map((entry) => entry.item) : globallyEligibleItemsForSlot(items, slot, intent))
    .map((item) => {
      const preparedEntry = preparedMap?.get(item.id);
      const stage = preparedEntry?.stage ?? exactnessTier(item, slot, slotConstraint);
      const anchorPreservation = preparedEntry?.anchorPreservation ?? anchorPreservationScore(item, slotConstraint);
      if (stage > stageCeiling) return null;
      if (anchoredConstraintMode && anchorPreservation < anchorFloor) return null;
      const symbolic = preparedEntry?.symbolic ?? symbolicItemScore(item, slot, intent, slotConstraint, symbolicContext);
      const semantic = semanticItemScore(item, slot, slotConstraint, promptEmbeddings, embeddings, semanticContext);
      const variantGroupKey = preparedEntry?.variantGroupKey ?? (item.variant_group_key || '');
      const variantBoosted = preparedEntry?.variantBoosted ?? !!(variantGroupKey && slotConstraint.variantGroupHints.includes(variantGroupKey));
      const negativeViolated = preparedEntry?.negativeViolated ?? slotNegativeViolation(item, slotConstraint);
      const cleanliness = semanticPoolConstraintCleanliness(item, slot, slotConstraint, anchorPreservation, negativeViolated);
      const roleFit = semanticPoolRoleFit(item, slot, intent);
      const paletteFit = semanticPoolPaletteFit(item, intent);
      const paletteWeight =
        target.paletteMode === 'monochrome'
          ? 0.72
          : target.paletteMode === 'tonal'
            ? 0.62
            : target.paletteMode !== 'unconstrained'
              ? 0.56
              : 0.14;
      const semanticLift =
        (1 + ((roleFit - 0.5) * (0.34 + explorationBias * 0.06))) *
        (1 + ((cleanliness - 0.5) * 0.42)) *
        (1 + ((paletteFit - 0.5) * paletteWeight));
      const semanticFirstScore =
        semantic * semanticWeight * semanticLift +
        symbolic * symbolicWeight +
        anchorPreservation * anchorWeight -
        stage * exactnessWeight -
        (negativeViolated ? 8.5 : 0);
      return {
        item,
        symbolic,
        outfitSymbolic: symbolic,
        semantic,
        stage,
        specificity: preparedEntry?.specificity ?? slotConstraint.specificity,
        family: preparedEntry?.family ?? itemFamily(item),
        brandKey: preparedEntry?.brandKey ?? itemBrandKey(item),
        colourFamily: preparedEntry?.colourFamily ?? itemColourFamily(item),
        variantGroupKey,
        variantBoosted,
        negativeViolated,
        anchorPreservation,
        roleFit: roleFit - 0.5,
        familyFit: paletteFit - 0.5,
        score: semanticFirstScore,
      } satisfies ScoredItem;
    })
    .filter((entry): entry is ScoredItem => !!entry)
    .sort((a, b) =>
      (b.score - a.score) ||
      (b.semantic - a.semantic) ||
      (a.stage - b.stage) ||
      (b.symbolic - a.symbolic)
    );

  const output: ScoredItem[] = [];
  const seenIds = new Set<string>();
  const seenFamilies = new Set<string>();
  const seenBrands = new Set<string>();
  const seenColours = new Set<string>();
  const semanticNoveltyTarget = Math.max(2, Math.ceil(poolLimit * (0.16 + explorationBias * 0.16)));

  for (const candidate of scored) {
    if (seenIds.has(candidate.item.id)) continue;
    const familyNovel = candidate.family && !seenFamilies.has(candidate.family);
    const brandNovel = candidate.brandKey && !seenBrands.has(candidate.brandKey);
    if (
      output.length < Math.max(6, Math.ceil(poolLimit * 0.45)) ||
      familyNovel ||
      brandNovel ||
      output.length < semanticNoveltyTarget
    ) {
      output.push(candidate);
      seenIds.add(candidate.item.id);
      if (candidate.family) seenFamilies.add(candidate.family);
      if (candidate.brandKey) seenBrands.add(candidate.brandKey);
      if (candidate.colourFamily) seenColours.add(candidate.colourFamily);
    }
    if (output.length >= poolLimit) break;
  }

  const noveltyReserveTarget =
    slotConstraint.lockMode === 'broad'
      ? Math.max(1, Math.ceil(poolLimit * (0.08 + explorationBias * 0.12)))
      : Math.max(0, Math.floor(poolLimit * 0.06));
  if (noveltyReserveTarget > 0 && output.length < poolLimit && scored.length) {
    const bestScore = scored[0]?.score || 0;
    const bestSymbolic = scored[0]?.symbolic || 0;
    const noveltyScoreFloor = bestScore - (slotConstraint.lockMode === 'broad' ? 1.8 + explorationBias * 1.1 : 1.25 + explorationBias * 0.7);
    const symbolicGuardFloor = bestSymbolic - (slotConstraint.lockMode === 'broad' ? 8 : 6);
    const noveltyCandidates = scored.filter((candidate) => {
      if (seenIds.has(candidate.item.id)) return false;
      if (candidate.score < noveltyScoreFloor) return false;
      if (candidate.symbolic < symbolicGuardFloor) return false;
      if ((candidate.roleFit || 0) < -0.1) return false;
      if ((candidate.familyFit || 0) < -0.18) return false;
      return (
        (!!candidate.family && !seenFamilies.has(candidate.family)) ||
        (!!candidate.brandKey && !seenBrands.has(candidate.brandKey)) ||
        (!!candidate.colourFamily && !seenColours.has(candidate.colourFamily))
      );
    });
    for (const candidate of noveltyCandidates) {
      if (output.length >= poolLimit) break;
      output.push(candidate);
      seenIds.add(candidate.item.id);
      if (candidate.family) seenFamilies.add(candidate.family);
      if (candidate.brandKey) seenBrands.add(candidate.brandKey);
      if (candidate.colourFamily) seenColours.add(candidate.colourFamily);
      if (output.length >= semanticNoveltyTarget + noveltyReserveTarget) break;
    }
  }

  const semanticAlternativeTarget =
    output.length < poolLimit &&
    (slotConstraint.lockMode === 'broad' || slotConstraint.lockMode === 'attribute')
      ? Math.max(1, Math.min(2, Math.ceil(explorationBias * 2)))
      : 0;
  if (semanticAlternativeTarget > 0 && scored.length) {
    const bestSemantic = scored[0]?.semantic || 0;
    const bestSymbolic = scored[0]?.symbolic || 0;
    const explicitPalette = target.paletteMode !== 'unconstrained';
    let added = 0;
    for (const candidate of scored) {
      if (output.length >= poolLimit || added >= semanticAlternativeTarget) break;
      if (seenIds.has(candidate.item.id)) continue;
      if (candidate.semantic < bestSemantic - (0.12 + explorationBias * 0.08)) continue;
      if (candidate.symbolic < bestSymbolic - (explicitPalette ? 7 : 9)) continue;
      if ((candidate.roleFit || 0) < -0.08) continue;
      if ((candidate.familyFit || 0) < (explicitPalette ? -0.06 : -0.2)) continue;
      output.push(candidate);
      seenIds.add(candidate.item.id);
      if (candidate.family) seenFamilies.add(candidate.family);
      if (candidate.brandKey) seenBrands.add(candidate.brandKey);
      if (candidate.colourFamily) seenColours.add(candidate.colourFamily);
      added += 1;
    }
  }

  if (output.length >= poolLimit || !scored.length) return output;
  for (const candidate of scored) {
    if (seenIds.has(candidate.item.id)) continue;
    output.push(candidate);
    seenIds.add(candidate.item.id);
    if (output.length >= poolLimit) break;
  }
  return output;
}

function filterCandidatesForSlot(
  items: IndexItem[],
  slot: CategoryMain,
  intent: PromptIntent,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  perRoleLimit: number,
  promptEmbeddings: PromptEmbeddingState,
  embeddings: LoadedEmbeddings,
  embeddingMode: EmbeddingMode,
): ScoredItem[] {
  const startedAt = Date.now();
  const preparedState = getPreparedCandidatesForSlot(
    items,
    slot,
    intent,
    slotProfiles,
    perRoleLimit,
    promptEmbeddings,
    false,
  );
  const { output, scoreMs, selectMs } = finalizePreparedCandidatesForSlot(
    preparedState,
    promptEmbeddings,
    embeddings,
    embeddingMode,
  );
  const totalMs = Date.now() - startedAt;
  if (totalMs >= 50) {
    logCandidateTiming('og_filter_candidates_slot_complete', {
      slot: preparedState.slot,
      total_ms: totalMs,
      base_ms: preparedState.timings.baseMs,
      tier_ms: preparedState.timings.tierMs,
      prep_ms: preparedState.timings.prepMs,
      score_ms: scoreMs,
      select_ms: selectMs,
      slot_items: preparedState.timings.rawSlotItems,
      base_all: preparedState.timings.baseAll,
      base: preparedState.timings.base,
      scoring_pool: preparedState.prepared.length,
      selected: output.length,
      embedding_mode: embeddingMode,
      lock_mode: preparedState.slotConstraint.lockMode,
    });
  }
  return output;
}

function synthesizePromptEmbeddingsFromCandidates(
  current: PromptEmbeddingState,
  candidatesBySlot: Record<CategoryMain, ScoredItem[]>,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  embeddings: LoadedEmbeddings,
): PromptEmbeddingState {
  if (current.available) return current;
  const promptVectors: Array<{ vector: number[]; weight: number }> = [];
  const identityVectors: Array<{ vector: number[]; weight: number }> = [];
  const styleVectors: Array<{ vector: number[]; weight: number }> = [];
  const slotPromptVectors: Partial<Record<CategoryMain, number[]>> = {};
  const slotIdentityVectors: Partial<Record<CategoryMain, number[]>> = {};
  const slotStyleVectors: Partial<Record<CategoryMain, number[]>> = {};

  for (const slot of SLOT_ORDER) {
    const profile = slotProfiles[slot];
    const slotCandidates = candidatesBySlot[slot].slice(0, profile.lockMode === 'exact' ? 1 : profile.lockMode === 'family' ? 2 : 3);
    const slotCombined = weightedAverageVectors(slotCandidates.map((candidate, index) => ({
      vector: embeddings.itemVectors.get(candidate.item.id) || [],
      weight: Math.max(0.1, candidate.symbolic + 8 - index),
    })));
    const slotIdentity = weightedAverageVectors(slotCandidates.map((candidate, index) => ({
      vector: embeddings.slotIdentityVectors[slot].get(candidate.item.id) || embeddings.identityVectors.get(candidate.item.id) || [],
      weight: Math.max(0.1, candidate.symbolic + 8 - index),
    })));
    const slotStyle = weightedAverageVectors(slotCandidates.map((candidate, index) => ({
      vector: embeddings.slotStyleVectors[slot].get(candidate.item.id) || embeddings.styleVectors.get(candidate.item.id) || [],
      weight: Math.max(0.1, candidate.symbolic + 8 - index),
    })));
    if (slotCombined.length) {
      slotPromptVectors[slot] = slotCombined;
      promptVectors.push({ vector: slotCombined, weight: ROLE_WEIGHTS[slot] });
    }
    if (slotIdentity.length) {
      slotIdentityVectors[slot] = slotIdentity;
      identityVectors.push({ vector: slotIdentity, weight: ROLE_WEIGHTS[slot] * (profile.lockMode === 'broad' ? 0.35 : 1) });
    }
    if (slotStyle.length) {
      slotStyleVectors[slot] = slotStyle;
      styleVectors.push({ vector: slotStyle, weight: ROLE_WEIGHTS[slot] * (profile.lockMode === 'broad' ? 1.2 : 0.85) });
    }
  }

  const promptVector = weightedAverageVectors(promptVectors);
  const identityVector = weightedAverageVectors(identityVectors);
  const styleVector = weightedAverageVectors(styleVectors);
  if (!promptVector.length && !identityVector.length && !styleVector.length) return current;
  return {
    active: false,
    available: true,
    source: 'surrogate',
    reason: 'surrogate_query_vector',
    promptVector,
    identityVector,
    styleVector,
    slotPromptVectors,
    slotIdentityVectors,
    slotStyleVectors,
  };
}

async function warmPairwiseCompatibilityCache(candidatesBySlot: Record<CategoryMain, ScoredItem[]>) {
  const itemMap = new Map<string, IndexItem>();
  for (const slot of SLOT_ORDER) {
    for (const candidate of candidatesBySlot[slot]) itemMap.set(candidate.item.id, candidate.item);
  }
  const items = Array.from(itemMap.values());
  const missingPairs: Array<{ left: IndexItem; right: IndexItem; cacheKey: string; persistentKey: string }> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const left = items[i].id < items[j].id ? items[i] : items[j];
      const right = items[i].id < items[j].id ? items[j] : items[i];
      const cacheKey = `${left.id}|${right.id}`;
      const persistentKey = pairwisePersistentKey(left, right);
      if (REQUEST_MEMO?.pairwiseBase.has(cacheKey) || GLOBAL_PAIRWISE_BASE_CACHE.has(persistentKey)) continue;
      missingPairs.push({ left, right, cacheKey, persistentKey });
    }
  }
  if (missingPairs.length) {
    const durable = await loadDurablePairwiseScores(missingPairs.map((entry) => entry.persistentKey));
    for (const entry of missingPairs) {
      const value = durable.get(entry.persistentKey);
      if (!Number.isFinite(value)) continue;
      GLOBAL_PAIRWISE_BASE_CACHE.set(entry.persistentKey, value);
      REQUEST_MEMO?.pairwiseBase.set(entry.cacheKey, value);
    }
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      pairwiseBaseScore(items[i], items[j]);
    }
  }
}

function approximateOutfitScore(
  outfit: Outfit,
  scoreLookup: Record<string, ScoredItem>,
  intent: PromptIntent,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
): number {
  const symbolic = outfitItems(outfit).reduce((sum, item) => sum + (scoreLookup[item.id]?.outfitSymbolic ?? scoreLookup[item.id]?.symbolic ?? 0), 0) + pairwiseScore(outfit, intent);
  const exactnessPenalty = SLOT_ORDER.reduce((sum, slot) => {
    const item = outfit[slot];
    if (!item) return sum;
    const scoredItem = scoreLookup[item.id];
    if (!scoredItem) return sum;
    return sum + scoredItem.stage * exactnessPenaltyWeight(slotProfiles[slot]);
  }, 0);
  return symbolic - exactnessPenalty;
}

function searchSlotOrder(
  candidatesBySlot: Record<CategoryMain, ScoredItem[]>,
  intent: PromptIntent,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
): CategoryMain[] {
  const required = new Set(intent.required_categories);
  return SLOT_ORDER
    .filter((slot) =>
      required.has(slot) ||
      (intent.optional_categories.includes(slot) && candidatesBySlot[slot].length > 0),
    )
    .sort((left, right) => {
      const leftRequired = required.has(left) ? 0 : 1;
      const rightRequired = required.has(right) ? 0 : 1;
      if (leftRequired !== rightRequired) return leftRequired - rightRequired;
      const leftLock = slotLockRank(slotProfiles[left]);
      const rightLock = slotLockRank(slotProfiles[right]);
      if (leftLock !== rightLock) return leftLock - rightLock;
      const leftCount = candidatesBySlot[left].length || Number.MAX_SAFE_INTEGER;
      const rightCount = candidatesBySlot[right].length || Number.MAX_SAFE_INTEGER;
      if (leftCount !== rightCount) return leftCount - rightCount;
      const leftBroadness = slotBroadness(slotProfiles[left]);
      const rightBroadness = slotBroadness(slotProfiles[right]);
      if (leftBroadness !== rightBroadness) return leftBroadness - rightBroadness;
      return SLOT_ORDER.indexOf(left) - SLOT_ORDER.indexOf(right);
    });
}

function selectBeamStates(
  expanded: Array<{ outfit: Outfit; score: number }>,
  activeSlots: CategoryMain[],
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  beamWidth: number,
): Array<{ outfit: Outfit; score: number }> {
  if (!expanded.length) return [];
  expanded.sort((a, b) => b.score - a.score);
  const broadness = activeSlots.length
    ? activeSlots.reduce((sum, slot) => sum + slotBroadness(slotProfiles[slot]), 0) / activeSlots.length
    : 0.5;
  const scoreFloor = expanded[0].score - (3.2 + broadness * 4.2);
  const band = expanded
    .filter((entry, index) => index < beamWidth * 3 || entry.score >= scoreFloor)
    .slice(0, Math.max(beamWidth * 4, beamWidth));
  const selected: Array<{ outfit: Outfit; score: number }> = [];
  const usedSignatures = new Set<string>();
  const seenCoreSignatures = new Set<string>();
  const seenIds: Record<CategoryMain, Set<string>> = { top: new Set(), bottom: new Set(), shoes: new Set(), mono: new Set() };
  const seenFamilies: Record<CategoryMain, Set<string>> = { top: new Set(), bottom: new Set(), shoes: new Set(), mono: new Set() };
  const remainingCounts: Record<CategoryMain, Map<string, number>> = {
    top: new Map(),
    bottom: new Map(),
    shoes: new Map(),
    mono: new Map(),
  };
  for (const slot of activeSlots) {
    for (const entry of band) {
      const id = entry.outfit[slot]?.id;
      if (!id) continue;
      remainingCounts[slot].set(id, (remainingCounts[slot].get(id) || 0) + 1);
    }
  }
  const slotTargets: Partial<Record<CategoryMain, number>> = {};
  for (const slot of activeSlots) {
    if (slotProfiles[slot].diversityExempt) continue;
    const uniqueCount = remainingCounts[slot].size;
    const targetBase = Math.ceil(Math.sqrt(Math.max(Math.min(beamWidth, band.length), 1)) * (0.75 + slotBroadness(slotProfiles[slot]) * 0.35));
    slotTargets[slot] = Math.min(uniqueCount, Math.max(2, targetBase));
  }
  const encourageCoreDiversity =
    activeSlots.includes('top') &&
    activeSlots.includes('bottom') &&
    slotBroadness(slotProfiles.top) >= 0.45 &&
    slotBroadness(slotProfiles.bottom) >= 0.45 &&
    !slotProfiles.top.diversityExempt &&
    !slotProfiles.bottom.diversityExempt;
  const remainingUnusedIds = (slot: CategoryMain): number => {
    let count = 0;
    for (const id of remainingCounts[slot].keys()) {
      if (!seenIds[slot].has(id)) count += 1;
    }
    return count;
  };

  while (selected.length < beamWidth && band.length) {
    let bestIndex = 0;
    let bestAdjusted = -Infinity;
    for (let i = 0; i < band.length; i++) {
      const candidate = band[i];
      const signature = outfitSignature(candidate.outfit);
      if (usedSignatures.has(signature)) continue;
      let adjusted = candidate.score;
      for (const slot of activeSlots) {
        if (slotProfiles[slot].diversityExempt) continue;
        const item = candidate.outfit[slot];
        if (!item) continue;
        const roleWeight = DIVERSITY_ROLE_WEIGHTS[slot] * slotBroadness(slotProfiles[slot]);
        const family = itemFamily(item);
        const target = slotTargets[slot] || 0;
        const targetUnmet = target > 0 && seenIds[slot].size < target;
        const unusedCount = remainingUnusedIds(slot);
        const canStillHitTarget = seenIds[slot].size + unusedCount >= target;
        if (!seenIds[slot].has(item.id)) adjusted += roleWeight * (targetUnmet ? 4.8 : 1.3);
        else adjusted -= roleWeight * (targetUnmet && canStillHitTarget ? 12.5 : targetUnmet ? 5.0 : 1.5);
        if (family && !seenFamilies[slot].has(family)) adjusted += roleWeight * (targetUnmet ? 1.35 : 0.7);
        else if (family) adjusted -= roleWeight * (targetUnmet ? 0.85 : 0.24);
      }
      if (encourageCoreDiversity) {
        const coreSignature = coreOutfitSignature(candidate.outfit);
        if (coreSignature) {
          if (!seenCoreSignatures.has(coreSignature)) adjusted += 5.4 * broadness;
          else adjusted -= 10.8 * broadness;
        }
      }
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIndex = i;
      }
    }
    const chosen = band.splice(bestIndex, 1)[0];
    const signature = outfitSignature(chosen.outfit);
    if (usedSignatures.has(signature)) continue;
    usedSignatures.add(signature);
    selected.push(chosen);
    if (encourageCoreDiversity) {
      const coreSignature = coreOutfitSignature(chosen.outfit);
      if (coreSignature) seenCoreSignatures.add(coreSignature);
    }
    for (const slot of activeSlots) {
      const item = chosen.outfit[slot];
      if (!item) continue;
      const current = remainingCounts[slot].get(item.id) || 0;
      if (current <= 1) remainingCounts[slot].delete(item.id);
      else remainingCounts[slot].set(item.id, current - 1);
      seenIds[slot].add(item.id);
      const family = itemFamily(item);
      if (family) seenFamilies[slot].add(family);
    }
  }

  return selected;
}

function assembleOutfitsBeam(
  candidatesBySlot: Record<CategoryMain, ScoredItem[]>,
  intent: PromptIntent,
  scoreLookup: Record<string, ScoredItem>,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  poolSize: number,
): Outfit[] {
  const slots = searchSlotOrder(candidatesBySlot, intent, slotProfiles);
  const wantsRequired = new Set(intent.required_categories);
  const estimatedProduct = slots.reduce((product, slot) => product * Math.max(1, candidatesBySlot[slot].length), 1);
  const beamWidth = Math.max(DEFAULT_BEAM_WIDTH, poolSize * 32, Math.min(640, Math.ceil(Math.sqrt(estimatedProduct) * 2.4)));
  let beam: Array<{ outfit: Outfit; score: number }> = [{ outfit: {}, score: 0 }];

  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    const slot = slots[slotIndex];
    const pool = candidatesBySlot[slot];
    if (!pool.length) {
      if (wantsRequired.has(slot)) return [];
      continue;
    }
    const expanded: Array<{ outfit: Outfit; score: number }> = [];
    for (const state of beam) {
      for (const candidate of pool) {
        const outfit = { ...state.outfit, [slot]: candidate.item } as Outfit;
        expanded.push({
          outfit,
          score: approximateOutfitScore(outfit, scoreLookup, intent, slotProfiles),
        });
      }
    }
    beam = selectBeamStates(expanded, slots.slice(0, slotIndex + 1), slotProfiles, beamWidth);
  }

  return beam
    .map((state) => state.outfit)
    .filter((outfit) => intent.required_categories.every((slot) => !!outfit[slot]));
}

function assembleOutfits(
  candidatesBySlot: Record<CategoryMain, ScoredItem[]>,
  intent: PromptIntent,
  scoreLookup: Record<string, ScoredItem>,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  poolSize: number,
): Outfit[] {
  const required = intent.required_categories;
  const outfits: Outfit[] = [];
  if (intent.requested_form === 'mono_only') {
    for (const mono of candidatesBySlot.mono) outfits.push({ mono: mono.item });
    return outfits;
  }
  if (intent.requested_form === 'mono_and_shoes') {
    for (const mono of candidatesBySlot.mono) {
      const shoesPool = candidatesBySlot.shoes.length ? candidatesBySlot.shoes : [{ item: undefined } as any];
      for (const shoes of shoesPool) outfits.push({ mono: mono.item, shoes: shoes.item });
    }
    return outfits;
  }
  if (required.length === 1) {
    const slot = required[0];
    for (const item of candidatesBySlot[slot]) outfits.push({ [slot]: item.item } as Outfit);
    return outfits;
  }
  const tops = candidatesBySlot.top.length ? candidatesBySlot.top : [{ item: undefined } as any];
  const bottoms = candidatesBySlot.bottom.length ? candidatesBySlot.bottom : [{ item: undefined } as any];
  const shoes = candidatesBySlot.shoes.length ? candidatesBySlot.shoes : [{ item: undefined } as any];
  const wantsShoes = required.includes('shoes') || intent.optional_categories.includes('shoes');
  const estimatedProduct = tops.length * bottoms.length * (wantsShoes ? shoes.length : 1);
  if (estimatedProduct > BEAM_OUTFIT_PRODUCT_THRESHOLD) {
    return assembleOutfitsBeam(candidatesBySlot, intent, scoreLookup, slotProfiles, poolSize);
  }
  for (const top of tops) {
    for (const bottom of bottoms) {
      if (wantsShoes && shoes.length) {
        for (const shoe of shoes) outfits.push({ top: top.item, bottom: bottom.item, shoes: shoe.item });
      } else {
        outfits.push({ top: top.item, bottom: bottom.item });
      }
    }
  }
  return outfits.filter((outfit) => {
    for (const slot of required) {
      if (!outfit[slot]) return false;
    }
    return true;
  });
}

function outfitItems(outfit: Outfit): IndexItem[] {
  return SLOT_ORDER.map((slot) => outfit[slot]).filter((item): item is IndexItem => !!item);
}

function outfitSignature(outfit: Outfit): string {
  return outfitItems(outfit).map((item) => item.id).sort().join('|');
}

function coreOutfitSignature(outfit: Outfit): string {
  if (outfit.mono?.id) return `mono:${outfit.mono.id}`;
  const topId = outfit.top?.id || '';
  const bottomId = outfit.bottom?.id || '';
  if (!topId && !bottomId) return '';
  return `top:${topId || '-'}|bottom:${bottomId || '-'}`;
}

function fullOutfitDiversityIntent(intent: PromptIntent): boolean {
  if (intent.assembly_mode !== 'full_outfit') return false;
  const slots = uniq([...(intent.required_categories || []), ...(intent.optional_categories || [])]);
  const effectiveSlots = (slots.length ? slots : SLOT_ORDER).filter(Boolean);
  if (effectiveSlots.length < 2) return false;
  return intent.requested_form !== 'mono_only' && intent.requested_form !== 'mono_and_shoes';
}

function itemFamily(item: IndexItem | undefined): string {
  if (!item) return '';
  const cacheKey = requestItemKey(item);
  if (cacheKey && REQUEST_MEMO?.itemFamily.has(cacheKey)) return REQUEST_MEMO.itemFamily.get(cacheKey)!;
  const precomputed = readPrecomputedItemFeatures(item);
  const value = precomputed?.itemFamily || (subtypeFamily(item.sub || '').find((family) => !family.includes('/')) || canonicalizeSubtype(item.sub || ''));
  if (cacheKey) REQUEST_MEMO?.itemFamily.set(cacheKey, value);
  return value;
}

function scoreOutfitCandidate(
  outfit: Outfit,
  slotScores: Record<string, ScoredItem>,
  intent: PromptIntent,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  promptEmbeddings: PromptEmbeddingState,
  embeddings: LoadedEmbeddings,
  embeddingMode: EmbeddingMode,
  jitter: number,
): ScoredOutfit {
  const items = outfitItems(outfit);
  const symbolic = items.reduce((sum, item) => sum + (slotScores[item.id]?.outfitSymbolic ?? slotScores[item.id]?.symbolic ?? 0), 0) + pairwiseScore(outfit, intent);
  const semanticBundle = embeddingMode === 'off'
    ? { score: 0, vector: [] as number[] }
    : semanticOutfitScore(outfit, slotProfiles, promptEmbeddings, embeddings);
  const semanticWeight = embeddingMode === 'off' ? 0 : embeddingOutfitWeight(slotProfiles, outfit);
  const stages = SLOT_ORDER.map((slot) => {
    const item = outfit[slot];
    return item ? (slotScores[item.id]?.stage ?? 5) : 0;
  }).filter((stage) => Number.isFinite(stage));
  const maxStage = stages.length ? Math.max(...stages) : 0;
  const stageSum = stages.reduce((sum, stage) => sum + stage, 0);
  const exactnessPenalty = SLOT_ORDER.reduce((sum, slot) => {
    const item = outfit[slot];
    if (!item) return sum;
    const scoredItem = slotScores[item.id];
    if (!scoredItem) return sum;
    return sum + scoredItem.stage * exactnessPenaltyWeight(slotProfiles[slot]);
  }, 0);
  const noise = jitter > 0 ? (REQUEST_RANDOM() * 2 - 1) * jitter : 0;
  const slotMetadata = Object.fromEntries(
    SLOT_ORDER.map((slot) => {
      const item = outfit[slot];
      return [slot, item ? {
        id: item.id,
        family: slotScores[item.id]?.family || itemFamily(item),
        brand: slotScores[item.id]?.brandKey || itemBrandKey(item),
        colourFamily: slotScores[item.id]?.colourFamily || itemColourFamily(item),
      } : null];
    }),
  ) as ScoredOutfit['slotMetadata'];
  return {
    outfit,
    symbolic,
    semantic: semanticBundle.score,
    vector: semanticBundle.vector,
    maxStage,
    stageSum,
    score: symbolic + semanticBundle.score * semanticWeight - exactnessPenalty + noise,
    signature: outfitSignature(outfit),
    coreSignature: coreOutfitSignature(outfit),
    paletteSignature: paletteSignature(outfit),
    slotMetadata,
  };
}

function semanticSimilarity(a: ScoredOutfit, b: ScoredOutfit): number {
  if (!a.vector.length || !b.vector.length) return 0;
  return cosineSimilarityCached(a.vector, b.vector);
}

function itemBrandKey(item: IndexItem | undefined): string {
  if (!item) return '';
  const cacheKey = requestItemKey(item);
  if (cacheKey && REQUEST_MEMO?.itemBrand.has(cacheKey)) return REQUEST_MEMO.itemBrand.get(cacheKey)!;
  const precomputed = readPrecomputedItemFeatures(item);
  const value = precomputed?.itemBrand || normalizeText(((item.entityMeta || []).find((entry) => entry.type === 'brand' && entry.text)?.text) || '');
  if (cacheKey) REQUEST_MEMO?.itemBrand.set(cacheKey, value);
  return value;
}

function itemColourFamily(item: IndexItem | undefined): string {
  if (!item || !item.colours?.length) return '';
  const cacheKey = requestItemKey(item);
  if (cacheKey && REQUEST_MEMO?.itemColourFamily.has(cacheKey)) return REQUEST_MEMO.itemColourFamily.get(cacheKey)!;
  const precomputed = readPrecomputedItemFeatures(item);
  const value = precomputed?.itemColourFamily || (() => {
    const colours = uniq(item.colours!.map((colour) => normalizeText(colour)).filter(Boolean));
    const chroma = colours.filter((colour) => !['black', 'white', 'grey', 'beige', 'brown'].includes(colour));
    return chroma.length ? chroma.sort().join('+') : colours.sort().join('+');
  })();
  if (cacheKey) REQUEST_MEMO?.itemColourFamily.set(cacheKey, value);
  return value;
}

function uniquenessTargets(
  intent: PromptIntent,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  candidateBand: ScoredOutfit[],
  poolSize: number,
): Partial<Record<CategoryMain, number>> {
  const uniques: Record<CategoryMain, Set<string>> = { top: new Set(), bottom: new Set(), shoes: new Set(), mono: new Set() };
  for (const candidate of candidateBand) {
    for (const slot of SLOT_ORDER) {
      const item = candidate.outfit[slot];
      if (item) uniques[slot].add(item.id);
    }
  }
  const targetForSlot = (slot: CategoryMain): number => {
    const uniqueCount = uniques[slot].size;
    const profile = slotProfiles[slot];
    const broadness = slotBroadness(profile);
    const broadTarget = slot === 'top' || slot === 'mono' ? poolSize : Math.max(1, poolSize - 1);
    const narrowTarget =
      profile.lockMode === 'exact'
        ? 1
        : profile.lockMode === 'family'
          ? Math.min(uniqueCount, 2)
          : profile.lockMode === 'attribute'
            ? Math.min(uniqueCount, Math.max(2, Math.ceil(poolSize * 0.65)))
            : broadTarget;
    let target = Math.round(narrowTarget + ((broadTarget - narrowTarget) * broadness));
    const structurallyBroad = poolSize >= 4 && slotStructurallyBroadForDiversity(profile, intent);
    if (slot === 'top' && structurallyBroad) {
      target = Math.max(target, Math.min(uniqueCount, Math.max(4, Math.ceil(poolSize * 0.55))));
    }
    if (slot === 'bottom' && structurallyBroad) {
      target = Math.max(target, Math.min(uniqueCount, Math.max(3, Math.ceil(poolSize * 0.42))));
    }
    return Math.min(uniqueCount, Math.max(1, target));
  };
  if (intent.requested_form === 'mono_only') return { mono: targetForSlot('mono') };
  if (intent.requested_form === 'mono_and_shoes') {
    return { mono: targetForSlot('mono'), shoes: targetForSlot('shoes') };
  }
  return {
    top: targetForSlot('top'),
    bottom: targetForSlot('bottom'),
    shoes: targetForSlot('shoes'),
  };
}

function selectDiversifiedOutfits(
  scored: ScoredOutfit[],
  intent: PromptIntent,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  scoreLookup: Record<string, ScoredItem>,
  poolSize: number,
  epsilon: number,
): ScoredOutfit[] {
  if (!scored.length) return [];
  const hasAnchoredSlot = SLOT_ORDER.some((slot) => slotProfiles[slot].lockMode !== 'broad');
  if (epsilon <= 0 && !hasAnchoredSlot) {
    const selected: ScoredOutfit[] = [];
    const usedSignatures = new Set<string>();
    for (const candidate of scored) {
      const signature = candidate.signature || outfitSignature(candidate.outfit);
      if (usedSignatures.has(signature)) continue;
      usedSignatures.add(signature);
      selected.push(candidate);
      if (selected.length >= poolSize) break;
    }
    return selected;
  }
  const targetSlots = uniq([...intent.required_categories, ...intent.optional_categories]);
  const broadness = targetSlots.length
    ? targetSlots.reduce((sum, slot) => sum + slotBroadness(slotProfiles[slot]), 0) / targetSlots.length
    : 0.5;
  const bandSize = Math.min(scored.length, Math.max(poolSize * 32, Math.round(poolSize * 14 + broadness * 1200)));
  const structurallyBroadTop = slotStructurallyBroadForDiversity(slotProfiles.top, intent);
  const structurallyBroadBottom = slotStructurallyBroadForDiversity(slotProfiles.bottom, intent);
  const wideBandSource =
    fullOutfitDiversityIntent(intent) &&
    poolSize > 1 &&
    (structurallyBroadTop || structurallyBroadBottom);
  const bandSource = scored.slice(
    0,
    Math.min(
      scored.length,
      wideBandSource
        ? Math.max(bandSize * 6, 8000)
        : Math.max(bandSize, bandSize * 3),
    ),
  );
  const band = (() => {
    if (poolSize <= 1 || !bandSource.length) return bandSource.slice(0, bandSize);
    const selectedBand: ScoredOutfit[] = [];
    const usedOutfitSignatures = new Set<string>();
    const coreCounts = new Map<string, number>();
    const uniqueCoreCount = new Set(
      bandSource.map((candidate) => candidate.coreSignature || coreOutfitSignature(candidate.outfit)).filter(Boolean),
    ).size;
    const enforceCoreCap =
      fullOutfitDiversityIntent(intent) &&
      uniqueCoreCount >= Math.max(3, Math.ceil(poolSize * 0.6));
    const coreRepeatLimit = enforceCoreCap ? 1 : 2;
    const pushCandidate = (candidate: ScoredOutfit, ignoreCoreCap = false): boolean => {
      const signature = candidate.signature || outfitSignature(candidate.outfit);
      if (usedOutfitSignatures.has(signature)) return false;
      const coreSignature = candidate.coreSignature || coreOutfitSignature(candidate.outfit);
      if (
        !ignoreCoreCap &&
        enforceCoreCap &&
        coreSignature &&
        (coreCounts.get(coreSignature) || 0) >= coreRepeatLimit
      ) {
        return false;
      }
      usedOutfitSignatures.add(signature);
      selectedBand.push(candidate);
      if (coreSignature) {
        coreCounts.set(coreSignature, (coreCounts.get(coreSignature) || 0) + 1);
      }
      return selectedBand.length >= bandSize;
    };

    const topBroad = slotBroadness(slotProfiles.top) >= 0.45 && !slotProfiles.top.diversityExempt;
    if (fullOutfitDiversityIntent(intent) && topBroad) {
      const seenTopIds = new Set<string>();
      for (const candidate of bandSource) {
        const topId = candidate.outfit.top?.id || '';
        if (!topId || seenTopIds.has(topId)) continue;
        seenTopIds.add(topId);
        if (pushCandidate(candidate)) return selectedBand;
      }
    }

    if (fullOutfitDiversityIntent(intent)) {
      const seenCorePairs = new Set<string>();
      for (const candidate of bandSource) {
        const topId = candidate.outfit.top?.id || '';
        const bottomId = candidate.outfit.bottom?.id || '';
        const monoId = candidate.outfit.mono?.id || '';
        const pairKey = monoId
          ? `mono:${monoId}`
          : topId || bottomId
            ? `top:${topId}|bottom:${bottomId}`
            : '';
        if (!pairKey || seenCorePairs.has(pairKey)) continue;
        seenCorePairs.add(pairKey);
        if (pushCandidate(candidate)) return selectedBand;
      }
    }

    for (const candidate of bandSource) {
      if (pushCandidate(candidate)) break;
    }
    if (selectedBand.length < bandSize) {
      for (const candidate of bandSource) {
        if (pushCandidate(candidate, true)) break;
      }
    }
    return selectedBand;
  })();
  const targets = uniquenessTargets(intent, slotProfiles, band, poolSize);
  const selected: ScoredOutfit[] = [];
  const usedSignatures = new Set<string>();
  const seenCoreSignatures = new Set<string>();
  const seenPaletteSignatures = new Set<string>();
  const seenIds: Record<CategoryMain, Set<string>> = { top: new Set(), bottom: new Set(), shoes: new Set(), mono: new Set() };
  const seenFamilies: Record<CategoryMain, Set<string>> = { top: new Set(), bottom: new Set(), shoes: new Set(), mono: new Set() };
  const seenBrands: Record<CategoryMain, Set<string>> = { top: new Set(), bottom: new Set(), shoes: new Set(), mono: new Set() };
  const seenColourFamilies: Record<CategoryMain, Set<string>> = { top: new Set(), bottom: new Set(), shoes: new Set(), mono: new Set() };
  const remainingCounts: Record<CategoryMain, Map<string, number>> = {
    top: new Map(),
    bottom: new Map(),
    shoes: new Map(),
    mono: new Map(),
  };
  const remainingUnusedCounts: Record<CategoryMain, number> = { top: 0, bottom: 0, shoes: 0, mono: 0 };
  const slotBroadnessMap: Record<CategoryMain, number> = {
    top: slotBroadness(slotProfiles.top),
    bottom: slotBroadness(slotProfiles.bottom),
    shoes: slotBroadness(slotProfiles.shoes),
    mono: slotBroadness(slotProfiles.mono),
  };
  const similarityCache = new Map<string, number>();
  const slotMetaFor = (
    candidate: ScoredOutfit,
    slot: CategoryMain,
  ): { id: string; family: string; brand: string; colourFamily: string } | null =>
    candidate.slotMetadata?.[slot] || (() => {
      const item = candidate.outfit[slot];
      if (!item) return null;
      return {
        id: item.id,
        family: itemFamily(item),
        brand: itemBrandKey(item),
        colourFamily: itemColourFamily(item),
      };
    })();
  const similarityFor = (left: ScoredOutfit, right: ScoredOutfit): number => {
    const leftKey = left.signature || outfitSignature(left.outfit);
    const rightKey = right.signature || outfitSignature(right.outfit);
    const key = leftKey < rightKey ? `${leftKey}|${rightKey}` : `${rightKey}|${leftKey}`;
    if (similarityCache.has(key)) return similarityCache.get(key)!;
    const value = semanticSimilarity(left, right);
    similarityCache.set(key, value);
    return value;
  };
  const availableUniqueCounts: Record<CategoryMain, number> = { top: 0, bottom: 0, shoes: 0, mono: 0 };
  for (const slot of SLOT_ORDER) {
    for (const candidate of band) {
      const id = candidate.outfit[slot]?.id || '';
      if (!id) continue;
      remainingCounts[slot].set(id, (remainingCounts[slot].get(id) || 0) + 1);
    }
    availableUniqueCounts[slot] = remainingCounts[slot].size;
    remainingUnusedCounts[slot] = remainingCounts[slot].size;
  }
  const maxAvailableUnique = Math.max(...SLOT_ORDER.map((slot) => availableUniqueCounts[slot]));
  const slotCoverageNeed = (slot: CategoryMain): number => {
    if (slotProfiles[slot].diversityExempt) return 0;
    const target = targets[slot] || 0;
    if (!target) return 0;
    const deficit = Math.max(0, target - seenIds[slot].size);
    if (!deficit) return 0;
    const available = Math.max(1, availableUniqueCounts[slot]);
    const scarcity = maxAvailableUnique > 0 ? (maxAvailableUnique / available) : 1;
    return (deficit / target) * DIVERSITY_ROLE_WEIGHTS[slot] * Math.max(0.45, slotBroadnessMap[slot]) * scarcity;
  };
  const candidateCoverageGain = (candidate: ScoredOutfit, focusSlots: CategoryMain[]): number => {
    let gain = 0;
    for (const slot of focusSlots) {
      if (slotProfiles[slot].diversityExempt) continue;
      const target = targets[slot] || 0;
      if (!target || seenIds[slot].size >= target) continue;
      const meta = slotMetaFor(candidate, slot);
      if (!meta) continue;
      const roleWeight = DIVERSITY_ROLE_WEIGHTS[slot] * Math.max(0.45, slotBroadnessMap[slot]);
      if (!seenIds[slot].has(meta.id)) gain += roleWeight * 3.4;
      if (meta.family && !seenFamilies[slot].has(meta.family)) gain += roleWeight * 1.15;
      if (meta.colourFamily && !seenColourFamilies[slot].has(meta.colourFamily)) gain += roleWeight * 0.7;
    }
    return gain;
  };
  const candidateImprovesCoverage = (candidate: ScoredOutfit, focusSlots: CategoryMain[]): boolean => {
    for (const slot of SLOT_ORDER) {
      if (!focusSlots.includes(slot)) continue;
      if (slotProfiles[slot].diversityExempt) continue;
      const target = targets[slot] || 0;
      if (!target || seenIds[slot].size >= target) continue;
      const meta = slotMetaFor(candidate, slot);
      if (!meta) continue;
      if (!seenIds[slot].has(meta.id)) return true;
      if (meta.family && !seenFamilies[slot].has(meta.family)) return true;
      if (meta.colourFamily && !seenColourFamilies[slot].has(meta.colourFamily)) return true;
    }
    return false;
  };

  while (selected.length < poolSize && band.length) {
    const needScores = SLOT_ORDER.map((slot) => ({ slot, need: slotCoverageNeed(slot) }))
      .filter((entry) => entry.need > 0)
      .sort((a, b) => b.need - a.need);
    const prioritySlots = needScores.length
      ? needScores.filter((entry) => entry.need >= needScores[0].need * 0.82).map((entry) => entry.slot)
      : [];
    const rescored = band.map((candidate) => {
      let adjusted = candidate.score;
      const candidatePalette = candidate.paletteSignature || paletteSignature(candidate.outfit);
      const paletteNoveltyWeight =
        intent.palette_mode === 'colorful'
          ? 1.25
          : intent.palette_mode === 'unconstrained'
            ? 0.8
            : 0.3;
      const remainingLooks = poolSize - selected.length;
      for (const slot of SLOT_ORDER) {
        if (slotProfiles[slot].diversityExempt) continue;
        const item = candidate.outfit[slot];
        const meta = slotMetaFor(candidate, slot);
        if (!item || !meta) continue;
        const family = meta.family;
        const brand = meta.brand;
        const colourFamily = meta.colourFamily;
        const scoreMeta = scoreLookup[item.id];
        const variantGroupKey = scoreMeta?.variantGroupKey || item.variant_group_key || '';
        const inVariantGroup = !!(variantGroupKey && slotProfiles[slot].variantGroupHints.includes(variantGroupKey));
        const target = targets[slot] || 0;
        const slotWide = slotBroadnessMap[slot];
        const roleWeight = DIVERSITY_ROLE_WEIGHTS[slot];
        const targetUnmet = seenIds[slot].size < target;
        const remainingUnusedIds = remainingUnusedCounts[slot];
        const canStillHitTarget = seenIds[slot].size + remainingUnusedIds >= Math.min(target, selected.length + remainingLooks);
        if (!seenIds[slot].has(meta.id)) adjusted += roleWeight * (targetUnmet ? 5.4 : 1.3) * slotWide;
        else adjusted -= roleWeight * (targetUnmet && canStillHitTarget ? 14.5 : targetUnmet ? 6.8 : 1.5) * slotWide;
        if (family && !seenFamilies[slot].has(family)) adjusted += roleWeight * (targetUnmet ? 2.4 : 0.8) * slotWide;
        else if (family) adjusted -= roleWeight * (targetUnmet ? 2.1 : 0.65) * slotWide;
        if (brand && !seenBrands[slot].has(brand)) adjusted += roleWeight * 0.95 * slotWide;
        else if (brand) adjusted -= roleWeight * 0.6 * slotWide;
        if (colourFamily && !seenColourFamilies[slot].has(colourFamily)) adjusted += roleWeight * 0.7 * slotWide;
        else if (colourFamily) adjusted -= roleWeight * 0.42 * slotWide;
        if (slotProfiles[slot].variantMode === 'open' && slotProfiles[slot].variantGroupHints.length) {
          if (inVariantGroup && !seenIds[slot].has(meta.id)) adjusted += roleWeight * 2.2 * slotWide;
          else if (inVariantGroup) adjusted -= roleWeight * 1.25 * slotWide;
          else adjusted -= roleWeight * 2.4 * slotWide;
        }
      }
      const coreSignature = candidate.coreSignature || coreOutfitSignature(candidate.outfit);
      const broadCoreSlots =
        fullOutfitDiversityIntent(intent) &&
        slotBroadnessMap.top >= 0.45 &&
        slotBroadnessMap.bottom >= 0.45;
      if (broadCoreSlots && coreSignature) {
        if (!seenCoreSignatures.has(coreSignature)) adjusted += 4.2 * broadness;
        else adjusted -= 8.4 * broadness;
      }
      for (const existing of selected) {
        for (const slot of SLOT_ORDER) {
          if (slotProfiles[slot].diversityExempt) continue;
          const slotWide = slotBroadnessMap[slot];
          const current = slotMetaFor(candidate, slot);
          const prior = slotMetaFor(existing, slot);
          if (!current || !prior) continue;
          if (current.id === prior.id) adjusted -= ROLE_WEIGHTS[slot] * 5.5 * slotWide;
          else if (current.family && current.family === prior.family) adjusted -= ROLE_WEIGHTS[slot] * 1.9 * slotWide;
        }
        adjusted -= similarityFor(candidate, existing) * 1.7 * broadness;
      }
      if (!seenPaletteSignatures.has(candidatePalette)) adjusted += paletteNoveltyWeight * (intent.palette_mode === 'colorful' ? 1.7 : 0.9);
      else adjusted -= paletteNoveltyWeight * (intent.palette_mode === 'monochrome' || intent.palette_mode === 'tonal' ? 0.18 : 0.52);
      return {
        candidate,
        adjusted,
        priorityCoverageGain: candidateCoverageGain(candidate, prioritySlots),
        anyCoverageGain: candidateCoverageGain(candidate, SLOT_ORDER),
      };
    });

    rescored.sort((a, b) => b.adjusted - a.adjusted);
    const coverageFloor = (rescored[0]?.candidate.score ?? 0) - (6.8 + broadness * 6.8);
    const priorityPool = rescored
      .filter((entry) => entry.candidate.score >= coverageFloor && prioritySlots.length && candidateImprovesCoverage(entry.candidate, prioritySlots))
      .sort((a, b) => {
        if (b.priorityCoverageGain !== a.priorityCoverageGain) return b.priorityCoverageGain - a.priorityCoverageGain;
        return b.adjusted - a.adjusted;
      });
    const coveragePool = priorityPool.length
      ? priorityPool
      : rescored
        .filter((entry) => entry.candidate.score >= coverageFloor && candidateImprovesCoverage(entry.candidate, SLOT_ORDER))
        .sort((a, b) => {
          if (b.anyCoverageGain !== a.anyCoverageGain) return b.anyCoverageGain - a.anyCoverageGain;
          return b.adjusted - a.adjusted;
        });
    const rankedPool = coveragePool.length ? coveragePool : rescored;
    const pickFrom = rankedPool.slice(0, Math.max(1, Math.min(coveragePool.length ? 4 : 5, rankedPool.length)));
    const noveltyPool = (() => {
      const focusSlots = (prioritySlots.length ? prioritySlots : SLOT_ORDER).filter((slot) => {
        const target = targets[slot] || 0;
        return target > 0 && seenIds[slot].size < target;
      });
      if (!focusSlots.length) return [];
      const novelEntries: typeof rankedPool = [];
      const seenNoveltyKeys = new Set<string>();
      for (const entry of rankedPool) {
        for (const slot of focusSlots) {
          const item = entry.candidate.outfit[slot];
          if (!item || seenIds[slot].has(item.id)) continue;
          const noveltyKey = `${slot}:${item.id}`;
          if (seenNoveltyKeys.has(noveltyKey)) continue;
          seenNoveltyKeys.add(noveltyKey);
          novelEntries.push(entry);
          break;
        }
        if (novelEntries.length >= 6) break;
      }
      return novelEntries;
    })();
    const topTarget = targets.top || 0;
    const unseenTopPool = (() => {
      if (!(topTarget > 0 && seenIds.top.size < topTarget)) return [];
      const uniqueTopEntries: typeof rankedPool = [];
      const seenTopCandidates = new Set<string>();
      for (const entry of rankedPool) {
        const top = entry.candidate.outfit.top;
        if (!top || seenIds.top.has(top.id) || seenTopCandidates.has(top.id)) continue;
        seenTopCandidates.add(top.id);
        uniqueTopEntries.push(entry);
        if (uniqueTopEntries.length >= 6) break;
      }
      return uniqueTopEntries;
    })();
    const finalPool = noveltyPool.length ? noveltyPool : unseenTopPool.length ? unseenTopPool : pickFrom;
    const effectiveEpsilon = clamp01(epsilon * (0.25 + broadness * 1.15));
    const chosen =
      REQUEST_RANDOM() < effectiveEpsilon && finalPool.length > 1
        ? finalPool[Math.floor(REQUEST_RANDOM() * finalPool.length)].candidate
        : finalPool[0].candidate;

    const signature = chosen.signature || outfitSignature(chosen.outfit);
    band.splice(band.findIndex((entry) => entry === chosen), 1);
    if (usedSignatures.has(signature)) continue;
    usedSignatures.add(signature);
    selected.push(chosen);
    const chosenCoreSignature = chosen.coreSignature || coreOutfitSignature(chosen.outfit);
    if (chosenCoreSignature) seenCoreSignatures.add(chosenCoreSignature);
    seenPaletteSignatures.add(chosen.paletteSignature || paletteSignature(chosen.outfit));
    for (const slot of SLOT_ORDER) {
      const meta = slotMetaFor(chosen, slot);
      if (!meta) continue;
      const currentCount = remainingCounts[slot].get(meta.id) || 0;
      if (currentCount <= 1) remainingCounts[slot].delete(meta.id);
      else remainingCounts[slot].set(meta.id, currentCount - 1);
      const alreadySeen = seenIds[slot].has(meta.id);
      seenIds[slot].add(meta.id);
      if (!alreadySeen) {
        remainingUnusedCounts[slot] = Math.max(0, remainingUnusedCounts[slot] - 1);
      }
      const family = meta.family;
      if (family) seenFamilies[slot].add(family);
      const brand = meta.brand;
      if (brand) seenBrands[slot].add(brand);
      const colourFamily = meta.colourFamily;
      if (colourFamily) seenColourFamilies[slot].add(colourFamily);
    }
  }

  return selected;
}

export class CatalogRepository {
  public prepareRequest(seed: number | null): void {
    REQUEST_MEMO = createRequestMemo();
    REQUEST_RANDOM = Number.isFinite(seed as number) ? createSeededRandom(Number(seed)) : Math.random;
  }

  public ensureCredentials(debug: boolean): void {
    setGoogleCredentialsIfAvailable(debug);
  }

  public resolveProject(override?: string | null): string | null {
    return resolveProject(override);
  }

  public loadIndex(indexPath: string): IndexItem[] {
    return loadIndex(indexPath);
  }

  public buildCorpusStats(items: IndexItem[]): SemanticCorpusStats {
    return buildSemanticCorpusStats(items);
  }

  public loadEmbeddings(indexPath: string, override: string | null, debug: boolean): LoadedEmbeddings {
    return loadEmbeddings(indexPath, override, debug);
  }
}

export class PromptParser {
  public heuristicIntent(prompt: string, genderPref: Gender | 'any'): PromptIntent {
    return heuristicIntent(prompt, genderPref);
  }

  public sanitizeIntent(value: any): PromptIntent {
    return sanitizeIntent(value);
  }

  public mergeIntents(primary: PromptIntent, secondary: PromptIntent): PromptIntent {
    return mergeIntents(primary, secondary);
  }

  public parseNegatives(intent: PromptIntent, prompt: string, corpusStats?: SemanticCorpusStats | null): void {
    parseNegatives(intent, prompt, corpusStats);
  }

  public async resolveIntent(
    request: RecommendationRequest,
    corpusStats: SemanticCorpusStats,
  ): Promise<{ intent: PromptIntent; geminiState: GeminiIntentState }> {
    const heuristic = this.heuristicIntent(request.prompt, request.genderPref);
    let intent = heuristic;
    let geminiState: GeminiIntentState = {
      active: false,
      reason: request.parserMode === 'heuristic' ? 'parser_mode_heuristic' : 'not_attempted',
      intent: null,
    };

    if (request.intentJsonInPath) {
      intent = this.sanitizeIntent(JSON.parse(fs.readFileSync(path.resolve(request.intentJsonInPath), 'utf8')));
    } else if (request.parserMode !== 'heuristic') {
      geminiState = await resolveGeminiIntent(
        request.prompt,
        request.genderPref,
        request.parserMode,
        request.project,
        request.location,
        request.model,
        request.debug,
      );
      if (request.parserMode === 'gemini' && geminiState.intent) intent = this.mergeIntents(geminiState.intent, heuristic);
      else if (request.parserMode === 'auto' && geminiState.intent) intent = this.mergeIntents(geminiState.intent, heuristic);
    }

    intent = this.sanitizeIntent(intent);
    this.parseNegatives(intent, request.prompt, corpusStats);
    intent = this.sanitizeIntent(intent);
    return { intent, geminiState };
  }
}

export class EmbeddingService {
  public async resolvePromptEmbeddings(
    request: RecommendationRequest,
    intent: PromptIntent,
    embeddings: LoadedEmbeddings,
    corpusStats: SemanticCorpusStats,
  ): Promise<PromptEmbeddingState> {
    return resolvePromptEmbeddings(
      request.prompt,
      intent,
      request.embeddingMode,
      request.project,
      request.location,
      request.embeddingModel,
      embeddings,
      corpusStats,
      request.debug,
    );
  }

  public synthesizePromptEmbeddingsFromCandidates(
    current: PromptEmbeddingState,
    candidatesBySlot: Record<CategoryMain, ScoredItem[]>,
    slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
    embeddings: LoadedEmbeddings,
  ): PromptEmbeddingState {
    return synthesizePromptEmbeddingsFromCandidates(current, candidatesBySlot, slotProfiles, embeddings);
  }
}

export class CandidateRanker {
  public buildSlotProfiles(
    intent: PromptIntent,
    items: IndexItem[],
    corpusStats?: SemanticCorpusStats | null,
  ): Record<CategoryMain, SlotConstraintProfile> {
    return buildSlotProfiles(intent, items, corpusStats);
  }

  public buildCandidates(
    items: IndexItem[],
    intent: PromptIntent,
    slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
    perRoleLimit: number,
    promptEmbeddings: PromptEmbeddingState,
    embeddings: LoadedEmbeddings,
    embeddingMode: EmbeddingMode,
    debug: boolean,
  ): Record<CategoryMain, ScoredItem[]> {
    const candidatesBySlot: Record<CategoryMain, ScoredItem[]> = { top: [], bottom: [], shoes: [], mono: [] };
    const startedAt = Date.now();
    for (const slot of uniq([...intent.required_categories, ...intent.optional_categories])) {
      const slotStartedAt = Date.now();
      candidatesBySlot[slot] = filterCandidatesForSlot(
        items,
        slot,
        intent,
        slotProfiles,
        perRoleLimit,
        promptEmbeddings,
        embeddings,
        embeddingMode,
      );
      logCandidateTiming('og_build_candidates_slot_complete', {
        slot,
        ms: Date.now() - slotStartedAt,
        count: candidatesBySlot[slot].length,
        embedding_mode: embeddingMode,
      });
      logDebug(debug, 'slot candidates', slot, candidatesBySlot[slot].length);
      logDebug(
        debug,
        'slot candidate ids',
        slot,
        candidatesBySlot[slot].slice(0, 16).map((entry) => ({
          id: entry.item.id,
          sub: entry.item.sub,
          score: Number(entry.score.toFixed(3)),
          family: entry.family,
          colour: entry.colourFamily,
        })),
      );
    }
    logCandidateTiming('og_build_candidates_complete', {
      ms: Date.now() - startedAt,
      embedding_mode: embeddingMode,
      counts: Object.fromEntries(SLOT_ORDER.map((slot) => [slot, candidatesBySlot[slot]?.length || 0])),
    });
    return candidatesBySlot;
  }

  public buildCandidatesDual(
    items: IndexItem[],
    intent: PromptIntent,
    slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
    symbolicPerRoleLimit: number,
    hybridPerRoleLimit: number,
    promptEmbeddings: PromptEmbeddingState,
    embeddings: LoadedEmbeddings,
    debug: boolean,
  ): { symbolic: Record<CategoryMain, ScoredItem[]>; hybrid: Record<CategoryMain, ScoredItem[]> } {
    const symbolic: Record<CategoryMain, ScoredItem[]> = { top: [], bottom: [], shoes: [], mono: [] };
    const hybrid: Record<CategoryMain, ScoredItem[]> = { top: [], bottom: [], shoes: [], mono: [] };
    const startedAt = Date.now();
    for (const slot of uniq([...intent.required_categories, ...intent.optional_categories])) {
      const slotConstraint = slotProfiles[slot];
      const symbolicPrepared = getPreparedCandidatesForSlot(
        items,
        slot,
        intent,
        slotProfiles,
        symbolicPerRoleLimit,
        promptEmbeddings,
        false,
      );
      const hybridPrepared = getPreparedCandidatesForSlot(
        items,
        slot,
        intent,
        slotProfiles,
        hybridPerRoleLimit,
        promptEmbeddings,
        true,
      );
      const symbolicFinalized = finalizePreparedCandidatesForSlot(symbolicPrepared, promptEmbeddings, embeddings, 'off');
      const hybridFinalized = finalizePreparedCandidatesForSlot(hybridPrepared, promptEmbeddings, embeddings, 'hybrid');
      const semanticPool = buildSemanticPoolForSlot(
        items,
        slot,
        intent,
        slotProfiles,
        hybridPerRoleLimit,
        promptEmbeddings,
        embeddings,
        hybridPrepared,
      );
      const protectedSymbolicCount =
        slotConstraint.lockMode === 'exact'
          ? Math.min(symbolicFinalized.output.length, Math.max(4, Math.ceil(hybridPerRoleLimit * 0.45)))
          : slotConstraint.lockMode === 'family'
            ? Math.min(symbolicFinalized.output.length, Math.max(4, Math.ceil(hybridPerRoleLimit * 0.32)))
            : slotConstraint.lockMode === 'attribute'
              ? Math.min(symbolicFinalized.output.length, Math.max(3, Math.ceil(hybridPerRoleLimit * 0.18)))
              : Math.min(symbolicFinalized.output.length, Math.max(2, Math.ceil(hybridPerRoleLimit * 0.1)));
      const hybridOutputLimit = semanticPool.length
        ? Math.max(hybridPerRoleLimit, Math.min(96, frontierSoftLimit(slotConstraint, hybridPerRoleLimit)))
        : hybridPerRoleLimit;
      const mergedHybrid: ScoredItem[] = [];
      const mergedIds = new Set<string>();
      for (const candidate of symbolicFinalized.output.slice(0, protectedSymbolicCount)) {
        if (mergedIds.has(candidate.item.id)) continue;
        mergedHybrid.push(candidate);
        mergedIds.add(candidate.item.id);
      }
      for (const source of [semanticPool, hybridFinalized.output]) {
        for (const candidate of source) {
          if (mergedIds.has(candidate.item.id)) continue;
          mergedHybrid.push(candidate);
          mergedIds.add(candidate.item.id);
          if (mergedHybrid.length >= hybridOutputLimit) break;
        }
        if (mergedHybrid.length >= hybridOutputLimit) break;
      }
      symbolic[slot] = symbolicFinalized.output.slice(0, symbolicPerRoleLimit);
      hybrid[slot] = mergedHybrid.slice(0, hybridOutputLimit);
      logDebug(debug, 'slot dual candidates', slot, {
        symbolic: symbolic[slot].length,
        hybrid: hybrid[slot].length,
        symbolic_scored: symbolicFinalized.scored.length,
        hybrid_scored: hybridFinalized.scored.length,
        hybrid_only_scored: hybrid[slot].filter((entry) => !symbolic[slot].some((symbolicEntry) => symbolicEntry.item.id === entry.item.id)).length,
        semantic_pool: semanticPool.length,
        symbolic_base: symbolicPrepared.timings.base,
        hybrid_base: hybridPrepared.timings.base,
        symbolic_pool: symbolicPrepared.prepared.length,
        hybrid_pool: hybridPrepared.prepared.length,
      });
    }
    logCandidateTiming('og_build_candidates_dual_complete', {
      ms: Date.now() - startedAt,
      symbolic_limit: symbolicPerRoleLimit,
      hybrid_limit: hybridPerRoleLimit,
      counts: Object.fromEntries(
        SLOT_ORDER.map((slot) => [
          slot,
          {
            symbolic: symbolic[slot]?.length || 0,
            hybrid: hybrid[slot]?.length || 0,
          },
        ]),
      ),
    });
    return { symbolic, hybrid };
  }

  public buildScoreLookup(candidatesBySlot: Record<CategoryMain, ScoredItem[]>): Record<string, ScoredItem> {
    const scoreLookup: Record<string, ScoredItem> = {};
    for (const slot of SLOT_ORDER) {
      for (const scored of candidatesBySlot[slot]) scoreLookup[scored.item.id] = scored;
    }
    return scoreLookup;
  }
}

export class OutfitAssembler {
  public async warmPairwiseCompatibilityCache(candidatesBySlot: Record<CategoryMain, ScoredItem[]>): Promise<void> {
    await warmPairwiseCompatibilityCache(candidatesBySlot);
  }

  public assembleOutfits(
    candidatesBySlot: Record<CategoryMain, ScoredItem[]>,
    intent: PromptIntent,
    scoreLookup: Record<string, ScoredItem>,
    slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
    poolSize: number,
  ): Outfit[] {
    return assembleOutfits(candidatesBySlot, intent, scoreLookup, slotProfiles, poolSize);
  }

  public scoreAndDiversify(
    outfits: Outfit[],
    intent: PromptIntent,
    slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
    scoreLookup: Record<string, ScoredItem>,
    promptEmbeddings: PromptEmbeddingState,
    embeddings: LoadedEmbeddings,
    embeddingMode: EmbeddingMode,
    poolSize: number,
    jitter: number,
    epsilon: number,
    debug: boolean,
  ): ScoredOutfit[] {
    const scored = outfits.map((outfit) => scoreOutfitCandidate(
      outfit,
      scoreLookup,
      intent,
      slotProfiles,
      promptEmbeddings,
      embeddings,
      embeddingMode,
      jitter,
    )).sort((a, b) => {
      if (a.maxStage !== b.maxStage) return a.maxStage - b.maxStage;
      if (a.stageSum !== b.stageSum) return a.stageSum - b.stageSum;
      return b.score - a.score;
    });

    if (debug) {
      const scoredBand = scored.slice(0, Math.min(scored.length, Math.max(poolSize * 24, 120)));
      logDebug(debug, 'scored band diversity', Object.fromEntries(
        SLOT_ORDER.map((slot) => [slot, new Set(scoredBand.map((entry) => entry.outfit[slot]?.id || '').filter(Boolean)).size]),
      ));
    }

    return selectDiversifiedOutfits(
      scored,
      intent,
      slotProfiles,
      scoreLookup,
      poolSize,
      clamp01(epsilon),
    );
  }
}

export class RecommendationService {
  public constructor(
    private readonly promptParser: PromptParser = new PromptParser(),
    private readonly catalogRepository: CatalogRepository = new CatalogRepository(),
    private readonly embeddingService: EmbeddingService = new EmbeddingService(),
    private readonly candidateRanker: CandidateRanker = new CandidateRanker(),
    private readonly outfitAssembler: OutfitAssembler = new OutfitAssembler(),
  ) {}

  public async recommend(request: RecommendationRequest): Promise<RecommendationResponse> {
    this.catalogRepository.prepareRequest(request.seed);
    this.catalogRepository.ensureCredentials(request.debug);

    const indexPath = path.resolve(request.indexPath);
    const items = this.catalogRepository.loadIndex(indexPath);
    const corpusStats = this.catalogRepository.buildCorpusStats(items);
    const { intent, geminiState } = await this.promptParser.resolveIntent(
      { ...request, indexPath, project: this.catalogRepository.resolveProject(request.project) },
      corpusStats,
    );
    const slotProfiles = this.candidateRanker.buildSlotProfiles(intent, items, corpusStats);

    if (request.debug) {
      logDebug(request.debug, 'intent', intent);
      logDebug(request.debug, 'slot profiles', slotProfiles);
    }

    if (request.intentOnly) {
      return {
        intent,
        looks: [],
        diagnostics: {
          gemini: { active: geminiState.active, reason: geminiState.reason },
          embeddings: {
            active: false,
            mode: request.embeddingMode,
            sidecar_path: null,
            reason: 'intent_only',
          },
        },
      };
    }

    const loadedEmbeddings = this.catalogRepository.loadEmbeddings(indexPath, request.embeddingSidecarPath, request.debug);
    const requestWithResolvedProject = { ...request, indexPath, project: this.catalogRepository.resolveProject(request.project) };
    const promptEmbeddings = await this.embeddingService.resolvePromptEmbeddings(
      requestWithResolvedProject,
      intent,
      loadedEmbeddings,
      corpusStats,
    );
    const candidatesBySlot = this.candidateRanker.buildCandidates(
      items,
      intent,
      slotProfiles,
      request.perRoleLimit,
      promptEmbeddings,
      loadedEmbeddings,
      request.embeddingMode,
      request.debug,
    );
    const scoringEmbeddings = this.embeddingService.synthesizePromptEmbeddingsFromCandidates(
      promptEmbeddings,
      candidatesBySlot,
      slotProfiles,
      loadedEmbeddings,
    );
    const scoreLookup = this.candidateRanker.buildScoreLookup(candidatesBySlot);
    this.outfitAssembler.warmPairwiseCompatibilityCache(candidatesBySlot);

    const outfits = this.outfitAssembler.assembleOutfits(
      candidatesBySlot,
      intent,
      scoreLookup,
      slotProfiles,
      request.poolSize,
    );
    if (!outfits.length) throw new Error('No outfits/items could be constructed.');

    const looks = this.outfitAssembler.scoreAndDiversify(
      outfits,
      intent,
      slotProfiles,
      scoreLookup,
      scoringEmbeddings,
      loadedEmbeddings,
      request.embeddingMode,
      request.poolSize,
      request.jitter,
      request.epsilon,
      request.debug,
    );
    if (!looks.length) throw new Error('No outfits/items could be constructed.');

    return {
      intent,
      looks,
      diagnostics: {
        gemini: { active: geminiState.active, reason: geminiState.reason },
        embeddings: {
          active: scoringEmbeddings.active,
          mode: request.embeddingMode,
          sidecar_path: loadedEmbeddings.sidecarPath,
          reason: scoringEmbeddings.reason,
        },
      },
    };
  }
}
