import {
  buildPromptSemanticBundle,
  deriveRuntimeSemanticControls,
  deriveItemSemanticAxisProfile,
  SemanticAxisProfile,
  semanticAxisText,
  slotSemanticRoleText,
} from '../style_semantics';
import {
  cosineSimilarity,
  createGoogleGenAIClient,
  embedTexts,
  loadPersistedVectorCache,
  persistVectorCache,
  resolvePromptEmbeddingCachePath,
  weightedAverageVectors,
} from '../semantic_embeddings';
import { CategoryMain, SLOT_ORDER, normalizeText } from '../fashion_taxonomy';
import { SemanticCorpusStats } from '../canonical_index';
import { EmbeddingService as BaseEmbeddingService } from '../og_recommendation/RecommendationService';
import { loadDurablePromptEmbeddings, persistDurablePromptEmbedding } from './DurablePromptCache';
import {
  EmbeddingMode,
  LoadedEmbeddings,
  PromptEmbeddingState,
  RequestAnchorEmbedding,
  RecommendationRequest,
  SemanticSubject,
  SlotConstraintProfile,
  CandidateScore as ScoredItem,
} from './types';
import { PromptIntentV2 } from './types';

interface SemanticTextBundleV2 {
  general: string;
  identity: string;
  style: string;
  slots: Partial<Record<CategoryMain, string>>;
  slot_identity: Partial<Record<CategoryMain, string>>;
  slot_style: Partial<Record<CategoryMain, string>>;
}

