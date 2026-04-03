import fs from 'fs';
import { SemanticCorpusStats } from '../canonical_index';
import {
  ActivityContext,
  CategoryMain,
  Colour,
  DaypartContext,
  Gender,
  OccasionTag,
  PaletteMode,
  PaletteOverrideStrength,
  PromptIntent,
  RequirementMode,
  SettingContext,
  Vibe,
  deriveRequestedForm,
  normalizeOccasionTags,
  normalizeText,
  normalizeVibes,
} from '../fashion_taxonomy';
import { uniq } from '../text';
import { PromptParser as BasePromptParser } from '../og_recommendation/RecommendationService';
import { createGoogleGenAIClient, resolveGeminiParseCachePath } from '../semantic_embeddings';
import { loadDurablePromptParse, persistDurablePromptParse } from './DurablePromptCache';
import { GeminiIntentState, RecommendationRequest } from './types';
import {
  AssemblyMode,
  BrandFitMode,
  ParserSource,
  PersonaProfile,
  PromptIntentV2,
  SemanticSubject,
  SemanticSubjectKind,
  SemanticDirectives,
  StyleSubjectKind,
  SubjectScope,
  SemanticSubjectSource,
} from './types';

type SlotMap = Partial<Record<Exclude<StyleSubjectKind, 'none'>, CategoryMain[]>>;
const SERVICE_ACCOUNT_CANDIDATES = [
  'fshn-6a61b-800e2677dc54.json',
  'service-account.json',
  'vertex-service-account.json',
];

const ALLOWED_SETTINGS = new Set<SettingContext>(['office', 'beach', 'nightlife', 'home', 'travel', 'resort', 'campus', 'formal_event']);
const ALLOWED_ACTIVITIES = new Set<ActivityContext>(['sleep', 'lounge', 'beach', 'sport', 'party', 'dinner', 'travel', 'work', 'study']);
const ALLOWED_DAYPARTS = new Set<DaypartContext>(['day', 'night', 'bedtime']);
const ALLOWED_SEMANTIC_SUBJECTS = new Set<SemanticSubjectKind>(['persona', 'style_archetype', 'brand', 'team', 'item_line', 'theme']);
const ALLOWED_STYLE_SUBJECTS = new Set<StyleSubjectKind>(['persona', 'style_archetype', 'brand', 'team', 'item_line', 'theme', 'none']);
const ALLOWED_PALETTE_MODES = new Set<PaletteMode>(['unconstrained', 'monochrome', 'tonal', 'colorful', 'muted']);
const ALLOWED_REQUIREMENT_MODES = new Set<RequirementMode>(['none', 'optional', 'required']);
const ALLOWED_OVERRIDE_STRENGTHS = new Set<PaletteOverrideStrength>(['none', 'soft', 'hard']);
const ALLOWED_COLOURS = new Set<Colour>(['black', 'white', 'grey', 'red', 'blue', 'green', 'beige', 'brown', 'pink', 'orange', 'yellow', 'purple']);
const GEMINI_PARSE_CACHE_SCHEMA_VERSION = 1;
const GEMINI_PARSE_CACHE_PATH = resolveGeminiParseCachePath(process.cwd());
const GLOBAL_SUBJECT_ANCHORS = ['outfit', 'fit', 'look', 'style', 'aesthetic', 'vibe', 'wardrobe'];
const SLOT_SUBJECT_PATTERNS: Array<{ slot: CategoryMain; pattern: RegExp }> = [
  { slot: 'top', pattern: /\b(shirt|top|tee|tshirt|t-shirt|hoodie|sweater|jumper|cardigan|jacket|coat|blazer|polo)\b/i },
  { slot: 'bottom', pattern: /\b(bottom|bottoms|pants|trousers|jeans|shorts|skirt|cargo|cargos)\b/i },
  { slot: 'shoes', pattern: /\b(shoe|shoes|sneaker|sneakers|trainer|trainers|boot|boots|heel|heels|loafer|loafers|derby|oxford)\b/i },
  { slot: 'mono', pattern: /\b(dress|gown|onesie|jumpsuit)\b/i },
];
const SEMANTIC_REQUEST_PREFIX = /^(?:please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|help\s+me\s+|recommend(?:\s+me)?\s+|suggest(?:\s+me)?\s+|build(?:\s+me)?\s+|create(?:\s+me)?\s+|give\s+me\s+|show\s+me\s+|find\s+me\s+|need\s+|i\s+need\s+|i\s+want\s+|want\s+|looking\s+for\s+|looking\s+to\s+wear\s+)/i;
const SEMANTIC_REQUEST_FILLER = /\b(?:a|an|the|complete|full|entire|some|any)\b/gi;
const TRAILING_SUBJECT_CONNECTOR = /\b(?:with|using|that|which|for|but|without|avoid|excluding|except)\b/i;
const CLAUSE_LEAD_PATTERN = /^(?:that|which|who|where|when|whose|with|using|while|so\s+that|to\s+be|to\s+feel|avoid|without|excluding|except|recommend|suggest|build|create|show|find)\b/i;
const ENTITY_STOPWORDS = new Set(['that', 'which', 'who', 'where', 'when', 'all', 'feel', 'stylistically', 'cohesive', 'avoid', 'without', 'excluding', 'except', 'recommend', 'suggest', 'build', 'create', 'show', 'find', 'pieces']);
const SPORT_POSITIVE_TOKENS = new Set(['sport', 'football', 'soccer', 'basketball', 'kit', 'jersey']);

interface PersistedGeminiParseCacheEntry {
  payload: any;
  created_at: string;
  source: 'live';
  model: string;
  location: string;
  parser_mode: 'auto' | 'gemini';
  schema_version: number;
}

interface PersistedGeminiParseCacheFile {
  entries: Record<string, PersistedGeminiParseCacheEntry>;
}

interface SanitizedIntentMeta {
  subjectSource: SemanticSubjectSource;
  recoveredSubjects: SemanticSubject[];
}

interface RecoveredSubjectCandidate {
  label: string;
  kindHint?: SemanticSubjectKind | null;
  slots: CategoryMain[];
  scopeHint: SubjectScope | null;
  cue: 'brand_focus' | 'team_focus' | 'item_line' | 'type' | 'inspired' | 'global_prefix' | 'slot_prefix';
  originalLabel?: string | null;
}

interface PromptSemanticConcept {
  pattern: RegExp;
  vibes?: Vibe[];
  occasions?: OccasionTag[];
  settings?: SettingContext[];
  activities?: ActivityContext[];
  dayparts?: DaypartContext[];
  style_axes?: string[];
  silhouette_terms?: string[];
  palette_terms?: string[];
}

let PERSISTED_GEMINI_PARSE_CACHE: Record<string, PersistedGeminiParseCacheEntry> | null = null;
let LAST_GEMINI_REQUEST_AT = 0;

type SlotConstraintHints = Partial<NonNullable<PromptIntent['slot_constraints'][CategoryMain]>>;

const LEXICAL_SEMANTIC_CONCEPTS: PromptSemanticConcept[] = [
  {
    pattern: /\b(old money|quiet luxury|stealth wealth)\b/,
    vibes: ['preppy', 'chic', 'minimal'],
    occasions: ['smart_casual'],
    style_axes: ['refined', 'classic', 'preppy', 'understated', 'heritage', 'tailored', 'timeless', 'elevated', 'neutral'],
    silhouette_terms: ['tailored', 'structured', 'clean lines', 'sleek'],
    palette_terms: ['neutral', 'beige', 'brown', 'white', 'black', 'navy', 'earth tones', 'no logos'],
  },
  {
    pattern: /\b(streetwear|street fit|street style)\b/,
    vibes: ['streetwear', 'edgy'],
    style_axes: ['streetwear', 'urban', 'relaxed', 'oversized', 'graphic'],
    silhouette_terms: ['oversized', 'relaxed'],
    palette_terms: ['black', 'white', 'grey', 'washed', 'graphic'],
  },
  {
    pattern: /\b(formal|fancy|dressy|elegant|classy|black tie)\b/,
    vibes: ['formal', 'chic'],
    occasions: ['formal'],
    settings: ['formal_event'],
    style_axes: ['refined', 'elegant', 'polished', 'tailored', 'structured', 'understated'],
    silhouette_terms: ['tailored', 'structured', 'sleek'],
    palette_terms: ['black', 'white', 'grey', 'navy', 'neutral'],
  },
  {
    pattern: /\b(dinner|date night|evening|cocktail)\b/,
    vibes: ['formal', 'chic'],
    occasions: ['evening', 'smart_casual'],
    activities: ['dinner'],
    dayparts: ['night'],
    style_axes: ['refined', 'polished', 'smart casual', 'understated', 'tailored'],
    silhouette_terms: ['structured', 'sleek'],
    palette_terms: ['black', 'white', 'grey', 'brown', 'navy', 'neutral'],
  },
];

const SOFT_BROAD_REQUIRED_KEYWORD_RE =
  /\b(cotton|linen|wool|cashmere|knit|knitted|ribbed|jersey|poplin|suede|leather|silk|satin|collared|tailored|structured|sleek|minimal|neutral|muted|earth tones?)\b/i;
const SPORT_REQUIRED_KEYWORD_RE =
  /\b(football|soccer|basketball|running|runner|tennis|gym|workout|training|trainer|cross trainer|cross-training|jordan|air jordan|lebron|kobe|dunk|cleat|cleats|turf|firm ground|soft ground|artificial ground|court|marathon|tempo|pegasus|vaporfly|alphafly|metcon)\b/i;

function uniqNormalized(values: Array<string | null | undefined>): string[] {
  return uniq(values.map((value) => normalizeText(value || '')).filter(Boolean));
}

function brandSemanticTerms(intent: PromptIntentV2): string[] {
  return uniqNormalized([
    ...(intent.brand_focus || []),
    ...((intent.semantic_subjects || [])
      .filter((subject) => subject.kind === 'brand')
      .flatMap((subject) => [subject.label, ...(subject.soft_brand_priors || [])])),
  ]);
}

function brandPromptWantsFullCoverage(prompt: string, terms: string[]): boolean {
  const norm = normalizeText(prompt || '');
  if (!norm || !terms.length) return false;
  return terms.some((term) => {
    const escaped = term
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    if (!escaped) return false;
    return (
      new RegExp(`\\b(?:all|full|only|just)\\s+${escaped}\\b`, 'i').test(norm) ||
      new RegExp(`\\bhead(?:\\s|-)?to(?:\\s|-)?toe\\s+${escaped}\\b`, 'i').test(norm) ||
      new RegExp(`\\b${escaped}\\s+(?:only)\\b`, 'i').test(norm)
    );
  });
}

function deriveBrandFitMode(prompt: string, intent: PromptIntentV2): BrandFitMode {
  if (intent.assembly_mode !== 'full_outfit') return 'none';
  if ((intent.requested_slots?.length || 0) < 2) return 'none';
  const terms = brandSemanticTerms(intent);
  if (!terms.length) return 'none';
  if (brandPromptWantsFullCoverage(prompt, terms)) return 'full_brand_coverage';
  return 'single_brand_presence';
}

function ensureBrandSemanticSubjects(intent: PromptIntentV2, genderPref: Gender | 'any'): PromptIntentV2 {
  const brandTerms = uniqNormalized(intent.brand_focus || []);
  if (!brandTerms.length) return intent;
  const existing = new Set(
    (intent.semantic_subjects || [])
      .filter((subject) => subject.kind === 'brand')
      .map((subject) => normalizeText(subject.label)),
  );
  const additions: SemanticSubject[] = brandTerms
    .filter((label) => !existing.has(normalizeText(label)))
    .map((label) => ({
      kind: 'brand',
      label,
      confidence: 0.9,
      scope: 'global',
      slots: [],
      style_axes: [],
      silhouette_terms: [],
      palette_terms: [],
      category_preferences: intent.requested_slots.length ? [...intent.requested_slots] : [],
      soft_brand_priors: [],
      gender_signal: intent.target_gender === 'any' ? genderPref : intent.target_gender,
    }));
  if (!additions.length) return intent;
  return {
    ...intent,
    semantic_subjects: mergeSemanticSubjects(intent.semantic_subjects || [], additions),
    style_subjects: uniq([...(intent.style_subjects || []).filter((subject) => subject !== 'none'), 'brand']) as StyleSubjectKind[],
  };
}

function applyBrandFitMode(prompt: string, intent: PromptIntentV2, genderPref: Gender | 'any'): PromptIntentV2 {
  const withBrandSubjects = ensureBrandSemanticSubjects(intent, genderPref);
  return {
    ...withBrandSubjects,
    brand_fit_mode: deriveBrandFitMode(prompt, withBrandSubjects),
  };
}