const PROMPT_EMBEDDING_CACHE = new Map<string, number[]>();
const PROMPT_EMBEDDING_CACHE_PATH = resolvePromptEmbeddingCachePath(process.cwd());
const PROMPT_EMBEDDING_CACHE_SCHEMA_VERSION = 4;
let PERSISTED_PROMPT_EMBEDDING_CACHE: Record<string, { vector: number[]; source: 'live'; created_at: string }> | null = null;

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.map((part) => normalizeText(part || '')).filter(Boolean).join(' ').trim();
}

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
    promise.then((value) => {
      clearTimeout(timeout);
      resolve(value);
    }).catch((error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableEmbeddingError(error: unknown): boolean {
  const status = Number((error as { status?: number } | null)?.status || 0);
  const text = String((error as Error | null)?.message || '');
  return (
    status === 429 ||
    status === 408 ||
    /\bRESOURCE_EXHAUSTED\b/i.test(text) ||
    /\bETIMEDOUT\b/i.test(text) ||
    /\bECONNRESET\b/i.test(text) ||
    /\bDEADLINE_EXCEEDED\b/i.test(text) ||
    /\btimeout\b/i.test(text)
  );
}

function scopedSubjects(intent: PromptIntentV2, slot?: CategoryMain): SemanticSubject[] {
  if (!slot) return intent.semantic_subjects;
  return intent.semantic_subjects.filter((subject) => {
    if (subject.scope === 'global') return true;
    return !!subject.slots?.includes(slot);
  });
}

function emptySemanticAxisProfile(): SemanticAxisProfile {
  return {
    refined: 0,
    classic: 0,
    minimal: 0,
    relaxed: 0,
    structured: 0,
    neutral: 0,
    understated: 0,
    sporty: 0,
    streetwear: 0,
    graphic: 0,
  };
}

function addAxis(profile: SemanticAxisProfile, key: keyof SemanticAxisProfile, amount: number) {
  profile[key] = Math.max(0, Math.min(1, profile[key] + amount));
}

function applyAxisTerms(profile: SemanticAxisProfile, terms: string[]) {
  for (const raw of terms) {
    const term = normalizeText(raw || '');
    if (!term) continue;
    if (/\brefined|sophisticated|elegant|polished|smart casual|formal|chic|luxury|high quality|premium\b/.test(term)) addAxis(profile, 'refined', 0.22);
    if (/\bclassic|timeless|preppy|heritage|elevated\b/.test(term)) addAxis(profile, 'classic', 0.2);
    if (/\bminimal|clean|simple|muted|monochromatic\b/.test(term)) addAxis(profile, 'minimal', 0.18);
    if (/\brelaxed|oversized|baggy|loose\b/.test(term)) addAxis(profile, 'relaxed', 0.2);
    if (/\bstructured|tailored|sharp|clean lines|sleek\b/.test(term)) addAxis(profile, 'structured', 0.22);
    if (/\bneutral|earth tones|earthy|beige|brown|black|white|grey|gray\b/.test(term)) addAxis(profile, 'neutral', 0.2);
    if (/\bunderstated|quiet|subtle|clean|no logos|no logo\b/.test(term)) addAxis(profile, 'understated', 0.2);
    if (/\bsport|sporty|athletic|performance|training|football|basketball\b/.test(term)) addAxis(profile, 'sporty', 0.22);
    if (/\bstreetwear|urban|edgy|techwear|y2k|rockstar|punk|gothic\b/.test(term)) addAxis(profile, 'streetwear', 0.2);
    if (/\bgraphic|logo|embellished|distressed|loud|colorful|camo|camouflage\b/.test(term)) addAxis(profile, 'graphic', 0.22);
  }
}

function derivePromptSemanticAxisProfile(intent: PromptIntentV2): SemanticAxisProfile {
  const profile = emptySemanticAxisProfile();
  const subjectTerms = intent.semantic_subjects.flatMap((subject) => [
    ...subject.style_axes,
    ...subject.silhouette_terms,
    ...subject.palette_terms,
  ]);
  applyAxisTerms(profile, [
    ...subjectTerms,
    ...intent.semantic_directives.style_axes,
    ...intent.semantic_directives.silhouette_terms,
    ...intent.semantic_directives.palette_terms,
    ...intent.vibe_tags,
    ...intent.occasion_tags,
  ]);
  if (intent.palette_mode === 'monochrome' || intent.palette_mode === 'tonal' || intent.palette_mode === 'muted') {
    addAxis(profile, 'neutral', 0.18);
    addAxis(profile, 'minimal', 0.14);
  }
  if (intent.negative_constraints.no_logos) {
    addAxis(profile, 'understated', 0.22);
    addAxis(profile, 'minimal', 0.12);
  }
  if (intent.negative_constraints.non_sport) {
    addAxis(profile, 'refined', 0.08);
    profile.sporty = Math.max(0, profile.sporty - 0.16);
  }
  if (intent.vibe_tags.includes('streetwear')) addAxis(profile, 'streetwear', 0.16);
  if (intent.vibe_tags.includes('minimal')) addAxis(profile, 'minimal', 0.18);
  if (intent.vibe_tags.includes('formal') || intent.vibe_tags.includes('chic') || intent.vibe_tags.includes('preppy')) {
    addAxis(profile, 'refined', 0.12);
    addAxis(profile, 'classic', 0.12);
  }
  // Refined, low-noise prompts often imply classic styling even when Gemini
  // expresses them through modern labels like "minimal" or "understated".
  if (profile.refined >= 0.48 && profile.understated >= 0.42 && profile.streetwear <= 0.22 && profile.sporty <= 0.2) {
    addAxis(profile, 'classic', 0.2);
  }
  if (profile.refined >= 0.54 && profile.minimal >= 0.54) {
    addAxis(profile, 'classic', 0.12);
    addAxis(profile, 'understated', 0.08);
  }
  if (profile.structured >= 0.5 && profile.neutral >= 0.45) {
    addAxis(profile, 'classic', 0.1);
  }
  return profile;
}

function semanticInformativeness(intent: PromptIntentV2, bundle: SemanticTextBundleV2, profile: SemanticAxisProfile): number {
  const styleTermMass =
    intent.semantic_directives.style_axes.length +
    intent.semantic_directives.silhouette_terms.length +
    intent.semantic_directives.palette_terms.length +
    intent.semantic_subjects.reduce((sum, subject) => sum + subject.style_axes.length + subject.silhouette_terms.length + subject.palette_terms.length, 0);
  const activeAxes = Object.values(profile).filter((value) => value >= 0.34).length;
  const distinctChannels = [
    !!bundle.identity && bundle.identity !== bundle.general,
    !!bundle.style && bundle.style !== bundle.general,
    ...Object.values(bundle.slot_style).map((value) => !!value && value !== bundle.style),
    ...Object.values(bundle.slot_identity).map((value) => !!value && value !== bundle.identity),
  ].filter(Boolean).length;
  const subjectRichness = Math.min(1, intent.semantic_subjects.length * 0.18 + styleTermMass * 0.025);
  const axisStrength = Math.min(1, activeAxes * 0.12 + (Object.values(profile).reduce((sum, value) => sum + value, 0) / 10) * 0.6);
  const channelStrength = Math.min(1, distinctChannels * 0.14);
  return Math.max(0, Math.min(1, 0.08 + subjectRichness * 0.46 + axisStrength * 0.34 + channelStrength * 0.2));
}

function subjectStyleText(subject: SemanticSubject): string {
  if (subject.kind === 'brand' || subject.kind === 'team' || subject.kind === 'item_line') return '';
  return joinParts([
    subject.kind ? `${subject.kind} ${subject.label}` : subject.label,
    subject.style_axes.length ? `style axes ${subject.style_axes.join(' ')}` : '',
    subject.silhouette_terms.length ? `silhouette ${subject.silhouette_terms.join(' ')}` : '',
    subject.palette_terms.length ? `palette ${subject.palette_terms.join(' ')}` : '',
    subject.category_preferences.length ? `categories ${subject.category_preferences.join(' ')}` : '',
    subject.soft_brand_priors.length ? `soft brands ${subject.soft_brand_priors.join(' ')}` : '',
  ]);
}

function subjectIdentityText(subject: SemanticSubject): string {
  if (subject.kind === 'persona' || subject.kind === 'style_archetype' || subject.kind === 'theme') {
    return joinParts([
      subject.soft_brand_priors.length ? `soft brands ${subject.soft_brand_priors.join(' ')}` : '',
      subject.category_preferences.length ? `preferred categories ${subject.category_preferences.join(' ')}` : '',
    ]);
  }
  return joinParts([
    subject.kind ? `${subject.kind} ${subject.label}` : subject.label,
    subject.soft_brand_priors.length ? `soft brands ${subject.soft_brand_priors.join(' ')}` : '',
    subject.category_preferences.length ? `preferred categories ${subject.category_preferences.join(' ')}` : '',
  ]);
}

function slotHasIdentityDemand(intent: PromptIntentV2, slot: CategoryMain): boolean {
  const scoped = scopedSubjects(intent, slot);
  if (scoped.some((subject) => subject.kind === 'brand' || subject.kind === 'team' || subject.kind === 'item_line')) return true;
  const slotConstraint = intent.slot_constraints?.[slot];
  return !!(
    slotConstraint?.preferred_entities?.length ||
    slotConstraint?.required_keywords?.length ||
    slotConstraint?.preferred_subs?.length
  );
}

function slotHasStyleDemand(intent: PromptIntentV2, slot: CategoryMain): boolean {
  const scoped = scopedSubjects(intent, slot);
  if (scoped.some((subject) => subject.kind === 'persona' || subject.kind === 'style_archetype' || subject.kind === 'theme')) return true;
  const slotConstraint = intent.slot_constraints?.[slot];
  return !!(
    slotConstraint?.vibe_hints?.length ||
    slotConstraint?.occasion_hints?.length ||
    slotConstraint?.fit_hints?.length ||
    slotConstraint?.colour_hints?.length
  );
}

function slotRoleSemanticText(slot: CategoryMain, profile: SemanticAxisProfile, intent: PromptIntentV2): string {
  const refinedLean = profile.refined + profile.classic + profile.understated;
  const cleanLean = profile.minimal + profile.neutral + profile.understated;
  const loudLean = profile.streetwear + profile.sporty + profile.graphic;
  const requested = (intent.requested_slots.length ? intent.requested_slots : SLOT_ORDER).includes(slot);
  if (!requested && !scopedSubjects(intent, slot).length) return '';
  const controls = deriveRuntimeSemanticControls(intent, profile, 0);
  const slotConstraint = intent.slot_constraints?.[slot];

  const parts: string[] = [slotSemanticRoleText(slot), semanticAxisText(profile)];
  if (slot === 'top') {
    if (refinedLean >= 1.1) parts.push('upper refined clean anchor');
    if (profile.structured >= 0.4) parts.push('upper structured layer');
    if (profile.relaxed >= 0.45) parts.push('upper relaxed layer');
    if (profile.streetwear >= 0.4) parts.push('upper streetwear layer');
    if (profile.sporty >= 0.4) parts.push('upper athletic layer');
  } else if (slot === 'bottom') {
    if (refinedLean >= 1) parts.push('bottom refined clean base');
    if (profile.structured >= 0.38) parts.push('bottom tailored structured base');
    if (profile.relaxed >= 0.45) parts.push('bottom relaxed base');
    if (cleanLean >= 1) parts.push('bottom clean minimal base');
    if (profile.streetwear >= 0.4) parts.push('bottom streetwear utility base');
    if (profile.sporty >= 0.4) parts.push('bottom athletic active base');
  } else if (slot === 'shoes') {
    if (refinedLean >= 1 && profile.sporty <= 0.3) parts.push('footwear smart clean finishing');
    if (cleanLean >= 1) parts.push('footwear understated finishing');
    if (profile.streetwear >= 0.4) parts.push('footwear streetwear finishing');
    if (profile.sporty >= 0.4) parts.push('footwear athletic performance');
  } else {
    if (refinedLean >= 1) parts.push('mono refined clean anchor');
    if (profile.relaxed >= 0.45) parts.push('mono relaxed shape');
    if (profile.streetwear >= 0.4) parts.push('mono streetwear statement');
  }

  if (profile.sporty <= 0.18 && refinedLean >= 1) parts.push('avoid sporty athletic performance');
  if (profile.streetwear <= 0.2 && refinedLean >= 1) parts.push('avoid streetwear utility distressed');
  if (profile.graphic <= 0.18 && cleanLean >= 1) parts.push('avoid graphic logo loud');
  if (loudLean <= 0.7 && cleanLean >= 1.05) parts.push('prefer low noise coherent styling');
  if (controls.paletteStrictness >= 0.42 && intent.palette_mode === 'unconstrained' && !intent.colour_hints.length && !intent.global_palette_colours.length) {
    if (profile.neutral >= 0.5) parts.push('prefer restrained palette neutral muted coherent colour');
    if (profile.graphic <= 0.24) parts.push('avoid chromatic noisy palette drift');
  }
  if (intent.negative_constraints.non_sport) parts.push('exclude athletic sport performance');
  if (intent.negative_constraints.no_logos) parts.push('exclude logo graphic branding');
  if (slotConstraint?.excluded_keywords?.length) parts.push(`exclude keywords ${slotConstraint.excluded_keywords.join(' ')}`);
  if (slotConstraint?.excluded_subs?.length) parts.push(`exclude subtype families ${slotConstraint.excluded_subs.join(' ')}`);
  if (slotConstraint?.excluded_entities?.length) parts.push(`exclude entities ${slotConstraint.excluded_entities.join(' ')}`);
  if (slotConstraint?.excluded_colours?.length) parts.push(`exclude colours ${slotConstraint.excluded_colours.join(' ')}`);
  if (intent.negative_constraints.excluded_keywords.length) parts.push(`global exclude keywords ${intent.negative_constraints.excluded_keywords.join(' ')}`);
  if (intent.negative_constraints.excluded_subs.length) parts.push(`global exclude subtype families ${intent.negative_constraints.excluded_subs.join(' ')}`);
  if (intent.negative_constraints.excluded_categories.length) parts.push(`global exclude categories ${intent.negative_constraints.excluded_categories.join(' ')}`);
  if (intent.negative_constraints.excluded_brands.length) parts.push(`global exclude brands ${intent.negative_constraints.excluded_brands.join(' ')}`);
  if (intent.negative_constraints.excluded_teams.length) parts.push(`global exclude teams ${intent.negative_constraints.excluded_teams.join(' ')}`);
  return joinParts(parts);
}

function needsGlobalIdentityVector(intent: PromptIntentV2, bundle: SemanticTextBundleV2): boolean {
  if (!bundle.identity || bundle.identity === bundle.general) return false;
  return !!(
    intent.brand_focus.length ||
    intent.team_focus.length ||
    intent.specific_items.length ||
    intent.semantic_subjects.some((subject) => subject.kind === 'brand' || subject.kind === 'team' || subject.kind === 'item_line')
  );
}

function needsGlobalStyleVector(intent: PromptIntentV2, bundle: SemanticTextBundleV2): boolean {
  if (!bundle.style || bundle.style === bundle.general) return false;
  return !!(
    intent.semantic_subjects.some((subject) => subject.kind === 'persona' || subject.kind === 'style_archetype' || subject.kind === 'theme') ||
    intent.vibe_tags.length ||
    intent.occasion_tags.length ||
    intent.palette_mode !== 'unconstrained' ||
    intent.semantic_directives.style_axes.length ||
    intent.semantic_directives.silhouette_terms.length ||
    intent.semantic_directives.palette_terms.length
  );
}

function buildPromptSemanticBundleV2(
  prompt: string,
  intent: PromptIntentV2,
  corpusStats: SemanticCorpusStats,
): SemanticTextBundleV2 {
  const base = buildPromptSemanticBundle(prompt, intent, { corpus: corpusStats });
  const slots: Partial<Record<CategoryMain, string>> = { ...base.slots };
  const slotIdentity: Partial<Record<CategoryMain, string>> = { ...base.slot_identity };
  const slotStyle: Partial<Record<CategoryMain, string>> = { ...base.slot_style };
  const globalSubjects = scopedSubjects(intent);
  const globalStyleText = joinParts(globalSubjects.map((subject) => subjectStyleText(subject)));
  const globalIdentityText = joinParts(globalSubjects.map((subject) => subjectIdentityText(subject)));
  const axisProfile = derivePromptSemanticAxisProfile(intent);
  const axisText = semanticAxisText(axisProfile);
  const controls = deriveRuntimeSemanticControls(intent, axisProfile, 0);
  const implicitPaletteText =
    intent.palette_mode === 'unconstrained' && !intent.colour_hints.length && !intent.global_palette_colours.length
      ? joinParts([
          controls.paletteStrictness >= 0.42 && axisProfile.neutral >= 0.48 ? 'palette restrained neutral muted' : '',
          controls.paletteStrictness >= 0.52 && axisProfile.graphic <= 0.24 ? 'avoid chromatic noisy palette' : '',
        ])
      : '';
  const globalConstraintText = joinParts([
    intent.negative_constraints.non_sport ? 'exclude athletic sport performance' : '',
    intent.negative_constraints.no_logos ? 'exclude logo heavy graphic branding' : '',
    intent.negative_constraints.excluded_keywords.length ? `exclude keywords ${intent.negative_constraints.excluded_keywords.join(' ')}` : '',
    intent.negative_constraints.excluded_subs.length ? `exclude subtype families ${intent.negative_constraints.excluded_subs.join(' ')}` : '',
    intent.negative_constraints.excluded_categories.length ? `exclude categories ${intent.negative_constraints.excluded_categories.join(' ')}` : '',
    intent.negative_constraints.excluded_brands.length ? `exclude brands ${intent.negative_constraints.excluded_brands.join(' ')}` : '',
    intent.negative_constraints.excluded_teams.length ? `exclude teams ${intent.negative_constraints.excluded_teams.join(' ')}` : '',
  ]);

  let style = joinParts([
    base.style,
    intent.semantic_directives.style_axes.join(' '),
    intent.semantic_directives.silhouette_terms.join(' '),
    intent.semantic_directives.palette_terms.join(' '),
    axisText,
    implicitPaletteText,
    globalStyleText,
  ]);
  let identity = joinParts([base.identity, globalIdentityText, globalConstraintText]);

  for (const slot of SLOT_ORDER) {
    const slotSubjects = scopedSubjects(intent, slot);
    const scopedStyle = joinParts(slotSubjects.map((subject) => subjectStyleText(subject)));
    const scopedIdentity = joinParts(slotSubjects.map((subject) => subjectIdentityText(subject)));
    const roleStyle = slotRoleSemanticText(slot, axisProfile, intent);
    const slotConstraint = intent.slot_constraints?.[slot];
    const slotConstraintText = joinParts([
      slotConstraint?.excluded_keywords?.length ? `exclude keywords ${slotConstraint.excluded_keywords.join(' ')}` : '',
      slotConstraint?.excluded_subs?.length ? `exclude subtype families ${slotConstraint.excluded_subs.join(' ')}` : '',
      slotConstraint?.excluded_entities?.length ? `exclude entities ${slotConstraint.excluded_entities.join(' ')}` : '',
      slotConstraint?.excluded_colours?.length ? `exclude colours ${slotConstraint.excluded_colours.join(' ')}` : '',
    ]);
    slotIdentity[slot] = joinParts([slotIdentity[slot], scopedIdentity, slotConstraintText]);
    slotStyle[slot] = joinParts([slotStyle[slot], roleStyle, scopedStyle, `slot ${slot}`]);
    slots[slot] = joinParts([slotIdentity[slot], slotStyle[slot]]);
  }

  return {
    general: joinParts([identity, style]),
    identity,
    style,
    slots,
    slot_identity: slotIdentity,
    slot_style: slotStyle,
  };
}

function normalizeAnchorEmbeddings(anchorEmbeddings: RequestAnchorEmbedding[] | undefined | null): RequestAnchorEmbedding[] {
  return (Array.isArray(anchorEmbeddings) ? anchorEmbeddings : [])
    .map((entry) => {
      const id = String(entry?.id || '').trim();
      const slot = entry?.slot && SLOT_ORDER.includes(entry.slot) ? entry.slot : null;
      const vector = Array.isArray(entry?.vector)
        ? entry.vector.map((value) => Number(value)).filter((value) => Number.isFinite(value))
        : [];
      if (!id || !vector.length) return null;
      return { id, slot, vector };
    })
    .filter(Boolean) as RequestAnchorEmbedding[];
}

function mergePromptEmbeddingsWithAnchors(
  current: PromptEmbeddingState,
  anchorEmbeddings: RequestAnchorEmbedding[] | undefined | null,
): PromptEmbeddingState {
  if (current.source === 'off') return current;
  const normalized = normalizeAnchorEmbeddings(anchorEmbeddings);
  if (!normalized.length) return current;

  const mergedPromptVector = weightedAverageVectors([
    ...(current.promptVector.length ? [{ vector: current.promptVector, weight: 1 }] : []),
    {
      vector: weightedAverageVectors(
        normalized.map((entry) => ({ vector: entry.vector, weight: entry.slot ? 1.15 : 1 })),
      ),
      weight: Math.min(0.9, 0.34 + Math.max(0, normalized.length - 1) * 0.08),
    },
  ]);

  const slotPromptVectors = { ...current.slotPromptVectors };
  for (const slot of SLOT_ORDER) {
    const slotAnchors = normalized.filter((entry) => entry.slot === slot);
    if (!slotAnchors.length) continue;
    const mergedSlotVector = weightedAverageVectors([
      ...(slotPromptVectors[slot]?.length ? [{ vector: slotPromptVectors[slot] || [], weight: 1 }] : []),
      {
        vector: weightedAverageVectors(slotAnchors.map((entry) => ({ vector: entry.vector, weight: 1 }))),
        weight: 0.55,
      },
    ]);
    if (mergedSlotVector.length) slotPromptVectors[slot] = mergedSlotVector;
  }

  const promptVector = mergedPromptVector.length ? mergedPromptVector : current.promptVector;
  return {
    ...current,
    active: current.active || !!promptVector.length,
    available: current.available || !!promptVector.length,
    source: `${current.source}+anchors`,
    promptVector,
    slotPromptVectors,
  };
}

export class EmbeddingService {
  private readonly baseEmbeddingService = new BaseEmbeddingService();

  public async resolvePromptEmbeddings(
    request: RecommendationRequest,
    intent: PromptIntentV2,
    embeddings: LoadedEmbeddings,
    corpusStats: SemanticCorpusStats,
  ): Promise<PromptEmbeddingState> {
    const effectiveEmbeddingModel = embeddings.model || request.embeddingModel;
    const axisProfile = derivePromptSemanticAxisProfile(intent);
    if (request.embeddingMode === 'off') {
      const offBundle = buildPromptSemanticBundleV2(request.prompt, intent, corpusStats);
      return mergePromptEmbeddingsWithAnchors({
        active: false,
        available: false,
        source: 'off',
        reason: 'embedding_mode_off',
        cacheHit: false,
        retryCount: 0,
        model: effectiveEmbeddingModel,
        location: request.location,
        promptVector: [],
        identityVector: [],
        styleVector: [],
        slotPromptVectors: {},
        slotIdentityVectors: {},
        slotStyleVectors: {},
        semanticAxisProfile: axisProfile,
        semanticInformativeness: semanticInformativeness(intent, offBundle, axisProfile),
      }, request.anchorEmbeddings);
    }

    if (!embeddings.sidecar) {
      const missingBundle = buildPromptSemanticBundleV2(request.prompt, intent, corpusStats);
      return mergePromptEmbeddingsWithAnchors({
        active: false,
        available: false,
        source: 'missing',
        reason: 'sidecar_missing',
        cacheHit: false,
        retryCount: 0,
        model: effectiveEmbeddingModel,
        location: request.location,
        promptVector: [],
        identityVector: [],
        styleVector: [],
        slotPromptVectors: {},
        slotIdentityVectors: {},
        slotStyleVectors: {},
        semanticAxisProfile: axisProfile,
        semanticInformativeness: semanticInformativeness(intent, missingBundle, axisProfile),
      }, request.anchorEmbeddings);
    }

    try {
      const bundle = buildPromptSemanticBundleV2(request.prompt, intent, corpusStats);
      const informativeness = semanticInformativeness(intent, bundle, axisProfile);
      const cachePrefix = `${PROMPT_EMBEDDING_CACHE_SCHEMA_VERSION}::${normalizeText(request.location)}::${normalizeText(effectiveEmbeddingModel)}`;
      const refs: Array<{ key: string; text: string; slot?: CategoryMain; kind: 'general' | 'identity' | 'style' | 'slot_general' | 'slot_identity' | 'slot_style' }> = [];
      const pushRef = (kind: 'general' | 'identity' | 'style' | 'slot_general' | 'slot_identity' | 'slot_style', text: string, slot?: CategoryMain) => {
        const normalizedText = joinParts([text]);
        if (!normalizedText) return;
        const key = slot
          ? `${cachePrefix}::${kind}::${slot}::${normalizedText}`
          : `${cachePrefix}::${kind}::${normalizedText}`;
        refs.push({ key, text: normalizedText, slot, kind });
      };

      pushRef('general', bundle.general);
      if (needsGlobalIdentityVector(intent, bundle)) pushRef('identity', bundle.identity);
      if (needsGlobalStyleVector(intent, bundle)) pushRef('style', bundle.style);

      const targetSlots = (intent.requested_slots.length ? intent.requested_slots : SLOT_ORDER)
        .filter((slot, index, array) => array.indexOf(slot) === index);
      for (const slot of targetSlots) {
        if (bundle.slots[slot] && bundle.slots[slot] !== bundle.general) {
          pushRef('slot_general', bundle.slots[slot] || '', slot);
        }
        if (slotHasIdentityDemand(intent, slot) && bundle.slot_identity[slot] && bundle.slot_identity[slot] !== bundle.identity) {
          pushRef('slot_identity', bundle.slot_identity[slot] || '', slot);
        }
        if (slotHasStyleDemand(intent, slot) && bundle.slot_style[slot] && bundle.slot_style[slot] !== bundle.style) {
          pushRef('slot_style', bundle.slot_style[slot] || '', slot);
        }
      }

      const persistedCache = getPersistedPromptEmbeddingCache();
      const resolvedVectors = new Map<string, number[]>();
      const missingRefs: typeof refs = [];
      const bypassEmbeddingCache = !!request.bypassEmbeddingCache;
      let liveRetryCount = 0;

      for (const ref of refs) {
        if (!bypassEmbeddingCache && PROMPT_EMBEDDING_CACHE.has(ref.key)) {
          resolvedVectors.set(ref.key, PROMPT_EMBEDDING_CACHE.get(ref.key) || []);
          continue;
        }
        if (!bypassEmbeddingCache && persistedCache[ref.key]?.source === 'live' && persistedCache[ref.key].vector?.length) {
          PROMPT_EMBEDDING_CACHE.set(ref.key, persistedCache[ref.key].vector);
          resolvedVectors.set(ref.key, persistedCache[ref.key].vector);
          continue;
        }
        missingRefs.push(ref);
      }

      if (missingRefs.length && !bypassEmbeddingCache) {
        const durableCache = await loadDurablePromptEmbeddings(missingRefs.map((ref) => ref.key));
        if (durableCache.size) {
          for (const ref of missingRefs) {
            const cached = durableCache.get(ref.key);
            if (!cached?.vector?.length) continue;
            PROMPT_EMBEDDING_CACHE.set(ref.key, cached.vector);
            const persistedCache = getPersistedPromptEmbeddingCache();
            persistedCache[ref.key] = {
              vector: cached.vector,
              source: 'live',
              created_at: cached.created_at,
            };
            resolvedVectors.set(ref.key, cached.vector);
          }
          persistVectorCache(PROMPT_EMBEDDING_CACHE_PATH, getPersistedPromptEmbeddingCache());
        }
      }

      const remainingRefs = missingRefs.filter((ref) => !resolvedVectors.has(ref.key));

      if (remainingRefs.length) {
        if (!request.project) {
          return mergePromptEmbeddingsWithAnchors({
            active: false,
            available: false,
            source: 'missing',
            reason: 'project_missing',
            cacheHit: false,
            retryCount: 0,
            model: effectiveEmbeddingModel,
            location: request.location,
            promptVector: [],
            identityVector: [],
            styleVector: [],
            slotPromptVectors: {},
            slotIdentityVectors: {},
            slotStyleVectors: {},
            semanticAxisProfile: axisProfile,
            semanticInformativeness: informativeness,
          }, request.anchorEmbeddings);
        }
        const ai = createGoogleGenAIClient(request.project, request.location);
        const uniqueTexts = new Map<string, typeof missingRefs>();
        for (const ref of remainingRefs) {
          const list = uniqueTexts.get(ref.text) || [];
          list.push(ref);
          uniqueTexts.set(ref.text, list);
        }
        const texts = Array.from(uniqueTexts.keys());
        const maxRetries = 4;
        const baseDelayMs = 1200;
        let retryCount = 0;
        let vectors: number[][] = [];
        while (true) {
          try {
            vectors = await withTimeout(
              embedTexts(ai, effectiveEmbeddingModel, texts, 'RETRIEVAL_QUERY'),
              12000,
              'prompt_embedding_v2',
            );
            break;
          } catch (error) {
            if (retryCount >= maxRetries || !isRetryableEmbeddingError(error)) throw error;
            const delayMs = baseDelayMs * Math.max(1, 2 ** retryCount) + Math.round(Math.random() * 200);
            if (request.debug) console.error('[DEBUG]', 'embedding_v2 prompt embedding retry', retryCount + 1, 'delay_ms', delayMs);
            await sleep(delayMs);
            retryCount += 1;
          }
        }
        liveRetryCount = retryCount;
        for (let i = 0; i < texts.length; i++) {
          const vector = vectors[i] || [];
          if (!vector.length) continue;
          for (const ref of uniqueTexts.get(texts[i]) || []) {
            resolvedVectors.set(ref.key, vector);
            rememberPromptEmbedding(ref.key, vector);
            void persistDurablePromptEmbedding(ref.key, vector).catch(() => {});
          }
        }
        if (!vectors.length && request.debug) console.error('[DEBUG]', 'embedding_v2 prompt embedding empty vectors');
      }

      const promptVector = resolvedVectors.get(refs.find((ref) => ref.kind === 'general')?.key || '') || [];
      const identityVector = resolvedVectors.get(refs.find((ref) => ref.kind === 'identity')?.key || '') || [];
      const styleVector = resolvedVectors.get(refs.find((ref) => ref.kind === 'style')?.key || '') || [];
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
        return mergePromptEmbeddingsWithAnchors({
          active: false,
          available: false,
          source: 'missing',
          reason: 'prompt_embedding_empty',
          cacheHit: false,
          retryCount: 0,
          model: effectiveEmbeddingModel,
          location: request.location,
          promptVector: [],
          identityVector: [],
          styleVector: [],
          slotPromptVectors: {},
          slotIdentityVectors: {},
          slotStyleVectors: {},
          semanticAxisProfile: axisProfile,
          semanticInformativeness: informativeness,
        }, request.anchorEmbeddings);
      }

      return mergePromptEmbeddingsWithAnchors({
        active: true,
        available: true,
        source: remainingRefs.length ? 'live' : 'cache_live',
        reason: null,
        cacheHit: !remainingRefs.length,
        retryCount: liveRetryCount,
        model: effectiveEmbeddingModel,
        location: request.location,
        promptVector,
        identityVector,
        styleVector,
        slotPromptVectors,
        slotIdentityVectors,
        slotStyleVectors,
        semanticAxisProfile: axisProfile,
        semanticInformativeness: informativeness,
      }, request.anchorEmbeddings);
    } catch (error) {
      if (request.debug) console.error('[DEBUG]', 'embedding_v2 prompt embedding failed', error);
      const failedBundle = buildPromptSemanticBundleV2(request.prompt, intent, corpusStats);
      return mergePromptEmbeddingsWithAnchors({
        active: false,
        available: false,
        source: 'missing',
        reason: 'prompt_embedding_failed',
        cacheHit: false,
        retryCount: 0,
        model: effectiveEmbeddingModel,
        location: request.location,
        promptVector: [],
        identityVector: [],
        styleVector: [],
        slotPromptVectors: {},
        slotIdentityVectors: {},
        slotStyleVectors: {},
        semanticAxisProfile: axisProfile,
        semanticInformativeness: semanticInformativeness(intent, failedBundle, axisProfile),
      }, request.anchorEmbeddings);
    }
  }

  public synthesizePromptEmbeddingsFromCandidates(
    current: PromptEmbeddingState,
    candidatesBySlot: Record<CategoryMain, ScoredItem[]>,
    slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
    embeddings: LoadedEmbeddings,
  ): PromptEmbeddingState {
    const synthesized = this.baseEmbeddingService.synthesizePromptEmbeddingsFromCandidates(
      current,
      candidatesBySlot,
      slotProfiles,
      embeddings,
    );
    return {
      ...synthesized,
      cacheHit: current.cacheHit ?? false,
      retryCount: current.retryCount ?? 0,
      model: current.model || embeddings.model,
      location: current.location || null,
      semanticAxisProfile: current.semanticAxisProfile || null,
      semanticInformativeness: current.semanticInformativeness ?? 0,
    };
  }

  public semanticContribution(promptEmbeddings: PromptEmbeddingState, itemId: string, slot: CategoryMain, embeddings: LoadedEmbeddings): number {
    if (!promptEmbeddings.available) return 0;
    const itemVector = embeddings.slotStyleVectors[slot].get(itemId) || embeddings.styleVectors.get(itemId) || embeddings.itemVectors.get(itemId) || [];
    const promptVector = promptEmbeddings.slotStyleVectors[slot] || promptEmbeddings.styleVector || promptEmbeddings.promptVector;
    return promptVector.length && itemVector.length ? cosineSimilarity(promptVector, itemVector) : 0;
  }

  public averageSlotSemanticVector(itemIds: string[], slot: CategoryMain, embeddings: LoadedEmbeddings): number[] {
    return weightedAverageVectors(itemIds.map((itemId, index) => ({
      vector: embeddings.slotStyleVectors[slot].get(itemId) || embeddings.styleVectors.get(itemId) || embeddings.itemVectors.get(itemId) || [],
      weight: Math.max(0.1, itemIds.length - index),
    })));
  }
}