function uniqStructuredStrings(values: Array<string | null | undefined>): string[] {
  return uniq(values.map((value) => String(value || '').trim()).filter(Boolean));
}

function mergeConstraintStringLists(current: string[] | undefined, next: string[] | undefined): string[] {
  return uniqStructuredStrings([...(current || []), ...(next || [])]);
}

function mergeSlotConstraintHints(
  current: PromptIntent['slot_constraints'][CategoryMain] | undefined,
  next: SlotConstraintHints | undefined,
): PromptIntent['slot_constraints'][CategoryMain] {
  return {
    preferred_subs: mergeConstraintStringLists(current?.preferred_subs, next?.preferred_subs),
    preferred_entities: mergeConstraintStringLists(current?.preferred_entities, next?.preferred_entities),
    required_keywords: mergeConstraintStringLists(current?.required_keywords, next?.required_keywords),
    colour_hints: mergeConstraintStringLists(current?.colour_hints, next?.colour_hints),
    fit_hints: mergeConstraintStringLists(current?.fit_hints, next?.fit_hints),
    vibe_hints: mergeConstraintStringLists(current?.vibe_hints, next?.vibe_hints),
    occasion_hints: mergeConstraintStringLists(current?.occasion_hints, next?.occasion_hints),
    excluded_keywords: mergeConstraintStringLists(current?.excluded_keywords, next?.excluded_keywords),
    excluded_subs: mergeConstraintStringLists(current?.excluded_subs, next?.excluded_subs),
    excluded_entities: mergeConstraintStringLists(current?.excluded_entities, next?.excluded_entities),
    excluded_colours: mergeConstraintStringLists(current?.excluded_colours, next?.excluded_colours),
  };
}

function promptIsBroadMultiSlotStyle(intent: PromptIntentV2): boolean {
  const requested = intent.requested_slots.length ? intent.requested_slots : promptRequestedSlots(intent);
  if (intent.assembly_mode !== 'full_outfit') return false;
  if (requested.length < 3) return false;
  if (intent.brand_focus.length || intent.team_focus.length || intent.specific_items.length) return false;
  const slotAnchored = (['top', 'bottom', 'shoes', 'mono'] as CategoryMain[]).some((slot) => {
    const constraint = intent.slot_constraints?.[slot];
    return !!(
      constraint?.preferred_entities?.length ||
      constraint?.colour_hints?.length ||
      constraint?.fit_hints?.length
    );
  });
  if (slotAnchored) return false;
  return !!(
    intent.vibe_tags.length ||
    intent.occasion_tags.length ||
    intent.semantic_subjects.some((subject) => subject.kind === 'style_archetype' || subject.kind === 'theme' || subject.kind === 'persona')
  );
}

function promptHasExplicitMonoSignal(prompt: string): boolean {
  const norm = normalizeText(prompt);
  if (!norm) return false;
  return /\b(dress|gown|onesie|jumpsuit|romper|playsuit|one piece|one-piece)\b/.test(norm);
}

function normalizeImplicitMonoExpansion(
  prompt: string,
  structural: PromptIntent,
  fallback: PromptIntent,
  semanticSubjects: SemanticSubject[],
  requestedSlots: CategoryMain[],
): {
  structural: PromptIntent;
  semanticSubjects: SemanticSubject[];
  requestedSlots: CategoryMain[];
  suppressRawMonoRequirement: boolean;
} {
  const fallbackRequested = promptRequestedSlots(fallback);
  const structuralRequested = promptRequestedSlots(structural);
  const broadOutfitPrompt = /\boutfit|fit|look\b/.test(normalizeText(prompt)) || fallbackRequested.length >= 2;
  const monoExplicit = promptHasExplicitMonoSignal(prompt);
  const fallbackMono = fallback.required_categories.includes('mono') || fallback.optional_categories.includes('mono');
  const structuralMono = structural.required_categories.includes('mono') || structural.optional_categories.includes('mono');
  const requestedMono = requestedSlots.includes('mono');
  const subjectMono = semanticSubjects.some((subject) =>
    subject.slots.includes('mono') || subject.category_preferences.includes('mono'),
  );

  if (!broadOutfitPrompt || monoExplicit || fallbackMono || (!structuralMono && !requestedMono && !subjectMono)) {
    return {
      structural,
      semanticSubjects,
      requestedSlots,
      suppressRawMonoRequirement: false,
    };
  }

  const normalizedRequested = uniq((requestedSlots.length ? requestedSlots : structuralRequested).filter((slot) => slot !== 'mono'));
  const alignedRequested = normalizedRequested.length ? normalizedRequested : fallbackRequested;
  const alignedSubjects = semanticSubjects.map((subject) => {
    if (subject.kind !== 'style_archetype' && subject.kind !== 'theme' && subject.kind !== 'persona') return subject;
    const category_preferences = uniq(
      (subject.category_preferences || [])
        .filter((slot) => slot !== 'mono')
        .concat(alignedRequested.length ? alignedRequested : []),
    );
    const slots = uniq((subject.slots || []).filter((slot) => slot !== 'mono'));
    return {
      ...subject,
      slots,
      category_preferences,
    };
  });

  return {
    structural: {
      ...structural,
      requested_form: fallback.requested_form,
      required_categories: [...fallback.required_categories],
      optional_categories: [...fallback.optional_categories],
      mono_requirement: fallback.mono_requirement,
      shoe_requirement: fallback.shoe_requirement,
      outfit_mode: fallback.outfit_mode,
    },
    semanticSubjects: alignedSubjects,
    requestedSlots: alignedRequested,
    suppressRawMonoRequirement: true,
  };
}

function relaxBroadPromptSlotConstraints(intent: PromptIntentV2): PromptIntentV2 {
  if (!promptIsBroadMultiSlotStyle(intent)) return intent;
  const next: PromptIntentV2 = {
    ...intent,
    slot_constraints: {
      top: { ...intent.slot_constraints.top },
      bottom: { ...intent.slot_constraints.bottom },
      shoes: { ...intent.slot_constraints.shoes },
      mono: { ...intent.slot_constraints.mono },
    },
  };

  for (const slot of ['top', 'bottom', 'shoes', 'mono'] as CategoryMain[]) {
    const constraint = next.slot_constraints[slot];
    if (!constraint) continue;
    if (constraint.preferred_entities.length) continue;
    if (slot === 'shoes' && intent.sport_context !== 'none') continue;

    const preserved = constraint.required_keywords.filter((keyword) => {
      const norm = normalizeText(keyword || '');
      if (!norm) return false;
      if (SPORT_REQUIRED_KEYWORD_RE.test(norm)) return true;
      if (slotTerms(norm).includes(slot)) return true;
      if (intent.team_focus.some((entry) => normalizeText(entry) === norm || normalizeText(entry).includes(norm) || norm.includes(normalizeText(entry)))) return true;
      if (intent.brand_focus.some((entry) => normalizeText(entry) === norm || normalizeText(entry).includes(norm) || norm.includes(normalizeText(entry)))) return true;
      if (intent.specific_items.some((entry) => normalizeText(entry) === norm || normalizeText(entry).includes(norm) || norm.includes(normalizeText(entry)))) return true;
      return !SOFT_BROAD_REQUIRED_KEYWORD_RE.test(norm);
    });

    const softCeiling = slot === 'shoes' ? 4 : slot === 'mono' ? 3 : 2;
    constraint.required_keywords = uniqStructuredStrings(
      (preserved.length ? preserved : constraint.required_keywords.filter((keyword) => {
        const norm = normalizeText(keyword || '');
        return !!norm && !SOFT_BROAD_REQUIRED_KEYWORD_RE.test(norm);
      })).slice(0, softCeiling),
    );

    if (slot !== 'shoes' && constraint.preferred_subs.length > 6) {
      constraint.preferred_subs = constraint.preferred_subs.slice(0, 6);
    }
  }

  return next;
}

function enforceExplicitPaletteLocks(intent: PromptIntentV2): PromptIntentV2 {
  if (intent.palette_override_strength !== 'hard') return intent;
  const targets = uniqStructuredStrings(intent.global_palette_colours || []);
  if (!targets.length) return intent;

  const next: PromptIntentV2 = {
    ...intent,
    slot_constraints: {
      top: { ...intent.slot_constraints.top },
      bottom: { ...intent.slot_constraints.bottom },
      shoes: { ...intent.slot_constraints.shoes },
      mono: { ...intent.slot_constraints.mono },
    },
  };

  for (const slot of ['top', 'bottom', 'shoes', 'mono'] as CategoryMain[]) {
    if (!intent.slot_palette_locked?.[slot]) continue;
    const current = next.slot_constraints[slot];
    current.colour_hints = targets;
    current.excluded_colours = uniqStructuredStrings([
      ...(current.excluded_colours || []),
      ...Array.from(ALLOWED_COLOURS).filter((colour) => !targets.includes(colour)),
    ]);
  }

  return next;
}

function mergeSemanticSubjects(primary: SemanticSubject[], secondary: SemanticSubject[]): SemanticSubject[] {
  const merged = new Map<string, SemanticSubject>();
  for (const subject of [...primary, ...secondary]) {
    const key = `${subject.kind}::${normalizeText(subject.label || '')}::${subject.scope}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...subject,
        slots: uniq(subject.slots || []),
        style_axes: uniqStructuredStrings(subject.style_axes || []),
        silhouette_terms: uniqStructuredStrings(subject.silhouette_terms || []),
        palette_terms: uniqStructuredStrings(subject.palette_terms || []),
        category_preferences: uniq(subject.category_preferences || []),
        soft_brand_priors: uniqStructuredStrings(subject.soft_brand_priors || []),
      });
      continue;
    }
    merged.set(key, {
      ...existing,
      confidence: Math.max(existing.confidence, subject.confidence),
      slots: uniq([...(existing.slots || []), ...(subject.slots || [])]),
      style_axes: uniqStructuredStrings([...(existing.style_axes || []), ...(subject.style_axes || [])]),
      silhouette_terms: uniqStructuredStrings([...(existing.silhouette_terms || []), ...(subject.silhouette_terms || [])]),
      palette_terms: uniqStructuredStrings([...(existing.palette_terms || []), ...(subject.palette_terms || [])]),
      category_preferences: uniq([...(existing.category_preferences || []), ...(subject.category_preferences || [])]),
      soft_brand_priors: uniqStructuredStrings([...(existing.soft_brand_priors || []), ...(subject.soft_brand_priors || [])]),
      gender_signal: existing.gender_signal || subject.gender_signal,
    });
  }
  return Array.from(merged.values());
}

function applyPromptSemanticMappings(
  prompt: string,
  intent: PromptIntentV2,
  genderPref: Gender | 'any',
): PromptIntentV2 {
  const norm = normalizeText(prompt);
  if (!norm) return intent;

  let enriched: PromptIntentV2 = {
    ...intent,
    vibe_tags: [...intent.vibe_tags],
    occasion_tags: [...intent.occasion_tags],
    setting_context: [...intent.setting_context],
    activity_context: [...intent.activity_context],
    daypart_context: [...intent.daypart_context],
    semantic_directives: {
      style_axes: [...intent.semantic_directives.style_axes],
      silhouette_terms: [...intent.semantic_directives.silhouette_terms],
      palette_terms: [...intent.semantic_directives.palette_terms],
      category_preferences: [...intent.semantic_directives.category_preferences],
    },
  };

  for (const concept of LEXICAL_SEMANTIC_CONCEPTS) {
    if (!concept.pattern.test(norm)) continue;

    enriched.vibe_tags = uniq([...(enriched.vibe_tags || []), ...(concept.vibes || [])]);
    enriched.occasion_tags = uniq([...(enriched.occasion_tags || []), ...(concept.occasions || [])]);
    enriched.setting_context = uniq([...(enriched.setting_context || []), ...(concept.settings || [])]);
    enriched.activity_context = uniq([...(enriched.activity_context || []), ...(concept.activities || [])]);
    enriched.daypart_context = uniq([...(enriched.daypart_context || []), ...(concept.dayparts || [])]);
    enriched.semantic_directives = {
      style_axes: uniqStructuredStrings([...(enriched.semantic_directives.style_axes || []), ...(concept.style_axes || [])]),
      silhouette_terms: uniqStructuredStrings([...(enriched.semantic_directives.silhouette_terms || []), ...(concept.silhouette_terms || [])]),
      palette_terms: uniqStructuredStrings([...(enriched.semantic_directives.palette_terms || []), ...(concept.palette_terms || [])]),
      category_preferences: [...enriched.semantic_directives.category_preferences],
    };
  }

  const personaEnriched = enrichPersonaSubjectsFromIntent(enriched, genderPref);

  return collapseImplicitSingleSlotSubjectFocus(
    prompt,
    applyBrandFitMode(
      prompt,
      enforceExplicitPaletteLocks(
        relaxBroadPromptSlotConstraints(
          applyTeamAndSportContextSlotHints(personaEnriched),
        ),
      ),
      genderPref,
    ),
  );
}

function applyTeamAndSportContextSlotHints(intent: PromptIntentV2): PromptIntentV2 {
  const next: PromptIntentV2 = {
    ...intent,
    slot_constraints: {
      ...intent.slot_constraints,
      top: { ...intent.slot_constraints.top },
      bottom: { ...intent.slot_constraints.bottom },
      shoes: { ...intent.slot_constraints.shoes },
      mono: { ...intent.slot_constraints.mono },
    },
  };

  if (intent.team_focus.length) {
    next.slot_constraints.top = mergeSlotConstraintHints(next.slot_constraints.top, {
      preferred_entities: intent.team_focus,
    });
    next.slot_constraints.bottom = mergeSlotConstraintHints(next.slot_constraints.bottom, {
      preferred_entities: intent.team_focus,
    });
    if (intent.sport_context !== 'none') {
      next.slot_constraints.shoes = mergeSlotConstraintHints(next.slot_constraints.shoes, {
        preferred_entities: intent.team_focus,
      });
    }
  }

  if (intent.sport_context === 'none') return next;

  if (intent.sport_context === 'football') {
    next.slot_constraints.top = mergeSlotConstraintHints(next.slot_constraints.top, {
      preferred_subs: ['jersey', 'tshirt'],
      vibe_hints: ['sporty'],
      excluded_keywords: ['loafer', 'oxford', 'formal'],
    });
    next.slot_constraints.bottom = mergeSlotConstraintHints(next.slot_constraints.bottom, {
      preferred_subs: ['shorts'],
      vibe_hints: ['sporty'],
      excluded_keywords: ['tailored', 'formal'],
    });
    next.slot_constraints.shoes = mergeSlotConstraintHints(next.slot_constraints.shoes, {
      preferred_subs: ['boots'],
      required_keywords: ['football', 'soccer', 'cleat', 'cleats', 'turf', 'firm ground', 'soft ground', 'artificial ground'],
      vibe_hints: ['sporty'],
      excluded_keywords: ['loafer', 'oxford', 'formal', 'heel', 'sandal', 'slide'],
    });
    next.slot_constraints.shoes.preferred_subs = uniqStructuredStrings(
      next.slot_constraints.shoes.preferred_subs.filter((sub) => !/\bsneaker|athletic shoes\b/i.test(sub)).concat('boots'),
    );
  } else if (intent.sport_context === 'basketball') {
    next.slot_constraints.top = mergeSlotConstraintHints(next.slot_constraints.top, {
      preferred_subs: ['jersey', 'tshirt', 'hoodie'],
      vibe_hints: ['sporty'],
      excluded_keywords: ['loafer', 'oxford', 'formal'],
    });
    next.slot_constraints.bottom = mergeSlotConstraintHints(next.slot_constraints.bottom, {
      preferred_subs: ['shorts', 'joggers'],
      vibe_hints: ['sporty'],
      excluded_keywords: ['tailored', 'formal', 'dress pants'],
    });
    next.slot_constraints.shoes = mergeSlotConstraintHints(next.slot_constraints.shoes, {
      preferred_subs: ['athletic shoes', 'sneakers'],
      required_keywords: ['basketball', 'nba', 'jordan', 'air jordan', 'lebron', 'kobe', 'dunk'],
      vibe_hints: ['sporty'],
      excluded_keywords: ['loafer', 'oxford', 'formal', 'sandal', 'slide'],
    });
  } else if (intent.sport_context === 'running') {
    next.slot_constraints.shoes = mergeSlotConstraintHints(next.slot_constraints.shoes, {
      preferred_subs: ['athletic shoes', 'sneakers'],
      required_keywords: ['running', 'runner', 'marathon', 'tempo', 'training'],
      vibe_hints: ['sporty'],
      excluded_keywords: ['loafer', 'oxford', 'formal', 'heel', 'sandal'],
    });
  } else if (intent.sport_context === 'tennis') {
    next.slot_constraints.shoes = mergeSlotConstraintHints(next.slot_constraints.shoes, {
      preferred_subs: ['athletic shoes', 'sneakers'],
      required_keywords: ['tennis', 'court', 'hard court', 'clay'],
      vibe_hints: ['sporty'],
      excluded_keywords: ['loafer', 'oxford', 'formal', 'heel', 'sandal'],
    });
  } else if (intent.sport_context === 'gym') {
    next.slot_constraints.top = mergeSlotConstraintHints(next.slot_constraints.top, {
      preferred_subs: ['tshirt', 'tank top', 'hoodie', 'sweatshirt', 'sports bra'],
      vibe_hints: ['sporty'],
      excluded_keywords: ['football', 'soccer', 'basketball', 'jersey', 'kit', 'formula 1', 'f1', 'motorsport', 'racing', 'formal', 'blouse', 'oxford', 'dress shirt'],
    });
    next.slot_constraints.bottom = mergeSlotConstraintHints(next.slot_constraints.bottom, {
      preferred_subs: ['leggings', 'shorts', 'joggers'],
      vibe_hints: ['sporty'],
      excluded_keywords: ['football', 'soccer', 'basketball', 'jersey', 'kit', 'formula 1', 'f1', 'motorsport', 'racing', 'tailored', 'formal', 'dress pants'],
    });
    next.slot_constraints.shoes = mergeSlotConstraintHints(next.slot_constraints.shoes, {
      preferred_subs: ['athletic shoes', 'sneakers'],
      vibe_hints: ['sporty'],
      excluded_keywords: ['loafer', 'oxford', 'formal', 'heel', 'sandal'],
    });
  }

  return next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function geminiParseCacheKey(
  prompt: string,
  genderPref: Gender | 'any',
  parserMode: 'auto' | 'gemini',
  model: string,
  location: string,
): string {
  return JSON.stringify({
    schema_version: GEMINI_PARSE_CACHE_SCHEMA_VERSION,
    prompt: normalizeText(prompt),
    gender_pref: genderPref,
    parser_mode: parserMode,
    model: normalizeText(model),
    location: normalizeText(location),
  });
}

function loadPersistedGeminiParseCache(): Record<string, PersistedGeminiParseCacheEntry> {
  if (PERSISTED_GEMINI_PARSE_CACHE) return PERSISTED_GEMINI_PARSE_CACHE;
  try {
    if (!fs.existsSync(GEMINI_PARSE_CACHE_PATH)) {
      PERSISTED_GEMINI_PARSE_CACHE = {};
      return PERSISTED_GEMINI_PARSE_CACHE;
    }
    const parsed = JSON.parse(fs.readFileSync(GEMINI_PARSE_CACHE_PATH, 'utf8')) as PersistedGeminiParseCacheFile;
    PERSISTED_GEMINI_PARSE_CACHE = parsed?.entries || {};
    return PERSISTED_GEMINI_PARSE_CACHE;
  } catch {
    PERSISTED_GEMINI_PARSE_CACHE = {};
    return PERSISTED_GEMINI_PARSE_CACHE;
  }
}

function rememberGeminiParse(key: string, entry: PersistedGeminiParseCacheEntry): void {
  const cache = loadPersistedGeminiParseCache();
  cache[key] = entry;
  try {
    fs.writeFileSync(GEMINI_PARSE_CACHE_PATH, JSON.stringify({ entries: cache }, null, 2));
  } catch {
    // ignore cache write failures
  }
}

function validColours(values: any): Colour[] {
  if (!Array.isArray(values)) return [];
  return uniq(values.map((value) => normalizeText(value)).filter((value): value is Colour => ALLOWED_COLOURS.has(value as Colour)));
}

function validSlots(values: any): CategoryMain[] {
  if (!Array.isArray(values)) return [];
  return uniq(values
    .map((value) => normalizeText(value))
    .filter((value): value is CategoryMain => value === 'top' || value === 'bottom' || value === 'shoes' || value === 'mono'));
}

function validStyleSubjects(values: any): StyleSubjectKind[] {
  if (!Array.isArray(values)) return [];
  const out = uniq(values
    .map((value) => normalizeText(value).replace(/\s+/g, '_'))
    .filter((value): value is StyleSubjectKind => ALLOWED_STYLE_SUBJECTS.has(value as StyleSubjectKind)));
  return out.length ? out : ['none'];
}

function validSemanticSubjectKind(value: any): SemanticSubjectKind | null {
  const norm = normalizeText(value || '').replace(/\s+/g, '_');
  return ALLOWED_SEMANTIC_SUBJECTS.has(norm as SemanticSubjectKind) ? norm as SemanticSubjectKind : null;
}

function validSettings(values: any): SettingContext[] {
  if (!Array.isArray(values)) return [];
  return uniq(values.map((value) => normalizeText(value)).filter((value): value is SettingContext => ALLOWED_SETTINGS.has(value as SettingContext)));
}

function validActivities(values: any): ActivityContext[] {
  if (!Array.isArray(values)) return [];
  return uniq(values.map((value) => normalizeText(value)).filter((value): value is ActivityContext => ALLOWED_ACTIVITIES.has(value as ActivityContext)));
}

function validDayparts(values: any): DaypartContext[] {
  if (!Array.isArray(values)) return [];
  return uniq(values.map((value) => normalizeText(value)).filter((value): value is DaypartContext => ALLOWED_DAYPARTS.has(value as DaypartContext)));
}

function validScope(value: any): SubjectScope | null {
  const norm = normalizeText(value || '');
  if (norm === 'global' || norm === 'slot' || norm === 'mixed') return norm;
  return null;
}

function slotTerms(text: string): CategoryMain[] {
  const slots: CategoryMain[] = [];
  for (const entry of SLOT_SUBJECT_PATTERNS) {
    if (entry.pattern.test(text)) slots.push(entry.slot);
  }
  return uniq(slots);
}

function cleanRecoveredLabel(label: string): string {
  let value = String(label || '').trim();
  if (!value) return '';
  value = value.replace(SEMANTIC_REQUEST_PREFIX, '');
  value = value.replace(SEMANTIC_REQUEST_FILLER, ' ');
  value = value.replace(/\btype\b\s*$/i, ' ');
  value = value.replace(/[,:;()]+/g, ' ');
  const connector = value.search(TRAILING_SUBJECT_CONNECTOR);
  if (connector > 0) value = value.slice(0, connector);
  value = value.replace(/\b(?:all\s+feel\s+stylistically\s+cohesive|stylistically\s+cohesive|clean\s+silhouette)\b/gi, ' ');
  value = value.replace(/\s+/g, ' ').trim();
  return normalizeText(value);
}

function isClauseLikePhrase(value: string): boolean {
  const norm = normalizeText(value);
  if (!norm) return false;
  if (CLAUSE_LEAD_PATTERN.test(norm)) return true;
  const tokens = norm.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  const stopwordCount = tokens.filter((token) => ENTITY_STOPWORDS.has(token)).length;
  if (stopwordCount >= Math.ceil(tokens.length / 2)) return true;
  if (tokens.length >= 4 && (tokens.includes('feel') || tokens.includes('cohesive') || tokens.includes('avoid'))) return true;
  return false;
}

function stripClauseLikeKeywords(values: string[]): string[] {
  return uniqNormalized(values).filter((value) => !isClauseLikePhrase(value));
}

function stripClauseLikeEntities(values: string[]): string[] {
  return uniqNormalized(values).filter((value) => value && !ENTITY_STOPWORDS.has(value) && !CLAUSE_LEAD_PATTERN.test(value));
}

function cleanFocusTerms(values: string[]): string[] {
  return uniqNormalized(values).filter((value) => !isClauseLikePhrase(value));
}

function stripSportPositiveTerms(values: string[]): string[] {
  return uniqNormalized(values).filter((value) => {
    const tokens = value.split(/\s+/).filter(Boolean);
    return tokens.length > 0 && !tokens.every((token) => SPORT_POSITIVE_TOKENS.has(token));
  });
}

function matchesWholePhrase(text: string, phrase: string): boolean {
  if (!text || !phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, 'i').test(text);
}

function styleEvidenceScore(prompt: string, intent: PromptIntent): number {
  const norm = normalizeText(prompt);
  let score = 0;
  if (intent.vibe_tags.length) score += 2;
  if (intent.occasion_tags.length) score += 1;
  if (intent.palette_mode !== 'unconstrained') score += 1;
  if (intent.setting_context.length || intent.activity_context.length || intent.daypart_context.length) score += 1;
  if (intent.brand_focus.length || intent.team_focus.length || intent.specific_items.length) score += 2;
  if (intent.persona_terms.length) score += 1;
  if (GLOBAL_SUBJECT_ANCHORS.some((anchor) => matchesWholePhrase(norm, anchor))) score += 1;
  if (/\btype\b|\binspired by\b|\blike\b/.test(norm)) score += 2;
  if (/\bnon sport\b|\bno logos?\b|\bwithout logos?\b/.test(norm)) score += 1;
  return score;
}

function hasSemanticEvidence(prompt: string, intent: PromptIntentV2): boolean {
  return (
    styleEvidenceScore(prompt, intent) >= 2 ||
    intent.semantic_directives.style_axes.length > 0 ||
    intent.semantic_directives.silhouette_terms.length > 0 ||
    intent.semantic_directives.palette_terms.length > 0 ||
    intent.semantic_directives.category_preferences.length > 0 ||
    intent.vibe_tags.length > 0 ||
    intent.brand_focus.length > 0 ||
    intent.team_focus.length > 0 ||
    intent.specific_items.length > 0
  );
}

function looksLikeProperName(label: string): boolean {
  const tokens = String(label || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 5) return false;
  const uppercaseTokens = tokens.filter((token) => /^[A-Z0-9][A-Za-z0-9.'&-]*$/.test(token));
  return uppercaseTokens.length > 0;
}

function looksLikePersonName(label: string): boolean {
  const value = String(label || '').trim();
  if (!value) return false;
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5) return false;
  return tokens.every((token) => /^[A-Z0-9$][A-Za-z0-9.$'&-]*$/.test(token));
}

function promptLooksLikePersonaRequest(prompt: string): boolean {
  const trimmedPrompt = String(prompt || '').trim();
  if (!trimmedPrompt) return false;
  const globalPrefixMatch = trimmedPrompt.match(/^(.*?)\s+(outfit|fit|look|style|aesthetic|vibe|wardrobe)\b/i);
  if (globalPrefixMatch && looksLikePersonName(globalPrefixMatch[1])) return true;
  const typeMatch = trimmedPrompt.match(/^(.+?)\s+type\s+(.+)$/i);
  if (typeMatch && (looksLikePersonName(typeMatch[1]) || looksLikeProperName(typeMatch[1]))) return true;
  const inspiredMatch = trimmedPrompt.match(/(?:^|.*?\b)(?:inspired by|like)\s+(.+?)(?:\s+(?:outfit|fit|look|style|vibe|wardrobe|shirt|top|hoodie|jacket|sweater|pants|bottoms|jeans|trousers|shoes|sneakers|boots|dress)\b|$)/i);
  if (inspiredMatch && (looksLikePersonName(inspiredMatch[1]) || looksLikeProperName(inspiredMatch[1]))) return true;
  return false;
}

function styleEvidenceTerms(intent: PromptIntentV2): string[] {
  return uniqNormalized([
    ...intent.vibe_tags,
    ...intent.occasion_tags,
    ...intent.semantic_directives.style_axes,
    ...intent.semantic_directives.silhouette_terms,
    ...intent.semantic_directives.palette_terms,
    intent.palette_mode !== 'unconstrained' ? intent.palette_mode : '',
  ]);
}

function inferredSlotsForFocus(intent: PromptIntentV2, label: string): CategoryMain[] {
  const normLabel = normalizeText(label);
  const matched: CategoryMain[] = [];
  for (const slot of ['top', 'bottom', 'shoes', 'mono'] as CategoryMain[]) {
    const slotConstraint = intent.slot_constraints?.[slot];
    const values = uniqNormalized([
      ...(slotConstraint?.preferred_entities || []),
      ...(slotConstraint?.required_keywords || []),
    ]);
    if (values.some((value) => value && (normLabel.includes(value) || value.includes(normLabel)))) matched.push(slot);
  }
  if (matched.length) return matched;
  return intent.requested_slots.length === 1 ? intent.requested_slots : [];
}

function pushRecoveredCandidate(
  out: RecoveredSubjectCandidate[],
  candidate: RecoveredSubjectCandidate | null,
): void {
  if (!candidate?.label) return;
  const key = `${candidate.kindHint || 'auto'}::${candidate.scopeHint || 'auto'}::${candidate.slots.join(',')}::${candidate.label}`;
  if (out.some((entry) => `${entry.kindHint || 'auto'}::${entry.scopeHint || 'auto'}::${entry.slots.join(',')}::${entry.label}` === key)) return;
  out.push(candidate);
}

function extractRecoveredCandidates(prompt: string, intent: PromptIntentV2): RecoveredSubjectCandidate[] {
  const candidates: RecoveredSubjectCandidate[] = [];
  const requestedSlots = intent.requested_slots.length ? intent.requested_slots : promptRequestedSlots(intent);
  const explicitEntityLabels = uniqNormalized([
    ...intent.brand_focus,
    ...intent.team_focus,
    ...intent.specific_items,
  ]);

  for (const label of intent.brand_focus) {
    pushRecoveredCandidate(candidates, {
      label: normalizeText(label),
      kindHint: 'brand',
      slots: inferredSlotsForFocus(intent, label),
      scopeHint: inferredSlotsForFocus(intent, label).length ? 'slot' : (requestedSlots.length <= 1 ? 'slot' : 'global'),
      cue: 'brand_focus',
      originalLabel: label,
    });
  }

  for (const label of intent.team_focus) {
    pushRecoveredCandidate(candidates, {
      label: normalizeText(label),
      kindHint: 'team',
      slots: inferredSlotsForFocus(intent, label),
      scopeHint: inferredSlotsForFocus(intent, label).length ? 'slot' : (requestedSlots.length <= 1 ? 'slot' : 'global'),
      cue: 'team_focus',
      originalLabel: label,
    });
  }

  for (const label of intent.specific_items) {
    const slots = inferredSlotsForFocus(intent, label);
    pushRecoveredCandidate(candidates, {
      label: normalizeText(label),
      kindHint: 'item_line',
      slots,
      scopeHint: slots.length ? 'slot' : (requestedSlots.length <= 1 ? 'slot' : 'global'),
      cue: 'item_line',
      originalLabel: label,
    });
  }

  const trimmedPrompt = String(prompt || '').trim();
  const promptNorm = normalizeText(trimmedPrompt);
  const typeMatch = trimmedPrompt.match(/^(.+?)\s+type\s+(.+)$/i);
  if (typeMatch) {
    const label = cleanRecoveredLabel(typeMatch[1]);
    const slots = slotTerms(typeMatch[2]);
    pushRecoveredCandidate(candidates, {
      label,
      slots: slots.length ? slots : requestedSlots,
      scopeHint: slots.length || requestedSlots.length === 1 ? 'slot' : 'global',
      cue: 'type',
      originalLabel: typeMatch[1],
    });
  }

  const inspiredMatch = trimmedPrompt.match(/(?:^|.*?\b)(?:inspired by|like)\s+(.+?)(?:\s+(?:outfit|fit|look|style|vibe|wardrobe|shirt|top|hoodie|jacket|sweater|pants|bottoms|jeans|trousers|shoes|sneakers|boots|dress)\b|$)/i);
  if (inspiredMatch) {
    const label = cleanRecoveredLabel(inspiredMatch[1]);
    pushRecoveredCandidate(candidates, {
      label,
      slots: requestedSlots.length === 1 ? requestedSlots : [],
      scopeHint: requestedSlots.length === 1 ? 'slot' : 'global',
      cue: 'inspired',
      originalLabel: inspiredMatch[1],
    });
  }

  const globalPrefixMatch = trimmedPrompt.match(/^(.*?)\s+(outfit|fit|look|style|aesthetic|vibe|wardrobe)\b/i);
  if (globalPrefixMatch) {
    const label = cleanRecoveredLabel(globalPrefixMatch[1]);
    if (!/\btype\b|\binspired by\b|\blike\b/i.test(globalPrefixMatch[1])) {
      pushRecoveredCandidate(candidates, {
        label,
        slots: [],
        scopeHint: 'global',
        cue: 'global_prefix',
        originalLabel: globalPrefixMatch[1],
      });
    }
  }

  if (requestedSlots.length <= 1) {
    for (const entry of SLOT_SUBJECT_PATTERNS) {
      const match = trimmedPrompt.match(new RegExp(`^(.*?)\\s+${entry.pattern.source}`, 'i'));
      if (!match) continue;
      const label = cleanRecoveredLabel(match[1]);
      if (!/\btype\b|\binspired by\b|\blike\b/i.test(match[1])) {
        pushRecoveredCandidate(candidates, {
          label,
          slots: [entry.slot],
          scopeHint: 'slot',
          cue: 'slot_prefix',
          originalLabel: match[1],
        });
      }
    }
  }

  return candidates.filter((candidate) => {
    if (!candidate.label) return false;
    if (GLOBAL_SUBJECT_ANCHORS.includes(candidate.label)) return false;
    if (ALLOWED_COLOURS.has(candidate.label as Colour)) return false;
    if (!/[a-z0-9]/i.test(candidate.label)) return false;
    if (promptNorm === candidate.label && styleEvidenceScore(prompt, intent) < 3) return false;
    if (!candidate.kindHint && explicitEntityLabels.some((entry) => entry && (entry === candidate.label || entry.includes(candidate.label) || candidate.label.includes(entry)))) {
      return false;
    }
    return true;
  });
}

function classifyRecoveredSubject(
  candidate: RecoveredSubjectCandidate,
  prompt: string,
  intent: PromptIntentV2,
): SemanticSubjectKind {
  if (candidate.kindHint) return candidate.kindHint;
  const label = normalizeText(candidate.label);
  const original = String(candidate.originalLabel || candidate.label || '').trim();
  const styleTerms = styleEvidenceTerms(intent);
  const hasEntityEvidence = intent.brand_focus.some((entry) => normalizeText(entry) === label)
    || intent.team_focus.some((entry) => normalizeText(entry) === label)
    || intent.specific_items.some((entry) => normalizeText(entry) === label);
  if (hasEntityEvidence) return 'theme';
  if ((candidate.cue === 'type' || candidate.cue === 'inspired') && looksLikeProperName(original)) return 'persona';
  if ((candidate.cue === 'global_prefix' || candidate.cue === 'slot_prefix') && looksLikePersonName(original) && promptLooksLikePersonaRequest(prompt)) return 'persona';
  if (candidate.cue === 'global_prefix' || candidate.cue === 'slot_prefix' || candidate.cue === 'type') {
    if (styleEvidenceScore(prompt, intent) >= 2 || styleTerms.length) return 'style_archetype';
  }
  return 'theme';
}

function recoveredScope(candidate: RecoveredSubjectCandidate, intent: PromptIntentV2): SubjectScope {
  if (candidate.scopeHint) return candidate.scopeHint;
  if (candidate.slots.length) return intent.requested_slots.length > 1 ? 'mixed' : 'slot';
  return intent.requested_slots.length <= 1 ? 'slot' : 'global';
}

function recoveredConfidence(candidate: RecoveredSubjectCandidate, kind: SemanticSubjectKind, prompt: string, intent: PromptIntentV2): number {
  let confidence = 0.58;
  if (candidate.kindHint === 'brand' || candidate.kindHint === 'team') confidence = 0.88;
  else if (candidate.kindHint === 'item_line') confidence = 0.82;
  else if (kind === 'persona') confidence = 0.8;
  else if (kind === 'style_archetype') confidence = 0.74;
  else if (kind === 'theme') confidence = 0.66;
  confidence += Math.min(0.12, styleEvidenceScore(prompt, intent) * 0.03);
  if (candidate.slots.length) confidence += 0.04;
  return Math.max(0.4, Math.min(0.95, Number(confidence.toFixed(3))));
}

function recoveredStyleAxes(intent: PromptIntentV2): string[] {
  return uniqNormalized([
    ...intent.vibe_tags,
    ...intent.semantic_directives.style_axes,
    ...intent.occasion_tags,
  ]);
}

function recoveredSilhouetteTerms(intent: PromptIntentV2): string[] {
  return uniqNormalized([
    ...intent.semantic_directives.silhouette_terms,
    intent.fit_preference || '',
  ]);
}

function recoveredPaletteTerms(intent: PromptIntentV2): string[] {
  return uniqNormalized([
    ...intent.semantic_directives.palette_terms,
    intent.palette_mode !== 'unconstrained' ? intent.palette_mode : '',
    ...intent.global_palette_colours,
  ]);
}

function personaFallbackStyleAxes(intent: PromptIntentV2): string[] {
  return uniqNormalized([
    ...intent.vibe_tags,
    ...intent.semantic_directives.style_axes,
    ...intent.occasion_tags.map((value) => String(value || '').replace(/_/g, ' ')),
    ...intent.setting_context.map((value) => String(value || '').replace(/_/g, ' ')),
    ...intent.activity_context.map((value) => String(value || '').replace(/_/g, ' ')),
  ]);
}

function enrichPersonaSubjectsFromIntent(intent: PromptIntentV2, fallbackGender: Gender | 'any'): PromptIntentV2 {
  if (!intent.semantic_subjects.some((subject) => subject.kind === 'persona')) return intent;
  const fallbackStyleAxes = personaFallbackStyleAxes(intent);
  const fallbackSilhouettes = recoveredSilhouetteTerms(intent);
  const fallbackPaletteTerms = recoveredPaletteTerms(intent);
  const fallbackCategoryPreferences = intent.semantic_directives.category_preferences.length
    ? intent.semantic_directives.category_preferences
    : (intent.requested_slots.length ? intent.requested_slots : promptRequestedSlots(intent));
  const semantic_subjects = intent.semantic_subjects.map((subject) => {
    if (subject.kind !== 'persona') return subject;
    return {
      ...subject,
      style_axes: subject.style_axes.length ? subject.style_axes : fallbackStyleAxes,
      silhouette_terms: subject.silhouette_terms.length ? subject.silhouette_terms : fallbackSilhouettes,
      palette_terms: subject.palette_terms.length ? subject.palette_terms : fallbackPaletteTerms,
      category_preferences: subject.category_preferences.length ? subject.category_preferences : fallbackCategoryPreferences,
      gender_signal: subject.gender_signal ?? (intent.target_gender === 'any' ? (fallbackGender === 'any' ? null : fallbackGender) : intent.target_gender),
    };
  });
  return {
    ...intent,
    semantic_subjects,
    persona_profile: derivePersonaProfile(semantic_subjects, fallbackGender),
    semantic_directives: semanticDirectivesFromSubjects(semantic_subjects),
  };
}

function recoverSemanticSubjects(prompt: string, intent: PromptIntentV2, fallbackGender: Gender | 'any'): SemanticSubject[] {
  if (intent.semantic_subjects.length || (!hasSemanticEvidence(prompt, intent) && !promptLooksLikePersonaRequest(prompt))) return [];
  const candidates = extractRecoveredCandidates(prompt, intent);
  const recovered: SemanticSubject[] = [];
  for (const candidate of candidates) {
    const kind = classifyRecoveredSubject(candidate, prompt, intent);
    const scope = recoveredScope(candidate, intent);
    const slots = candidate.slots.length ? candidate.slots : (scope === 'slot' && intent.requested_slots.length ? intent.requested_slots : []);
    const subject = sanitizeSemanticSubject({
      kind,
      label: candidate.label,
      confidence: recoveredConfidence(candidate, kind, prompt, intent),
      scope,
      slots,
      style_axes: kind === 'brand' || kind === 'team' || kind === 'item_line' ? [] : recoveredStyleAxes(intent),
      silhouette_terms: kind === 'brand' || kind === 'team' || kind === 'item_line' ? [] : recoveredSilhouetteTerms(intent),
      palette_terms: kind === 'brand' || kind === 'team' || kind === 'item_line' ? [] : recoveredPaletteTerms(intent),
      category_preferences: slots.length ? slots : intent.semantic_directives.category_preferences.length ? intent.semantic_directives.category_preferences : intent.requested_slots,
      soft_brand_priors: kind === 'brand' ? [] : uniqNormalized([...intent.brand_focus, ...intent.specific_items]),
      gender_signal: intent.target_gender === 'any' ? fallbackGender : intent.target_gender,
    }, fallbackGender);
    if (!subject) continue;
    const key = `${subject.kind}::${subject.label}`;
    if (recovered.some((entry) => `${entry.kind}::${entry.label}` === key)) continue;
    recovered.push(subject);
  }
  return recovered;
}

function promptRequestedSlots(intent: PromptIntent): CategoryMain[] {
  return uniq([...intent.required_categories, ...intent.optional_categories]);
}

function positiveConstraintSlots(intent: PromptIntentV2): CategoryMain[] {
  return (['top', 'bottom', 'shoes', 'mono'] as CategoryMain[]).filter((slot) => {
    const constraint = intent.slot_constraints?.[slot];
    return !!(
      constraint?.preferred_subs?.length ||
      constraint?.required_keywords?.length ||
      constraint?.preferred_entities?.length ||
      constraint?.colour_hints?.length ||
      constraint?.fit_hints?.length ||
      constraint?.vibe_hints?.length ||
      constraint?.occasion_hints?.length
    );
  });
}

function collapseImplicitSingleSlotSubjectFocus(prompt: string, intent: PromptIntentV2): PromptIntentV2 {
  const norm = normalizeText(prompt);
  if (!norm) return intent;

  const requestedSlots = intent.requested_slots.length ? intent.requested_slots : promptRequestedSlots(intent);
  if (requestedSlots.length <= 1) return intent;
  if (/\b(outfit|fit|look|style|aesthetic|vibe|wardrobe)\b/.test(norm)) return intent;
  if (/\b(and|plus)\b|,|&/.test(norm)) return intent;
  if (slotTerms(prompt).length) return intent;

  const subjectSlots = uniq([
    ...((Array.isArray(intent.semantic_subjects) ? intent.semantic_subjects : [])
      .filter((subject) =>
        !!subject &&
        Array.isArray(subject.slots) &&
        subject.slots.length &&
        (subject.scope === 'slot' || subject.scope === 'mixed')
      )
      .flatMap((subject) => subject.slots)),
    ...Object.values(intent.subject_slots || {}).flatMap((slots) => Array.isArray(slots) ? slots : []),
  ]).filter((slot): slot is CategoryMain => slot === 'top' || slot === 'bottom' || slot === 'shoes' || slot === 'mono');

  if (subjectSlots.length !== 1) return intent;

  const focusSlot = subjectSlots[0];
  if (!requestedSlots.includes(focusSlot)) return intent;

  const nonFocusPositiveSlots = positiveConstraintSlots(intent).filter((slot) => slot !== focusSlot);
  if (nonFocusPositiveSlots.length) return intent;

  return {
    ...intent,
    outfit_mode: 'single',
    requested_form: deriveRequestedForm([focusSlot], []),
    required_categories: [focusSlot],
    optional_categories: [],
    requested_slots: [focusSlot],
    assembly_mode: 'single_item',
    mono_requirement: focusSlot === 'mono' ? 'required' : 'none',
    shoe_requirement: focusSlot === 'shoes' ? 'required' : 'none',
  };
}

function promptAssemblyMode(intent: PromptIntent): AssemblyMode {
  const requiredCount = intent.required_categories.length;
  if (intent.outfit_mode === 'single' || requiredCount <= 1) return 'single_item';
  if (requiredCount >= 3) return 'full_outfit';
  return 'partial_outfit';
}

function inferStyleSubjects(intent: PromptIntent, semanticSubjects: SemanticSubject[]): StyleSubjectKind[] {
  const subjects: StyleSubjectKind[] = [];
  for (const subject of semanticSubjects) subjects.push(subject.kind);
  if (intent.brand_focus.length) subjects.push('brand');
  if (intent.team_focus.length) subjects.push('team');
  if (intent.specific_items.length) subjects.push('item_line');
  return subjects.length ? uniq(subjects) : ['none'];
}

function inferSubjectSlots(intent: PromptIntent, subjects: StyleSubjectKind[], semanticSubjects: SemanticSubject[], rawSlots?: SlotMap | null): SlotMap {
  const out: SlotMap = {};
  if (rawSlots) {
    for (const [key, value] of Object.entries(rawSlots)) {
      if (key === 'none') continue;
      const slots = validSlots(value);
      if (slots.length) out[key as Exclude<StyleSubjectKind, 'none'>] = slots;
    }
  }
  if (Object.keys(out).length) return out;
  for (const subject of semanticSubjects) {
    if (!subject.slots.length) continue;
    const key = subject.kind as Exclude<StyleSubjectKind, 'none'>;
    out[key] = uniq([...(out[key] || []), ...subject.slots]);
  }
  if (Object.keys(out).length) return out;
  const requested = promptRequestedSlots(intent);
  if (requested.length === 1 && subjects.includes('persona')) {
    out.persona = requested;
  }
  if (requested.length === 1 && subjects.includes('style_archetype')) {
    out.style_archetype = requested;
  }
  if (requested.length === 1 && subjects.includes('brand')) {
    out.brand = requested;
  }
  if (requested.length === 1 && subjects.includes('team')) {
    out.team = requested;
  }
  if (requested.length === 1 && subjects.includes('item_line')) {
    out.item_line = requested;
  }
  if (requested.length === 1 && subjects.includes('theme')) {
    out.theme = requested;
  }
  return out;
}

function inferSubjectScope(subjectSlots: SlotMap, subjects: StyleSubjectKind[], intent: PromptIntent, semanticSubjects: SemanticSubject[]): SubjectScope {
  if (semanticSubjects.length) {
    const scopes = uniq(semanticSubjects.map((subject) => subject.scope));
    if (scopes.includes('mixed')) return 'mixed';
    if (scopes.includes('global') && scopes.includes('slot')) return 'mixed';
    if (scopes.length === 1 && scopes[0]) return scopes[0];
  }
  const slotBindings = Object.values(subjectSlots).filter((value) => Array.isArray(value) && value.length).length;
  if (!subjects.length || (subjects.length === 1 && subjects[0] === 'none')) return promptRequestedSlots(intent).length <= 1 ? 'slot' : 'global';
  if (!slotBindings) return 'global';
  if (slotBindings === 1 && promptRequestedSlots(intent).length <= 1) return 'slot';
  return 'mixed';
}

function normalizeGenderSignal(raw: any, fallbackGender: Gender | 'any'): Gender | 'any' | null {
  const genderSignalNorm = normalizeText(raw || '');
  if (genderSignalNorm === 'men' || genderSignalNorm === 'women' || genderSignalNorm === 'unisex' || genderSignalNorm === 'any') {
    return genderSignalNorm;
  }
  return fallbackGender === 'any' ? null : fallbackGender;
}

function sanitizeSemanticSubject(raw: any, fallbackGender: Gender | 'any'): SemanticSubject | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind = validSemanticSubjectKind(raw.kind);
  if (!kind) return null;
  const label = String(raw.label || raw.name || '').trim();
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence || 0)));
  const scope = validScope(raw.scope) || validScope(raw.subject_scope) || (validSlots(raw.slots).length ? 'slot' : 'global');
  const slots = validSlots(raw.slots || raw.subject_slots);
  const style_axes = uniqNormalized(Array.isArray(raw.style_axes) ? raw.style_axes : []);
  const silhouette_terms = uniqNormalized(Array.isArray(raw.silhouette_terms) ? raw.silhouette_terms : []);
  const palette_terms = uniqNormalized(Array.isArray(raw.palette_terms) ? raw.palette_terms : []);
  const category_preferences = validSlots(raw.category_preferences);
  const soft_brand_priors = uniqNormalized(Array.isArray(raw.soft_brand_priors) ? raw.soft_brand_priors : []);
  const gender_signal = normalizeGenderSignal(raw.gender_signal, fallbackGender);
  if (!label && !style_axes.length && !silhouette_terms.length && !palette_terms.length && !category_preferences.length && !soft_brand_priors.length) {
    return null;
  }
  return {
    kind,
    label,
    confidence,
    scope: scope || 'global',
    slots,
    style_axes,
    silhouette_terms,
    palette_terms,
    category_preferences,
    soft_brand_priors,
    gender_signal,
  };
}

function sanitizeSemanticSubjects(raw: any, fallbackGender: Gender | 'any'): SemanticSubject[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => sanitizeSemanticSubject(entry, fallbackGender))
    .filter((entry): entry is SemanticSubject => !!entry && entry.confidence >= 0.4);
}

function legacyPersonaSubject(raw: any, fallbackGender: Gender | 'any'): SemanticSubject[] {
  if (!raw || typeof raw !== 'object') return [];
  const subject = sanitizeSemanticSubject({
    ...raw,
    kind: 'persona',
    label: raw.name || raw.label || '',
  }, fallbackGender);
  return subject && subject.confidence >= 0.4 ? [subject] : [];
}

function derivePersonaProfile(subjects: SemanticSubject[], fallbackGender: Gender | 'any'): PersonaProfile | null {
  const personaSubjects = subjects.filter((subject) => subject.kind === 'persona');
  if (!personaSubjects.length) return null;
  const primary = [...personaSubjects].sort((left, right) => right.confidence - left.confidence)[0];
  return {
    name: primary.label || null,
    confidence: primary.confidence,
    style_axes: uniq(personaSubjects.flatMap((subject) => subject.style_axes)),
    silhouette_terms: uniq(personaSubjects.flatMap((subject) => subject.silhouette_terms)),
    palette_terms: uniq(personaSubjects.flatMap((subject) => subject.palette_terms)),
    category_preferences: uniq(personaSubjects.flatMap((subject) => subject.category_preferences)),
    soft_brand_priors: uniq(personaSubjects.flatMap((subject) => subject.soft_brand_priors)),
    gender_signal: primary.gender_signal ?? (fallbackGender === 'any' ? null : fallbackGender),
  };
}

function semanticDirectivesFromSubjects(subjects: SemanticSubject[]): SemanticDirectives {
  return {
    style_axes: uniq(subjects.flatMap((subject) => subject.style_axes)),
    silhouette_terms: uniq(subjects.flatMap((subject) => subject.silhouette_terms)),
    palette_terms: uniq(subjects.flatMap((subject) => subject.palette_terms)),
    category_preferences: uniq(subjects.flatMap((subject) => subject.category_preferences)),
  };
}

function explicitSettings(norm: string): SettingContext[] {
  const settings: SettingContext[] = [];
  if (/\b(beach|seaside|coast|coastal)\b/.test(norm)) settings.push('beach');
  if (/\b(resort|vacation|holiday|getaway|monaco)\b/.test(norm)) settings.push('resort');
  if (/\b(nightlife|club|party|going out)\b/.test(norm)) settings.push('nightlife');
  if (/\b(office|work|corporate|meeting)\b/.test(norm)) settings.push('office');
  if (/\b(home|indoors)\b/.test(norm)) settings.push('home');
  if (/\b(airport|flight|travel|travelling|traveling)\b/.test(norm)) settings.push('travel');
  if (/\b(university|college|campus|study)\b/.test(norm)) settings.push('campus');
  if (/\b(wedding|gala|formal event|black tie|cocktail)\b/.test(norm)) settings.push('formal_event');
  return uniq(settings);
}

function explicitActivities(norm: string): ActivityContext[] {
  const activities: ActivityContext[] = [];
  if (/\b(sleep|bedtime|nightwear|nightgown)\b/.test(norm)) activities.push('sleep');
  if (/\b(lounge|loungewear|cozy|comfy)\b/.test(norm)) activities.push('lounge');
  if (/\b(beach|seaside|coast|coastal)\b/.test(norm)) activities.push('beach');
  if (/\b(football|soccer|basketball|running|tennis|gym|workout|training)\b/.test(norm)) activities.push('sport');
  if (/\b(party|club|nightlife)\b/.test(norm)) activities.push('party');
  if (/\b(dinner|date night)\b/.test(norm)) activities.push('dinner');
  if (/\b(airport|flight|travel|travelling|traveling)\b/.test(norm)) activities.push('travel');
  if (/\b(work|office|meeting|corporate)\b/.test(norm)) activities.push('work');
  if (/\b(university|college|campus|study)\b/.test(norm)) activities.push('study');
  return uniq(activities);
}

function explicitDayparts(norm: string): DaypartContext[] {
  const dayparts: DaypartContext[] = [];
  if (/\b(bedtime|sleep|nightwear|nightgown)\b/.test(norm)) dayparts.push('bedtime');
  else if (/\b(night|evening|nightlife|date night)\b/.test(norm)) dayparts.push('night');
  else if (/\b(day|daytime|morning|afternoon)\b/.test(norm)) dayparts.push('day');
  return uniq(dayparts);
}

function explicitVibes(norm: string): Vibe[] {
  return normalizeVibes([
    /\bstreetwear|street\b/.test(norm) ? 'streetwear' : '',
    /\bold money|preppy|ivy|university|college|campus|smart casual\b/.test(norm) ? 'preppy' : '',
    /\bformal|fancy|dressy|date night|dinner|evening\b/.test(norm) ? 'formal' : '',
    /\bchic|classy|elegant\b/.test(norm) ? 'chic' : '',
    /\bminimal|neutral|clean basics?\b/.test(norm) ? 'minimal' : '',
    /\bsporty|athletic\b/.test(norm) ? 'sporty' : '',
    /\bcomfy|cozy|pajama|lounge\b/.test(norm) ? 'comfy' : '',
    /\bedgy\b/.test(norm) ? 'edgy' : '',
    /\by2k\b/.test(norm) ? 'y2k' : '',
    /\btechwear\b/.test(norm) ? 'techwear' : '',
  ]);
}

function explicitOccasions(norm: string): OccasionTag[] {
  return normalizeOccasionTags([
    /\bsmart casual|old money|preppy|university|college|campus\b/.test(norm) ? 'smart casual' : '',
    /\bformal|fancy|black tie|suit\b/.test(norm) ? 'formal' : '',
    /\bdate night|dinner|evening|cocktail\b/.test(norm) ? 'evening' : '',
    /\blounge|loungewear|comfy|cozy\b/.test(norm) ? 'lounge' : '',
    /\bpajama|sleepwear|nightgown|nightwear\b/.test(norm) ? 'sleepwear' : '',
  ]);
}

function refreshHeuristicSemantics(prompt: string, intent: PromptIntent, genderPref: Gender | 'any'): PromptIntent {
  const norm = normalizeText(prompt);
  const refreshed: PromptIntent = {
    ...intent,
    persona_terms: [],
    vibe_tags: explicitVibes(norm),
    occasion_tags: explicitOccasions(norm),
    setting_context: explicitSettings(norm),
    activity_context: explicitActivities(norm),
    daypart_context: explicitDayparts(norm),
  };
  if (refreshed.target_gender === 'any' && genderPref !== 'any') refreshed.target_gender = genderPref;
  return refreshed;
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

function extractJsonPayload(text: string): any | null {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

function isRetryableGeminiError(error: unknown): boolean {
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

async function enforceGeminiRateLimit(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const now = Date.now();
  const waitMs = Math.max(0, LAST_GEMINI_REQUEST_AT + minIntervalMs - now);
  if (waitMs > 0) await sleep(waitMs);
  LAST_GEMINI_REQUEST_AT = Date.now();
}

function setGoogleCredentialsIfAvailable(debug: boolean): void {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    for (const name of SERVICE_ACCOUNT_CANDIDATES) {
      const candidate = fs.existsSync(name) ? name : `${process.cwd()}/${name}`;
      if (fs.existsSync(candidate)) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = candidate;
        if (debug) console.error('[DEBUG]', 'embedding_v2 using service account', candidate);
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
      // ignore invalid credential file here; Vertex will surface auth failure later
    }
  }
}

function resolveProject(override?: string | null): string | null {
  return override?.trim() || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || null;
}

export class PromptParser {
  private readonly baseParser = new BasePromptParser();

  private sanitizeV2IntentWithMeta(
    raw: any,
    fallback: PromptIntent,
    genderPref: Gender | 'any',
    prompt: string,
    allowRecovery: boolean,
  ): { intent: PromptIntentV2; meta: SanitizedIntentMeta } {
    let structural = this.baseParser.sanitizeIntent(raw || {});
    structural.brand_focus = cleanFocusTerms(structural.brand_focus || []);
    structural.team_focus = cleanFocusTerms(structural.team_focus || []);
    structural.specific_items = cleanFocusTerms(structural.specific_items || []);
    for (const slot of ['top', 'bottom', 'shoes', 'mono'] as CategoryMain[]) {
      const constraint = structural.slot_constraints?.[slot];
      if (!constraint) continue;
      constraint.required_keywords = stripClauseLikeKeywords(constraint.required_keywords || []);
      constraint.preferred_entities = stripClauseLikeEntities(constraint.preferred_entities || []);
      constraint.excluded_entities = stripClauseLikeEntities(constraint.excluded_entities || []);
    }
    if (structural.negative_constraints?.non_sport) {
      structural.sport_context = 'none';
      structural.activity_context = (structural.activity_context || []).filter((entry) => entry !== 'sport');
      structural.team_focus = stripSportPositiveTerms(structural.team_focus || []);
      structural.specific_items = stripSportPositiveTerms(structural.specific_items || []);
      for (const slot of ['top', 'bottom', 'shoes', 'mono'] as CategoryMain[]) {
        const constraint = structural.slot_constraints?.[slot];
        if (!constraint) continue;
        constraint.required_keywords = stripSportPositiveTerms(constraint.required_keywords || []);
        constraint.preferred_entities = stripSportPositiveTerms(constraint.preferred_entities || []);
      }
    }
    let requested_slots = validSlots(raw?.requested_slots);
    let subjectSource: SemanticSubjectSource = 'none';
    let semantic_subjects = (() => {
      const explicit = sanitizeSemanticSubjects(raw?.semantic_subjects, genderPref);
      if (explicit.length) {
        subjectSource = 'gemini';
        return explicit;
      }
      const legacy = legacyPersonaSubject(raw?.persona_profile, genderPref);
      if (legacy.length) subjectSource = 'legacy_persona';
      return legacy;
    })();
    let suppressRawMonoRequirement = false;
    ({
      structural,
      semanticSubjects: semantic_subjects,
      requestedSlots: requested_slots,
      suppressRawMonoRequirement,
    } = normalizeImplicitMonoExpansion(
      prompt,
      structural,
      fallback,
      semantic_subjects,
      requested_slots,
    ));
    const style_subjects = validStyleSubjects(raw?.style_subjects);
    const rawSlotMap = raw?.subject_slots && typeof raw.subject_slots === 'object' ? raw.subject_slots as SlotMap : null;
    const paletteMode = normalizeText(raw?.palette_mode || '');
    const paletteOverride = normalizeText(raw?.palette_override_strength || '');
    const monoRequirement = normalizeText(raw?.mono_requirement || '');
    const shoeRequirement = normalizeText(raw?.shoe_requirement || '');
    const assembly_mode = normalizeText(raw?.assembly_mode || '') as AssemblyMode;

    let scaffoldIntent: PromptIntentV2 = {
      ...fallback,
      ...structural,
      persona_terms: [],
      semantic_subjects,
      requested_slots: requested_slots.length ? requested_slots : promptRequestedSlots(structural),
      assembly_mode:
        assembly_mode === 'single_item' || assembly_mode === 'partial_outfit' || assembly_mode === 'full_outfit'
          ? assembly_mode
          : promptAssemblyMode(structural),
      brand_fit_mode: 'none',
      style_subjects: style_subjects.length ? style_subjects : inferStyleSubjects(structural, semantic_subjects),
      subject_scope: validScope(raw?.subject_scope) || inferSubjectScope({}, style_subjects.length ? style_subjects : inferStyleSubjects(structural, semantic_subjects), structural, semantic_subjects),
      subject_slots: {},
      persona_profile: derivePersonaProfile(semantic_subjects, genderPref),
      semantic_directives: semanticDirectivesFromSubjects(semantic_subjects),
      setting_context: validSettings(raw?.setting_context).length ? validSettings(raw?.setting_context) : structural.setting_context,
      activity_context: validActivities(raw?.activity_context).length ? validActivities(raw?.activity_context) : structural.activity_context,
      daypart_context: validDayparts(raw?.daypart_context).length ? validDayparts(raw?.daypart_context) : structural.daypart_context,
      palette_mode: ALLOWED_PALETTE_MODES.has(paletteMode as PaletteMode) ? paletteMode as PaletteMode : structural.palette_mode,
      global_palette_colours: validColours(raw?.global_palette_colours).length ? validColours(raw?.global_palette_colours) : structural.global_palette_colours,
      palette_override_strength:
        ALLOWED_OVERRIDE_STRENGTHS.has(paletteOverride as PaletteOverrideStrength)
          ? paletteOverride as PaletteOverrideStrength
          : structural.palette_override_strength,
      mono_requirement:
        !suppressRawMonoRequirement && ALLOWED_REQUIREMENT_MODES.has(monoRequirement as RequirementMode)
          ? monoRequirement as RequirementMode
          : structural.mono_requirement,
      shoe_requirement:
        ALLOWED_REQUIREMENT_MODES.has(shoeRequirement as RequirementMode)
          ? shoeRequirement as RequirementMode
          : structural.shoe_requirement,
    };

    let recoveredSubjects: SemanticSubject[] = [];
    if (allowRecovery && !semantic_subjects.length) {
      recoveredSubjects = recoverSemanticSubjects(prompt, scaffoldIntent, genderPref);
      if (recoveredSubjects.length) {
        semantic_subjects = recoveredSubjects;
        subjectSource = 'recovered';
      }
    }

    const persona_profile = derivePersonaProfile(semantic_subjects, genderPref);
    const derivedStyleSubjects = semantic_subjects.length ? inferStyleSubjects(structural, semantic_subjects) : (style_subjects.length ? style_subjects : inferStyleSubjects(structural, []));
    const subject_slots = inferSubjectSlots(structural, derivedStyleSubjects, semantic_subjects, rawSlotMap);
    const subject_scope = validScope(raw?.subject_scope) || inferSubjectScope(subject_slots, derivedStyleSubjects, structural, semantic_subjects);
    const semantic_directives = semanticDirectivesFromSubjects(semantic_subjects);

    structural.persona_terms = [];
    if (persona_profile?.gender_signal && structural.target_gender === 'any' && persona_profile.gender_signal !== 'any') {
      structural.target_gender = persona_profile.gender_signal;
    }

    const intent: PromptIntentV2 = {
      ...fallback,
      ...structural,
      persona_terms: [],
      semantic_subjects,
      requested_slots: requested_slots.length ? requested_slots : promptRequestedSlots(structural),
      assembly_mode:
        assembly_mode === 'single_item' || assembly_mode === 'partial_outfit' || assembly_mode === 'full_outfit'
          ? assembly_mode
          : promptAssemblyMode(structural),
      brand_fit_mode: 'none',
      style_subjects: derivedStyleSubjects.length ? derivedStyleSubjects : ['none'],
      subject_scope,
      subject_slots,
      persona_profile,
      semantic_directives,
      setting_context: validSettings(raw?.setting_context).length ? validSettings(raw?.setting_context) : structural.setting_context,
      activity_context: validActivities(raw?.activity_context).length ? validActivities(raw?.activity_context) : structural.activity_context,
      daypart_context: validDayparts(raw?.daypart_context).length ? validDayparts(raw?.daypart_context) : structural.daypart_context,
      palette_mode: ALLOWED_PALETTE_MODES.has(paletteMode as PaletteMode) ? paletteMode as PaletteMode : structural.palette_mode,
      global_palette_colours: validColours(raw?.global_palette_colours).length ? validColours(raw?.global_palette_colours) : structural.global_palette_colours,
      palette_override_strength:
        ALLOWED_OVERRIDE_STRENGTHS.has(paletteOverride as PaletteOverrideStrength)
          ? paletteOverride as PaletteOverrideStrength
          : structural.palette_override_strength,
      mono_requirement:
        !suppressRawMonoRequirement && ALLOWED_REQUIREMENT_MODES.has(monoRequirement as RequirementMode)
          ? monoRequirement as RequirementMode
          : structural.mono_requirement,
      shoe_requirement:
        ALLOWED_REQUIREMENT_MODES.has(shoeRequirement as RequirementMode)
          ? shoeRequirement as RequirementMode
          : structural.shoe_requirement,
    };

    if (intent.negative_constraints.non_sport) {
      intent.sport_context = 'none';
      intent.activity_context = intent.activity_context.filter((entry) => entry !== 'sport');
    }

    if (!intent.style_subjects.length) intent.style_subjects = ['none'];
    return {
      intent,
      meta: {
        subjectSource,
        recoveredSubjects,
      },
    };
  }

  private sanitizeV2Intent(
    raw: any,
    fallback: PromptIntent,
    genderPref: Gender | 'any',
    prompt: string,
    allowRecovery = false,
  ): PromptIntentV2 {
    return this.sanitizeV2IntentWithMeta(raw, fallback, genderPref, prompt, allowRecovery).intent;
  }

  private mergeGeminiFirst(geminiIntent: PromptIntentV2, heuristicIntent: PromptIntentV2): PromptIntentV2 {
    const merged = this.baseParser.mergeIntents(geminiIntent, heuristicIntent) as PromptIntentV2;
    merged.persona_terms = [];
    merged.vibe_tags = uniq([...(geminiIntent.vibe_tags || []), ...(heuristicIntent.vibe_tags || [])]);
    merged.occasion_tags = uniq([...(geminiIntent.occasion_tags || []), ...(heuristicIntent.occasion_tags || [])]);
    merged.setting_context = uniq([...(geminiIntent.setting_context || []), ...(heuristicIntent.setting_context || [])]);
    merged.activity_context = uniq([...(geminiIntent.activity_context || []), ...(heuristicIntent.activity_context || [])]);
    merged.daypart_context = uniq([...(geminiIntent.daypart_context || []), ...(heuristicIntent.daypart_context || [])]);
    merged.palette_mode = geminiIntent.palette_mode !== 'unconstrained' ? geminiIntent.palette_mode : heuristicIntent.palette_mode;
    merged.global_palette_colours = uniq([...(geminiIntent.global_palette_colours || []), ...(heuristicIntent.global_palette_colours || [])]);
    merged.palette_override_strength = geminiIntent.palette_override_strength !== 'none'
      ? geminiIntent.palette_override_strength
      : heuristicIntent.palette_override_strength;
    merged.fit_preference = geminiIntent.fit_preference || heuristicIntent.fit_preference;
    merged.sport_context = geminiIntent.sport_context !== 'none' ? geminiIntent.sport_context : heuristicIntent.sport_context;
    merged.brand_focus = uniq([...geminiIntent.brand_focus, ...heuristicIntent.brand_focus]);
    merged.team_focus = uniq([...geminiIntent.team_focus, ...heuristicIntent.team_focus]);
    merged.specific_items = uniq([...geminiIntent.specific_items, ...heuristicIntent.specific_items]);
    merged.requested_slots = uniq([...(geminiIntent.requested_slots || []), ...(heuristicIntent.requested_slots || [])]);
    merged.assembly_mode = geminiIntent.assembly_mode || heuristicIntent.assembly_mode;
    merged.brand_fit_mode = geminiIntent.brand_fit_mode !== 'none' ? geminiIntent.brand_fit_mode : heuristicIntent.brand_fit_mode;
    merged.semantic_subjects = mergeSemanticSubjects(geminiIntent.semantic_subjects || [], heuristicIntent.semantic_subjects || []);
    merged.style_subjects = uniq([
      ...(geminiIntent.style_subjects[0] !== 'none' ? geminiIntent.style_subjects : []),
      ...(heuristicIntent.style_subjects[0] !== 'none' ? heuristicIntent.style_subjects : []),
    ]) as StyleSubjectKind[];
    if (!merged.style_subjects.length) merged.style_subjects = ['none'];
    merged.subject_scope = geminiIntent.subject_scope || heuristicIntent.subject_scope;
    merged.subject_slots = Object.keys(geminiIntent.subject_slots || {}).length ? geminiIntent.subject_slots : heuristicIntent.subject_slots;
    merged.persona_profile = derivePersonaProfile(merged.semantic_subjects, merged.target_gender);
    merged.semantic_directives = {
      style_axes: uniqStructuredStrings([...(geminiIntent.semantic_directives?.style_axes || []), ...(heuristicIntent.semantic_directives?.style_axes || [])]),
      silhouette_terms: uniqStructuredStrings([...(geminiIntent.semantic_directives?.silhouette_terms || []), ...(heuristicIntent.semantic_directives?.silhouette_terms || [])]),
      palette_terms: uniqStructuredStrings([...(geminiIntent.semantic_directives?.palette_terms || []), ...(heuristicIntent.semantic_directives?.palette_terms || [])]),
      category_preferences: uniq([...(geminiIntent.semantic_directives?.category_preferences || []), ...(heuristicIntent.semantic_directives?.category_preferences || [])]),
    };
    if (geminiIntent.target_gender !== 'any') merged.target_gender = geminiIntent.target_gender;
    return enforceExplicitPaletteLocks(merged);
  }

  private async geminiIntentV2(
    prompt: string,
    genderPref: Gender | 'any',
    project: string | null,
    location: string,
    model: string,
    timeoutMs: number,
    benchmarkRateLimitMs: number,
    debug: boolean,
  ): Promise<{ payload: any | null; reason: string | null; source: 'live'; retryCount: number }> {
    if (!project) return { payload: null, reason: 'project_missing', source: 'live', retryCount: 0 };
    try {
      const systemPrompt = `
You are a semantic fashion intent parser for an outfit recommender.
Return one JSON object only.

Schema:
{
  "outfit_mode": "outfit" | "single",
  "requested_form": "top_bottom_shoes" | "top_bottom" | "top_shoes" | "bottom_shoes" | "mono_only" | "mono_and_shoes" | "top_only" | "bottom_only" | "shoes_only",
  "required_categories": ["top" | "bottom" | "shoes" | "mono"],
  "optional_categories": ["top" | "bottom" | "shoes" | "mono"],
  "target_gender": "men" | "women" | "unisex" | "any",
  "vibe_tags": [string],
  "occasion_tags": [string],
  "colour_hints": ["black" | "white" | "grey" | "red" | "blue" | "green" | "beige" | "brown" | "pink" | "orange" | "yellow" | "purple"],
  "brand_focus": [string],
  "team_focus": [string],
  "sport_context": string,
  "fit_preference": "oversized" | "regular" | "slim" | "cropped" | "mixed" | null,
  "specific_items": [string],
  "setting_context": [string],
  "activity_context": [string],
  "daypart_context": [string],
  "palette_mode": "unconstrained" | "monochrome" | "tonal" | "colorful" | "muted",
  "global_palette_colours": ["black" | "white" | "grey" | "red" | "blue" | "green" | "beige" | "brown" | "pink" | "orange" | "yellow" | "purple"],
  "slot_palette_locked": {"top": boolean, "bottom": boolean, "shoes": boolean, "mono": boolean},
  "palette_override_strength": "none" | "soft" | "hard",
  "mono_requirement": "none" | "optional" | "required",
  "shoe_requirement": "none" | "optional" | "required",
  "slot_constraints": {
    "top": {"preferred_subs":[string],"required_keywords":[string],"preferred_entities":[string],"colour_hints":[string],"fit_hints":[string],"vibe_hints":[string],"occasion_hints":[string],"excluded_keywords":[string],"excluded_subs":[string],"excluded_entities":[string],"excluded_colours":[string]},
    "bottom": {"preferred_subs":[string],"required_keywords":[string],"preferred_entities":[string],"colour_hints":[string],"fit_hints":[string],"vibe_hints":[string],"occasion_hints":[string],"excluded_keywords":[string],"excluded_subs":[string],"excluded_entities":[string],"excluded_colours":[string]},
    "shoes": {"preferred_subs":[string],"required_keywords":[string],"preferred_entities":[string],"colour_hints":[string],"fit_hints":[string],"vibe_hints":[string],"occasion_hints":[string],"excluded_keywords":[string],"excluded_subs":[string],"excluded_entities":[string],"excluded_colours":[string]},
    "mono": {"preferred_subs":[string],"required_keywords":[string],"preferred_entities":[string],"colour_hints":[string],"fit_hints":[string],"vibe_hints":[string],"occasion_hints":[string],"excluded_keywords":[string],"excluded_subs":[string],"excluded_entities":[string],"excluded_colours":[string]}
  },
  "negative_constraints": {
    "excluded_categories": ["top" | "bottom" | "shoes" | "mono"],
    "excluded_keywords": [string],
    "excluded_subs": [string],
    "excluded_brands": [string],
    "excluded_teams": [string],
    "non_sport": boolean,
    "no_logos": boolean
  },
  "requested_slots": ["top" | "bottom" | "shoes" | "mono"],
  "assembly_mode": "single_item" | "partial_outfit" | "full_outfit",
  "semantic_subjects": [
    {
      "kind": "persona" | "style_archetype" | "brand" | "team" | "item_line" | "theme",
      "label": string,
      "confidence": number,
      "scope": "global" | "slot" | "mixed",
      "slots": ["top" | "bottom" | "shoes" | "mono"],
      "style_axes": [string],
      "silhouette_terms": [string],
      "palette_terms": [string],
      "category_preferences": ["top" | "bottom" | "shoes" | "mono"],
      "soft_brand_priors": [string],
      "gender_signal": "men" | "women" | "unisex" | "any" | null
    }
  ]
}

Rules:
- Use Gemini to decide whether the prompt is a single item request, partial outfit, or full outfit.
- Use semantic_subjects to describe all semantic references in the prompt.
- "persona" is only for actual people, public figures, fictional characters, or person-like identities.
- "style_archetype" is for aesthetics and style labels such as old money, quiet luxury, minimal, streetwear, business casual, y2k, goth, preppy.
- "brand" is for brands, "team" is for sports teams, "item_line" is for product lines or named item families, and "theme" is for non-person thematic ideas that are not brands or teams.
- Persona and style handling must be style-first: silhouette, palette, category lean, and style axes are more important than brands.
- For persona subjects, infer broad publicly associated style signals when reasonably knowable. Do not leave persona styling empty if a safe broad read is available.
- For persona subjects, try to fill style_axes, silhouette_terms, palette_terms, category_preferences, and gender_signal. Use broad conservative descriptors if uncertain.
- soft_brand_priors must stay soft and short. Use at most 3 weak associated brands only when they are strongly relevant to the persona's public style.
- Keep explicit colours, exact items, categories, and negatives attached to the correct slot.
- If a semantic subject applies only to one slot, set scope to slot and fill slots accordingly.
- If a prompt contains both a subject and a structural item request, keep them separate. Example: "Playboi Carti type shirt" is a slot-scoped persona subject plus a top request.
- Do not classify abstract aesthetics like "old money" as persona.
- Return JSON only.
`.trim();

      const maxRetries = 4;
      const baseDelayMs = 1500;
      let attempt = 0;
      while (true) {
        try {
          await enforceGeminiRateLimit(Math.max(0, Number(benchmarkRateLimitMs) || 0));
          const ai = createGoogleGenAIClient(project, location);
          const result = await withTimeout(
            ai.models.generateContent({
              model,
              contents: `Prompt: "${prompt}"\nGender hint: "${genderPref}"`,
              config: {
                systemInstruction: systemPrompt,
                responseMimeType: 'application/json',
                temperature: 0,
              },
            }),
            timeoutMs,
            'gemini_v2_intent',
          );

          const text = String((result as any)?.text || '').trim();
          const payload = extractJsonPayload(text);
          return {
            payload,
            reason: payload ? null : 'gemini_empty',
            source: 'live',
            retryCount: attempt,
          };
        } catch (error) {
          if (attempt >= maxRetries || !isRetryableGeminiError(error)) throw error;
          const delayMs = baseDelayMs * Math.max(1, 2 ** attempt) + Math.round(Math.random() * 250);
          if (debug) console.error('[DEBUG]', 'embedding_v2 gemini parse retry', attempt + 1, 'delay_ms', delayMs);
          await sleep(delayMs);
          attempt += 1;
        }
      }
    } catch (error) {
      if (debug) console.error('[DEBUG]', 'embedding_v2 gemini parse failed', error);
      return {
        payload: null,
        reason: String((error as Error)?.message || 'gemini_failed'),
        source: 'live',
        retryCount: 0,
      };
    }
  }

  public async resolveIntent(
    request: RecommendationRequest,
    corpusStats: SemanticCorpusStats,
  ): Promise<{ intent: PromptIntentV2; geminiState: GeminiIntentState; parserSource: ParserSource }> {
    setGoogleCredentialsIfAvailable(request.debug);
    const heuristicBase = this.baseParser.sanitizeIntent(this.baseParser.heuristicIntent(request.prompt, request.genderPref));
    const refreshedHeuristic = this.baseParser.sanitizeIntent(
      refreshHeuristicSemantics(request.prompt, heuristicBase, request.genderPref),
    );
    this.baseParser.parseNegatives(refreshedHeuristic, request.prompt, corpusStats);
    const heuristicIntent = this.sanitizeV2Intent(refreshedHeuristic, refreshedHeuristic, request.genderPref, request.prompt, false);
    const heuristicRecoveredIntent = this.sanitizeV2Intent(refreshedHeuristic, refreshedHeuristic, request.genderPref, request.prompt, true);

    if (request.intentJsonInPath) {
      const raw = JSON.parse(fs.readFileSync(request.intentJsonInPath, 'utf8'));
      const intent = this.sanitizeV2Intent(raw, refreshedHeuristic, request.genderPref, request.prompt, true);
      this.baseParser.parseNegatives(intent, request.prompt, corpusStats);
      return {
        intent: this.sanitizeV2Intent(intent, refreshedHeuristic, request.genderPref, request.prompt, false),
        geminiState: {
          active: false,
          reason: 'intent_json',
          intent: null,
          source: 'intent_json',
          cacheHit: false,
          retryCount: 0,
          model: request.model,
          location: request.location,
          semanticSubjectSource: 'none',
          recoveredSubjectKinds: [],
          recoveredSubjectConfidenceSummary: null,
        },
        parserSource: 'intent_json',
      };
    }

    const resolvedProject = resolveProject(request.project);

    if (request.parserMode === 'heuristic') {
      const boosted = applyPromptSemanticMappings(request.prompt, heuristicIntent, request.genderPref);
      return {
        intent: boosted,
        geminiState: {
          active: false,
          reason: 'parser_mode_heuristic',
          intent: null,
          source: 'heuristic',
          cacheHit: false,
          retryCount: 0,
          model: request.model,
          location: request.location,
          semanticSubjectSource: 'none',
          recoveredSubjectKinds: [],
          recoveredSubjectConfidenceSummary: null,
        },
        parserSource: 'heuristic',
      };
    }

    if (!resolvedProject) {
      const boosted = applyPromptSemanticMappings(request.prompt, heuristicRecoveredIntent, request.genderPref);
      return {
        intent: boosted,
        geminiState: {
          active: false,
          reason: 'project_missing',
          intent: null,
          source: 'missing',
          cacheHit: false,
          retryCount: 0,
          model: request.model,
          location: request.location,
          semanticSubjectSource: 'none',
          recoveredSubjectKinds: [],
          recoveredSubjectConfidenceSummary: null,
        },
        parserSource: 'fallback',
      };
    }

    const bypassParseCache = !!request.bypassParseCache || !!request.requireLiveParse;
    const parseCacheKey = geminiParseCacheKey(
      request.prompt,
      request.genderPref,
      request.parserMode === 'gemini' ? 'gemini' : 'auto',
      request.model,
      request.location,
    );
    if (!bypassParseCache) {
      const cached = loadPersistedGeminiParseCache()[parseCacheKey];
      if (cached?.payload) {
        const sanitized = this.sanitizeV2IntentWithMeta(cached.payload, refreshedHeuristic, request.genderPref, request.prompt, true);
        const geminiIntent = sanitized.intent;
        this.baseParser.parseNegatives(geminiIntent, request.prompt, corpusStats);
        const merged = this.mergeGeminiFirst(
          this.sanitizeV2Intent(geminiIntent, refreshedHeuristic, request.genderPref, request.prompt, false),
          heuristicIntent,
        );
        const recoveredConfidenceSummary = sanitized.meta.recoveredSubjects.length
          ? {
              count: sanitized.meta.recoveredSubjects.length,
              mean: Number((sanitized.meta.recoveredSubjects.reduce((sum, subject) => sum + subject.confidence, 0) / sanitized.meta.recoveredSubjects.length).toFixed(6)),
              max: Number((Math.max(...sanitized.meta.recoveredSubjects.map((subject) => subject.confidence))).toFixed(6)),
            }
          : null;
        const boosted = applyPromptSemanticMappings(
          request.prompt,
          this.sanitizeV2Intent(merged, refreshedHeuristic, request.genderPref, request.prompt, false),
          request.genderPref,
        );
        return {
          intent: boosted,
          geminiState: {
            active: true,
            reason: null,
            intent: merged,
            source: 'cache_live',
            cacheHit: true,
            retryCount: 0,
            model: request.model,
            location: request.location,
            semanticSubjectSource: sanitized.meta.subjectSource,
            recoveredSubjectKinds: Array.from(new Set(sanitized.meta.recoveredSubjects.map((subject) => subject.kind))),
            recoveredSubjectConfidenceSummary: recoveredConfidenceSummary,
          },
          parserSource: request.parserMode === 'gemini' ? 'gemini' : 'merged',
        };
      }

      const durableCached = await loadDurablePromptParse(parseCacheKey);
      if (durableCached?.payload) {
        rememberGeminiParse(parseCacheKey, durableCached);
        const sanitized = this.sanitizeV2IntentWithMeta(durableCached.payload, refreshedHeuristic, request.genderPref, request.prompt, true);
        const geminiIntent = sanitized.intent;
        this.baseParser.parseNegatives(geminiIntent, request.prompt, corpusStats);
        const merged = this.mergeGeminiFirst(
          this.sanitizeV2Intent(geminiIntent, refreshedHeuristic, request.genderPref, request.prompt, false),
          heuristicIntent,
        );
        const recoveredConfidenceSummary = sanitized.meta.recoveredSubjects.length
          ? {
              count: sanitized.meta.recoveredSubjects.length,
              mean: Number((sanitized.meta.recoveredSubjects.reduce((sum, subject) => sum + subject.confidence, 0) / sanitized.meta.recoveredSubjects.length).toFixed(6)),
              max: Number((Math.max(...sanitized.meta.recoveredSubjects.map((subject) => subject.confidence))).toFixed(6)),
            }
          : null;
        const boosted = applyPromptSemanticMappings(
          request.prompt,
          this.sanitizeV2Intent(merged, refreshedHeuristic, request.genderPref, request.prompt, false),
          request.genderPref,
        );
        return {
          intent: boosted,
          geminiState: {
            active: true,
            reason: null,
            intent: merged,
            source: 'cache_live',
            cacheHit: true,
            retryCount: 0,
            model: request.model,
            location: request.location,
            semanticSubjectSource: sanitized.meta.subjectSource,
            recoveredSubjectKinds: Array.from(new Set(sanitized.meta.recoveredSubjects.map((subject) => subject.kind))),
            recoveredSubjectConfidenceSummary: recoveredConfidenceSummary,
          },
          parserSource: request.parserMode === 'gemini' ? 'gemini' : 'merged',
        };
      }
    }

    const geminiResult = await this.geminiIntentV2(
      request.prompt,
      request.genderPref,
      resolvedProject,
      request.location,
      request.model,
      Math.max(1, Number(request.geminiTimeoutMs || process.env.EMBEDDING_V2_GEMINI_TIMEOUT_MS || '20000')),
      Math.max(0, Number(request.benchmarkRateLimitMs || process.env.EMBEDDING_V2_BENCHMARK_RATE_LIMIT_MS || '0')),
      request.debug,
    );

    if (!geminiResult.payload) {
      const boosted = applyPromptSemanticMappings(request.prompt, heuristicRecoveredIntent, request.genderPref);
      return {
        intent: boosted,
        geminiState: {
          active: false,
          reason: geminiResult.reason || 'gemini_empty',
          intent: null,
          source: geminiResult.source,
          cacheHit: false,
          retryCount: geminiResult.retryCount,
          model: request.model,
          location: request.location,
          semanticSubjectSource: 'none',
          recoveredSubjectKinds: [],
          recoveredSubjectConfidenceSummary: null,
        },
        parserSource: 'fallback',
      };
    }

    rememberGeminiParse(parseCacheKey, {
      payload: geminiResult.payload,
      created_at: new Date().toISOString(),
      source: 'live',
      model: request.model,
      location: request.location,
      parser_mode: request.parserMode === 'gemini' ? 'gemini' : 'auto',
      schema_version: GEMINI_PARSE_CACHE_SCHEMA_VERSION,
    });
    void persistDurablePromptParse(parseCacheKey, {
      payload: geminiResult.payload,
      created_at: new Date().toISOString(),
      source: 'live',
      model: request.model,
      location: request.location,
      parser_mode: request.parserMode === 'gemini' ? 'gemini' : 'auto',
      schema_version: GEMINI_PARSE_CACHE_SCHEMA_VERSION,
    }).catch(() => {});

    const sanitized = this.sanitizeV2IntentWithMeta(geminiResult.payload, refreshedHeuristic, request.genderPref, request.prompt, true);
    const geminiIntent = sanitized.intent;
    this.baseParser.parseNegatives(geminiIntent, request.prompt, corpusStats);
    const merged = this.mergeGeminiFirst(
      this.sanitizeV2Intent(geminiIntent, refreshedHeuristic, request.genderPref, request.prompt, false),
      heuristicIntent,
    );
    const recoveredConfidenceSummary = sanitized.meta.recoveredSubjects.length
      ? {
          count: sanitized.meta.recoveredSubjects.length,
          mean: Number((sanitized.meta.recoveredSubjects.reduce((sum, subject) => sum + subject.confidence, 0) / sanitized.meta.recoveredSubjects.length).toFixed(6)),
          max: Number((Math.max(...sanitized.meta.recoveredSubjects.map((subject) => subject.confidence))).toFixed(6)),
        }
      : null;
    const boosted = applyPromptSemanticMappings(
      request.prompt,
      this.sanitizeV2Intent(merged, refreshedHeuristic, request.genderPref, request.prompt, false),
      request.genderPref,
    );

    return {
      intent: boosted,
      geminiState: {
        active: true,
        reason: null,
        intent: merged,
        source: geminiResult.source,
        cacheHit: false,
        retryCount: geminiResult.retryCount,
        model: request.model,
        location: request.location,
        semanticSubjectSource: sanitized.meta.subjectSource,
        recoveredSubjectKinds: Array.from(new Set(sanitized.meta.recoveredSubjects.map((subject) => subject.kind))),
        recoveredSubjectConfidenceSummary: recoveredConfidenceSummary,
      },
      parserSource: request.parserMode === 'gemini' ? 'gemini' : 'merged',
    };
  }
}
