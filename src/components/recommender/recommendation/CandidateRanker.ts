import { SemanticCorpusStats } from '../canonical_index';
import {
  CategoryMain,
  SLOT_ORDER,
  Sport,
  canonicalizeSubtype,
  isAthleticShoeSubtype,
  isFormalSubtype,
  isOpenCasualShoeSubtype,
  isSmartCasualShoeSubtype,
  normalizeText,
  subtypeFamily,
} from '../fashion_taxonomy';
import { cosineSimilarity } from '../semantic_embeddings';
import {
  CandidateRanker as BaseCandidateRanker,
  precomputeItemFeatures,
} from '../og_recommendation/RecommendationService';
import { deriveItemSemanticAxisProfile, deriveRuntimeSemanticControls, RuntimeSemanticControls, SemanticAxisProfile } from '../style_semantics';
import {
  CandidateFrontierDiagnostics,
  CandidateScore as ScoredItem,
  EmbeddingMode,
  LoadedEmbeddings,
  PromptEmbeddingState,
  SemanticSubjectKind,
  SlotConstraintProfile,
} from './types';
import { PromptIntentV2 } from './types';

const CANDIDATE_TIMING_LOGS_ENABLED = (process.env.RECOMMENDER_TIMING_LOGS || '0') === '1';

function logCandidateTiming(stage: string, payload: Record<string, unknown>) {
  if (!CANDIDATE_TIMING_LOGS_ENABLED) return;
  console.log('[recommender][timing]', JSON.stringify({ stage, ...payload }));
}

function subjectSlots(intent: PromptIntentV2, kinds?: SemanticSubjectKind[]): CategoryMain[] {
  const subjects = kinds?.length
    ? intent.semantic_subjects.filter((subject) => kinds.includes(subject.kind))
    : intent.semantic_subjects;
  if (!subjects.length) return [];
  const explicit = subjects.flatMap((subject) => subject.slots || []);
  if (explicit.length) return Array.from(new Set(explicit));
  if (subjects.some((subject) => subject.scope === 'global')) {
    return intent.requested_slots.length ? intent.requested_slots : SLOT_ORDER;
  }
  if (intent.requested_slots.length === 1) return intent.requested_slots;
  return [];
}

function semanticSubjectsForSlot(intent: PromptIntentV2, slot: CategoryMain) {
  return intent.semantic_subjects.filter((subject) => {
    if (subject.scope === 'global') return true;
    return !!subject.slots?.includes(slot);
  });
}

function uniqueById(candidates: ScoredItem[]): ScoredItem[] {
  const seen = new Set<string>();
  const out: ScoredItem[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.item.id)) continue;
    seen.add(candidate.item.id);
    out.push(candidate);
  }
  return out;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function broadSemanticOutfitIntent(intent: PromptIntentV2): boolean {
  if (intent.assembly_mode !== 'full_outfit') return false;
  if ((intent.requested_slots.length ? intent.requested_slots : SLOT_ORDER).length < 3) return false;
  if (!intent.semantic_subjects.length && !intent.vibe_tags.length) return false;
  const slotScopedSubjects = intent.semantic_subjects.filter((subject) => subject.scope === 'slot' || (subject.slots || []).length > 0);
  if (slotScopedSubjects.length) return false;
  return !!(
    intent.vibe_tags.length ||
    intent.semantic_subjects.some((subject) => subject.kind === 'style_archetype' || subject.kind === 'theme')
  );
}

function requestedSlotsForIntent(intent: PromptIntentV2): CategoryMain[] {
  return (intent.requested_slots.length ? intent.requested_slots : SLOT_ORDER).filter((slot): slot is CategoryMain => !!slot);
}

function semanticSemanticKindWeight(kind: SemanticSubjectKind): number {
  if (kind === 'persona') return 0.34;
  if (kind === 'style_archetype') return 0.28;
  if (kind === 'theme') return 0.24;
  if (kind === 'brand' || kind === 'team' || kind === 'item_line') return 0.08;
  return 0.06;
}

function brandCoverageTerms(intent: PromptIntentV2): string[] {
  return Array.from(new Set(
    [
      ...intent.brand_focus,
      ...intent.semantic_subjects
        .filter((subject) => subject.kind === 'brand')
        .flatMap((subject) => [subject.label, ...(subject.soft_brand_priors || [])]),
    ]
      .map((value) => normalizeText(value || '').trim())
      .filter(Boolean),
  ));
}

function brandCoverageText(item: any): string {
  return normalizeText([
    item.id || '',
    item.name || '',
    item.name_normalized || '',
    item.sub || '',
    item.brand || '',
    ...(item.entities || []),
    ...(item.identity_entities || []),
    ...((item.entityMeta || []).map((entry: any) => entry?.text || entry?.label || entry?.name || '')),
  ].join(' '));
}

function itemMatchesBrandCoverage(item: any, terms: string[]): boolean {
  if (!item || !terms.length) return false;
  const text = brandCoverageText(item);
  return !!text && terms.some((term) => text.includes(term));
}

function targetedBrandSlots(intent: PromptIntentV2, items: any[]): Set<CategoryMain> {
  const terms = brandCoverageTerms(intent);
  if (!terms.length || intent.brand_fit_mode === 'none') return new Set<CategoryMain>();
  const requested = requestedSlotsForIntent(intent);
  if (intent.brand_fit_mode === 'full_brand_coverage') return new Set(requested);
  const ranked = requested
    .map((slot) => ({
      slot,
      count: items.filter((item) => item?.category === slot && itemMatchesBrandCoverage(item, terms)).length,
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || (a.slot === 'top' ? -1 : 1));
  return new Set(ranked.slice(0, Math.min(2, ranked.length || 1)).map((entry) => entry.slot));
}

function refinedEveningIntent(intent: PromptIntentV2, promptProfile: SemanticAxisProfile | null | undefined): boolean {
  const refinedSignal = Math.max(
    promptProfile?.refined || 0,
    promptProfile?.classic || 0,
    promptProfile?.understated || 0,
    promptProfile?.structured || 0,
  );
  return !!(
    intent.occasion_tags.includes('evening') ||
    intent.occasion_tags.includes('formal') ||
    intent.activity_context.includes('dinner') ||
    intent.vibe_tags.includes('formal') ||
    intent.vibe_tags.includes('chic') ||
    refinedSignal >= 0.54
  );
}

function semanticAxisAlignment(promptProfile: SemanticAxisProfile | null | undefined, itemProfile: SemanticAxisProfile): number {
  if (!promptProfile) return 0.5;
  const axes: Array<keyof SemanticAxisProfile> = [
    'refined',
    'classic',
    'minimal',
    'relaxed',
    'structured',
    'neutral',
    'understated',
    'sporty',
    'streetwear',
    'graphic',
  ];
  let weighted = 0;
  let total = 0;
  for (const axis of axes) {
    const target = promptProfile[axis];
    let weight = target >= 0.34 ? 0.45 + target : 0.12;
    if (axis === 'sporty') weight = Math.max(weight, promptProfile.refined * 0.65, promptProfile.classic * 0.45, promptProfile.understated * 0.55);
    if (axis === 'streetwear') weight = Math.max(weight, promptProfile.refined * 0.55, promptProfile.classic * 0.4, promptProfile.understated * 0.5);
    if (axis === 'graphic') weight = Math.max(weight, promptProfile.minimal * 0.7, promptProfile.understated * 0.75, promptProfile.refined * 0.4);
    if (axis === 'relaxed') weight = Math.max(weight, promptProfile.structured * 0.4);
    if (axis === 'structured') weight = Math.max(weight, promptProfile.relaxed * 0.35, promptProfile.refined * 0.3);
    weighted += (1 - Math.abs(target - itemProfile[axis])) * weight;
    total += weight;
  }
  return total > 0 ? weighted / total : 0.5;
}

function semanticMismatchPenalty(promptProfile: SemanticAxisProfile | null | undefined, itemProfile: SemanticAxisProfile): number {
  if (!promptProfile) return 0;
  const refinedLean = Math.max(promptProfile.refined, promptProfile.classic, promptProfile.minimal, promptProfile.understated);
  let penalty = 0;
  penalty += Math.max(0, itemProfile.sporty - promptProfile.sporty) * (0.22 + refinedLean * 0.92);
  penalty += Math.max(0, itemProfile.streetwear - promptProfile.streetwear) * (0.2 + refinedLean * 0.84);
  penalty += Math.max(0, itemProfile.graphic - promptProfile.graphic) * (0.2 + Math.max(promptProfile.minimal, promptProfile.understated) * 0.95);
  penalty += Math.max(0, promptProfile.refined - itemProfile.refined) * (0.16 + promptProfile.refined * 0.72);
  penalty += Math.max(0, promptProfile.classic - itemProfile.classic) * (0.14 + promptProfile.classic * 0.68);
  penalty += Math.max(0, promptProfile.minimal - itemProfile.minimal) * (0.14 + promptProfile.minimal * 0.72);
  penalty += Math.max(0, promptProfile.understated - itemProfile.understated) * (0.14 + promptProfile.understated * 0.78);
  penalty += Math.max(0, promptProfile.structured - itemProfile.structured) * (0.1 + promptProfile.structured * 0.4);
  penalty += Math.max(0, promptProfile.neutral - itemProfile.neutral) * (0.08 + promptProfile.neutral * 0.28);
  penalty += Math.max(0, promptProfile.relaxed - itemProfile.relaxed) * (0.06 + promptProfile.relaxed * 0.2);
  return penalty;
}

function constraintCleanliness(candidate: ScoredItem): number {
  return candidate.negativeViolated ? 0 : 1;
}

function itemKeywordHit(item: ScoredItem['item'], keyword: string): boolean {
  const norm = normalizeText(keyword || '');
  if (!norm) return false;
  const haystack = normalizeText([
    item.name || '',
    item.name_normalized || '',
    item.sub || '',
    ...(item.entities || []),
    ...(item.identity_entities || []),
  ].join(' '));
  return !!haystack && haystack.includes(norm);
}

function itemEntityHit(item: ScoredItem['item'], entity: string): boolean {
  const norm = normalizeText(entity || '');
  if (!norm) return false;
  const values = [
    ...(item.entities || []),
    ...(item.identity_entities || []),
    ...((item.entityMeta || []).map((entry) => entry.text || '')),
  ].map((value) => normalizeText(value));
  return values.some((value) => value === norm || value.includes(norm));
}

function personaSubjectsForSlot(intent: PromptIntentV2, slot: CategoryMain) {
  return semanticSubjectsForSlot(intent, slot).filter((subject) => subject.kind === 'persona');
}

function personaSoftBrandTerms(intent: PromptIntentV2, slot: CategoryMain): string[] {
  return Array.from(new Set(
    personaSubjectsForSlot(intent, slot)
      .flatMap((subject) => subject.soft_brand_priors || [])
      .map((value) => normalizeText(value || '').trim())
      .filter(Boolean),
  ));
}

function personaPrefersSlot(intent: PromptIntentV2, slot: CategoryMain): boolean {
  return personaSubjectsForSlot(intent, slot).some((subject) => (subject.category_preferences || []).includes(slot));
}

function subtypeFamilyMatch(item: ScoredItem['item'], subtype: string): boolean {
  const want = canonicalizeSubtype(subtype);
  const itemSub = canonicalizeSubtype(item.sub || '');
  if (!want) return true;
  if (want === itemSub) return true;
  const families = new Set(subtypeFamily(itemSub));
  if (families.has(want)) return true;
  const targetFamilies = new Set(subtypeFamily(want));
  for (const family of targetFamilies) {
    if (families.has(family)) return true;
  }
  return itemKeywordHit(item, want);
}

function sportSpecificFootwearAdjustment(item: ScoredItem['item'], sport: Sport): number {
  if (!sport || sport === 'none') return 0;
  const sub = canonicalizeSubtype(item.sub || '');
  const text = normalizeText([
    item.name || '',
    item.name_normalized || '',
    item.sub || '',
    ...(item.entities || []),
    ...(item.identity_entities || []),
    ...((item.entityMeta || []).map((entry) => entry.text || '')),
  ].join(' '));
  const metaSport = item.sportMeta?.sport || 'none';
  const ruggedBootCue = /\bhiking\b|\bwork boot\b|\bworkboot\b|\bcombat\b|\btrek\b|\btrail\b|\bmountain\b|\boutdoor\b|\brock\b/.test(text);
  let score = 0;

  if (metaSport !== 'none' && metaSport !== sport) score -= 0.62;

  if (sport === 'football') {
    const explicit = /\bfootball\b|\bsoccer\b|\bcleat\b|\bcleats\b|\bfirm ground\b|\bsoft ground\b|\bartificial ground\b|\bturf\b|\bfg\b|\bsg\b|\bag\b|\bmercurial\b|\bpredator\b|\bphantom\b|\bf50\b/.test(text);
    if (metaSport === 'football') score += 1.1;
    if (sub === 'boots') score += 0.9;
    if (explicit) score += 1.3;
    if (!explicit && sub !== 'boots') score -= isAthleticShoeSubtype(sub) ? 0.58 : 1.1;
  } else if (sport === 'basketball') {
    const explicit = /\bbasketball\b|\bnba\b|\bjordan\b|\bair jordan\b|\blebron\b|\bkobe\b|\bdunk\b/.test(text);
    const premium = /\bjordan\b|\bair jordan\b|\blebron\b|\bkobe\b|\bdunk\b/.test(text);
    if (metaSport === 'basketball') score += explicit ? 0.92 : 0.22;
    if (explicit) score += premium ? 1.9 : 1.0;
    if (isAthleticShoeSubtype(sub)) score += explicit ? 0.42 : 0.08;
    if (ruggedBootCue || /\bboot\b|\bboots\b/.test(text)) score -= premium ? 0.2 : 2.4;
    if (!explicit && metaSport !== 'basketball') score -= isAthleticShoeSubtype(sub) ? 0.46 : 1.0;
    if (!explicit && metaSport === 'basketball') score -= isAthleticShoeSubtype(sub) ? 0.72 : 1.4;
  } else if (sport === 'running') {
    const explicit = /\brunning\b|\brunner\b|\bmarathon\b|\btempo\b|\bpegasus\b|\bvaporfly\b|\balphafly\b|\bgel kayano\b|\bgel-kayano\b|\bnovablast\b/.test(text);
    if (metaSport === 'running') score += 1.0;
    if (explicit) score += 1.0;
    if (isAthleticShoeSubtype(sub)) score += 0.28;
    if (!explicit && metaSport !== 'running') score -= isAthleticShoeSubtype(sub) ? 0.28 : 0.82;
  } else if (sport === 'tennis') {
    const explicit = /\btennis\b|\bcourt\b|\bclay\b|\bhard court\b|\bwimbledon\b/.test(text);
    if (metaSport === 'tennis') score += 1.0;
    if (explicit) score += 0.96;
    if (isAthleticShoeSubtype(sub)) score += 0.24;
    if (!explicit && metaSport !== 'tennis') score -= isAthleticShoeSubtype(sub) ? 0.26 : 0.78;
  } else if (sport === 'gym') {
    const explicit = /\bgym\b|\btraining\b|\btrainer\b|\bcross trainer\b|\bcross-training\b|\bmetcon\b/.test(text);
    if (metaSport === 'gym') score += 0.92;
    if (explicit) score += 0.84;
    if (isAthleticShoeSubtype(sub)) score += 0.24;
    if (!explicit && metaSport !== 'gym') score -= isAthleticShoeSubtype(sub) ? 0.18 : 0.66;
  }

  return score;
}

function hasAnchoredConstraint(slotProfile: SlotConstraintProfile): boolean {
  const hasIdentityAnchor = !!(
    slotProfile.exact_item_phrases.length ||
    slotProfile.anchor_entities.length ||
    slotProfile.anchor_keywords.length
  );
  const hasExplicitConstraint = !!(
    slotProfile.excluded_subs.length ||
    slotProfile.excluded_keywords.length ||
    (slotProfile.excluded_entities || []).length ||
    (slotProfile.excluded_colours || []).length
  );
  return hasIdentityAnchor && hasExplicitConstraint;
}

function anchorPreservationScore(
  item: ScoredItem['item'],
  slotProfile: SlotConstraintProfile,
): number {
  const exactPhraseMatch = slotProfile.exact_item_phrases.some((keyword) => {
    const normalized = normalizeText(keyword || '');
    if (!normalized) return false;
    return itemKeywordHit(item, normalized);
  });
  const allEntities = slotProfile.anchor_entities.length > 0 &&
    slotProfile.anchor_entities.every((entity) => itemEntityHit(item, entity));
  const anyEntities = slotProfile.anchor_entities.length > 0 &&
    slotProfile.anchor_entities.some((entity) => itemEntityHit(item, entity));
  const allKeywords = slotProfile.required_keywords.length > 0 &&
    slotProfile.required_keywords.every((keyword) => itemKeywordHit(item, keyword));
  const anyKeywords = slotProfile.required_keywords.length > 0 &&
    slotProfile.required_keywords.some((keyword) => itemKeywordHit(item, keyword));
  const subtypeMatch = slotProfile.preferred_subs.length > 0 &&
    slotProfile.preferred_subs.some((sub) => subtypeFamilyMatch(item, sub));
  const inVariantGroup = !!(item.variant_group_key && slotProfile.variantGroupHints.includes(item.variant_group_key));

  if (
    !slotProfile.exact_item_phrases.length &&
    !slotProfile.anchor_entities.length &&
    !slotProfile.required_keywords.length &&
    !slotProfile.preferred_subs.length
  ) {
    return 1;
  }

  let weighted = 0;
  let total = 0;
  const identityAnchored = slotProfile.exact_item_phrases.length > 0 || slotProfile.anchor_entities.length > 0;
  if (identityAnchored) {
    weighted += exactPhraseMatch ? 1.08 : allEntities ? 0.94 : anyEntities ? 0.4 : 0;
    total += 1.1;
  }
  if (slotProfile.required_keywords.length) {
    weighted += allKeywords ? 0.7 : anyKeywords ? 0.34 : 0;
    total += identityAnchored ? 0.16 : 0.8;
  }
  if (slotProfile.preferred_subs.length) {
    weighted += subtypeMatch ? 0.46 : 0;
    total += identityAnchored ? 0.12 : 0.35;
  }
  if (slotProfile.variantGroupHints.length) {
    weighted += inVariantGroup ? 0.85 : 0;
    total += identityAnchored ? 0.24 : 0.45;
  }
  return total > 0 ? Math.max(0, Math.min(1, weighted / total)) : 1;
}

type PromptRegime = 'constraint_dominant' | 'semantic_dominant' | 'mixed';

interface AnchorStyleDominance {
  refined: number;
  streetwear: number;
  sport: number;
  strength: number;
}

function explicitSlotConstraintCount(intent: PromptIntentV2): number {
  return SLOT_ORDER.reduce((sum, slot) => {
    const constraint = intent.slot_constraints[slot];
    if (!constraint) return sum;
    return sum +
      constraint.excluded_keywords.length +
      constraint.excluded_subs.length +
      constraint.excluded_entities.length +
      constraint.excluded_colours.length;
  }, 0);
}

function promptRegime(
  intent: PromptIntentV2,
  controls: RuntimeSemanticControls,
  informativeness: number,
): PromptRegime {
  const semanticSignals =
    (intent.semantic_subjects.length ? 0.18 : 0) +
    (intent.vibe_tags.length ? 0.08 : 0) +
    Math.min(0.14, intent.semantic_subjects.length * 0.035);
  const paletteSignals =
    (intent.palette_mode === 'tonal' || intent.palette_mode === 'monochrome' ? 0.16 : 0) +
    (intent.palette_mode === 'colorful' || intent.palette_mode === 'muted' ? 0.08 : 0) +
    Math.min(0.14, intent.global_palette_colours.length * 0.05);
  const hardConstraintSignals =
    explicitSlotConstraintCount(intent) * 0.02 +
    (intent.negative_constraints.non_sport ? 0.12 : 0) +
    (intent.negative_constraints.no_logos ? 0.08 : 0) +
    Math.min(0.1, intent.negative_constraints.excluded_keywords.length * 0.025);
  const constraintScore =
    controls.explicitConstraintStrength * 0.62 +
    controls.paletteStrictness * 0.18 +
    paletteSignals +
    hardConstraintSignals;
  const semanticScore =
    controls.semanticExpansionStrength * 0.54 +
    controls.rolePurityWeight * 0.12 +
    informativeness * 0.28 +
    semanticSignals;
  if (constraintScore >= semanticScore + 0.12 && informativeness < 0.62) return 'constraint_dominant';
  if (semanticScore >= constraintScore + 0.08 && (intent.semantic_subjects.length > 0 || intent.vibe_tags.length > 0)) {
    return 'semantic_dominant';
  }
  return 'mixed';
}

function lockModeStrength(lockMode: SlotConstraintProfile['lockMode']): number {
  if (lockMode === 'exact') return 1;
  if (lockMode === 'family') return 0.84;
  if (lockMode === 'attribute') return 0.62;
  return 0.22;
}

function slotProfileAnchorTerms(profile: SlotConstraintProfile): string[] {
  return [
    ...profile.preferred_subs,
    ...profile.required_keywords,
    ...profile.anchor_keywords,
    ...profile.anchor_entities,
    ...profile.exact_item_phrases,
  ].map((value) => normalizeText(value || '')).filter(Boolean);
}

function slotProfileExplicitness(profile: SlotConstraintProfile): number {
  const anchorTerms = slotProfileAnchorTerms(profile).length;
  const exclusions =
    profile.excluded_keywords.length +
    profile.excluded_subs.length +
    (profile.excluded_entities || []).length +
    (profile.excluded_colours || []).length;
  const lockStrength =
    profile.lockMode === 'exact'
      ? 1
      : profile.lockMode === 'family'
        ? 0.82
        : profile.lockMode === 'attribute'
          ? 0.54
          : 0.18;
  return clamp01(lockStrength * 0.5 + Math.min(0.38, anchorTerms * 0.06) + Math.min(0.24, exclusions * 0.03) + profile.specificity * 0.18);
}

function anchorTermStyleSignature(slot: CategoryMain, term: string): Omit<AnchorStyleDominance, 'strength'> {
  const sub = canonicalizeSubtype(term);
  const families = new Set(subtypeFamily(sub));
  const text = normalizeText([term, sub].filter(Boolean).join(' '));
  let refined = 0;
  let streetwear = 0;
  let sport = 0;

  if (
    isFormalSubtype(sub) ||
    isSmartCasualShoeSubtype(sub) ||
    sub === 'trousers' ||
    sub === 'tailored trousers' ||
    sub === 'dress pants' ||
    sub === 'loafers' ||
    sub === 'dress shirt' ||
    sub === 'oxford shirt' ||
    sub === 'shirt' ||
    sub === 'blazer' ||
    sub === 'cardigan' ||
    sub === 'polo' ||
    /\btailored|loafer|derby|oxford|dress shirt|trouser|polished|minimal|understated|classic\b/.test(text)
  ) {
    refined += 0.7;
  }
  if (
    families.has('denim') ||
    families.has('boot_family') ||
    sub === 'hoodie' ||
    sub === 'sweatshirt' ||
    sub === 'tshirt' ||
    sub === 'sneakers' ||
    sub === 'cargo trousers' ||
    /\bhoodie|sweatshirt|streetwear|cargo|denim|washed|distressed|graphic|logo|boot|sneaker|tee|t-shirt\b/.test(text)
  ) {
    streetwear += 0.78;
  }
  if (
    isAthleticShoeSubtype(sub) ||
    /\bfootball|basketball|soccer|jersey|kit|cleat|trainer|sport\b/.test(text)
  ) {
    sport += 0.82;
  }
  if (slot === 'top' && /\bhoodie|sweatshirt|tshirt|tee|jersey\b/.test(text)) streetwear += 0.14;
  if (slot === 'bottom' && /\bcargo|jeans|denim|track|jogger\b/.test(text)) streetwear += 0.12;
  if (slot === 'shoes' && (families.has('boot_family') || sub === 'sneakers')) streetwear += 0.12;
  if (slot === 'shoes' && (isFormalSubtype(sub) || isSmartCasualShoeSubtype(sub))) refined += 0.12;
  return {
    refined: clamp01(refined),
    streetwear: clamp01(streetwear),
    sport: clamp01(sport),
  };
}

function deriveAnchorStyleDominance(
  currentSlot: CategoryMain,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  intent: PromptIntentV2,
  promptProfile: SemanticAxisProfile | null | undefined,
): AnchorStyleDominance {
  let refined = 0;
  let streetwear = 0;
  let sport = 0;
  let strength = 0;
  for (const slot of SLOT_ORDER) {
    if (slot === currentSlot) continue;
    const profile = slotProfiles[slot];
    if (!profile) continue;
    const anchorStrength = clamp01(lockModeStrength(profile.lockMode) * (0.45 + profile.specificity * 0.55));
    if (anchorStrength < 0.34) continue;
    const terms = slotProfileAnchorTerms(profile);
    if (!terms.length) continue;
    let localRefined = 0;
    let localStreetwear = 0;
    let localSport = 0;
    for (const term of terms) {
      const signature = anchorTermStyleSignature(slot, term);
      localRefined = Math.max(localRefined, signature.refined);
      localStreetwear = Math.max(localStreetwear, signature.streetwear);
      localSport = Math.max(localSport, signature.sport);
    }
    if (localRefined <= 0 && localStreetwear <= 0 && localSport <= 0) continue;
    refined += localRefined * anchorStrength;
    streetwear += localStreetwear * anchorStrength;
    sport += localSport * anchorStrength;
    strength += anchorStrength;
  }
  if (intent.semantic_subjects.some((subject) => subject.kind === 'persona')) {
    const safe = promptProfile || {
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
    streetwear += Math.max(0, safe.streetwear + safe.graphic * 0.58 - safe.refined * 0.42) * 0.48;
    refined += Math.max(0, safe.refined + safe.classic * 0.32 - safe.streetwear * 0.4) * 0.14;
    sport += Math.max(0, safe.sporty - safe.understated * 0.18) * 0.18;
    strength += 0.18;
  }
  const normalizedStrength = clamp01(strength);
  return {
    refined: normalizedStrength ? clamp01(refined / normalizedStrength) : 0,
    streetwear: normalizedStrength ? clamp01(streetwear / normalizedStrength) : 0,
    sport: normalizedStrength ? clamp01(sport / normalizedStrength) : 0,
    strength: normalizedStrength,
  };
}

function itemSemanticText(item: ScoredItem['item']): string {
  return normalizeText([
    item.name || '',
    item.name_normalized || '',
    item.sub || '',
    ...(item.entities || []),
    ...(item.identity_entities || []),
    ...((item.style_markers || []).map((entry) => String(entry || ''))),
  ].join(' '));
}

function slotFamilyFitScore(
  slot: CategoryMain,
  item: ScoredItem['item'],
  promptProfile: SemanticAxisProfile | null | undefined,
  intent: PromptIntentV2,
  controls: RuntimeSemanticControls,
  anchorDominance?: AnchorStyleDominance,
): number {
  if (!promptProfile) return 0;
  const sub = canonicalizeSubtype(item.sub || '');
  const families = new Set(subtypeFamily(sub));
  const itemProfile = deriveItemSemanticAxisProfile(item);
  const text = itemSemanticText(item);
  const anchorRefined = (anchorDominance?.refined || 0) * (anchorDominance?.strength || 0);
  const anchorStreetwear = (anchorDominance?.streetwear || 0) * (anchorDominance?.strength || 0);
  const anchorSport = (anchorDominance?.sport || 0) * (anchorDominance?.strength || 0);
  const menGuard = intent.target_gender === 'men';
  const refinedEvening = refinedEveningIntent(intent, promptProfile);
  const gymContext = intent.sport_context === 'gym';
  const broadOutfit = broadSemanticOutfitIntent(intent);
  const contextualOuterwear = intent.setting_context.length > 0 || intent.activity_context.length > 0 || intent.daypart_context.length > 0 || intent.occasion_tags.length > 0;
  const personaStreetBias = intent.semantic_subjects.some((subject) => subject.kind === 'persona')
    ? Math.max(0, promptProfile.streetwear + promptProfile.graphic * 0.55 - promptProfile.refined * 0.35) * 0.48
    : 0;
  const refinedDemand = Math.max(
    promptProfile.refined,
    promptProfile.classic,
    promptProfile.minimal,
    promptProfile.understated,
    controls.rolePurityWeight,
  ) + anchorRefined * 0.68 - anchorStreetwear * 0.18 - personaStreetBias * 0.12;
  const structuredDemand = Math.max(promptProfile.structured, promptProfile.classic, controls.structureRichness) + anchorRefined * 0.28;
  const relaxedDemand = Math.max(promptProfile.relaxed, controls.noiseTolerance) + anchorStreetwear * 0.24 + personaStreetBias * 0.18;
  const streetwearDemand = Math.max(promptProfile.streetwear, promptProfile.relaxed, controls.noiseTolerance) + anchorStreetwear * 0.8 + anchorSport * 0.18 + personaStreetBias;
  const refinedWithoutStreetwear = Math.max(0, refinedDemand - streetwearDemand * 0.6);
  const nonSportDemand = Math.max(
    0,
    (intent.negative_constraints.non_sport ? 0.28 : 0) +
      controls.explicitConstraintStrength * 0.45 +
      Math.max(0, 0.34 - controls.sportTolerance) * 0.4,
  );
  let score = 0;

  if (slot === 'top') {
    if (menGuard && /\b(ruffled|blouse|camisole|tie neck|tie-neck)\b/.test(text)) {
      score -= 0.42 + refinedDemand * 0.36 + structuredDemand * 0.12;
    }
    if (
      families.has('shirt_family') ||
      sub === 'dress shirt' ||
      sub === 'oxford shirt' ||
      sub === 'shirt' ||
      sub === 'polo' ||
      sub === 'cardigan' ||
      sub === 'sweater' ||
      sub === 'blazer' ||
      sub === 'suit jacket'
    ) {
      score += 0.2 + refinedDemand * 0.24 + structuredDemand * 0.12;
      if (streetwearDemand > refinedDemand + 0.08 && !/\bgraphic|logo|washed|distressed|oversized|hoodie|tee|t-shirt\b/.test(text)) {
        score -= 0.18 + streetwearDemand * 0.26 + personaStreetBias * 0.08;
      }
    }
    if (sub === 'cardigan' || sub === 'sweater' || sub === 'polo') {
      score += promptProfile.minimal * 0.08 + promptProfile.understated * 0.06;
      if (streetwearDemand > refinedDemand + 0.08 && !/\bgraphic|logo|washed|distressed|oversized\b/.test(text)) {
        score -= 0.16 + streetwearDemand * 0.22;
      }
    }
    if (sub === 'tshirt' || sub === 'hoodie' || sub === 'sweatshirt') {
      score += streetwearDemand * 0.12 + personaStreetBias * 0.18;
      score -= refinedWithoutStreetwear * 0.58 + structuredDemand * 0.18 + promptProfile.understated * 0.16;
    }
    if (/\btank|sleeveless|camisole|crop top\b/.test(text)) {
      score -= refinedWithoutStreetwear * 0.52 + structuredDemand * 0.16 + promptProfile.minimal * 0.08;
    }
    if (/\bgraphic|logo|distressed|washed|faded\b/.test(text)) {
      score -= refinedDemand * 0.16 + promptProfile.minimal * 0.12 + promptProfile.understated * 0.16;
    }
    if (/\bfootball|basketball|kit|jersey\b/.test(text)) {
      score -= 0.16 + nonSportDemand * 0.24 + refinedDemand * 0.12;
    }
    if (broadOutfit && !contextualOuterwear && /\b(jacket|coat|bomber|windbreaker|field jacket|drizzler|outerwear|parka)\b/.test(text)) {
      score -= 0.22 + refinedDemand * 0.18 + structuredDemand * 0.12;
    }
    if (gymContext) {
      if (/\bgym|training|workout|athletic|performance|sports bra|sport bra\b/.test(text)) score += 0.34;
      if (/\bfootball|soccer|basketball|jersey|kit|formula 1|f1|motorsport|racing\b/.test(text)) score -= 0.56 + promptProfile.sporty * 0.22;
    }
    score += Math.max(0, itemProfile.classic - 0.45) * refinedDemand * 0.16;
    score += Math.max(0, itemProfile.understated - 0.45) * refinedDemand * 0.14;
    score += Math.max(0, itemProfile.minimal - 0.45) * promptProfile.minimal * 0.12;
    score += Math.max(0, itemProfile.streetwear - 0.45) * streetwearDemand * 0.08;
  } else if (slot === 'bottom') {
    if (menGuard && /\blegging|leggings\b/.test(text)) {
      score -= 0.52 + refinedDemand * 0.34 + streetwearDemand * 0.14;
    }
    if (refinedEvening && /\blegging|leggings\b/.test(text)) {
      score -= 0.64 + refinedDemand * 0.4 + structuredDemand * 0.18;
    }
    if (sub === 'trousers' || sub === 'tailored trousers' || sub === 'dress pants' || isFormalSubtype(sub)) {
      score += 0.24 + refinedDemand * 0.3 + structuredDemand * 0.2 + (refinedEvening ? 0.16 : 0);
      score -= streetwearDemand * 0.04;
      if (anchorStreetwear > anchorRefined + 0.1) score -= 0.2 + anchorStreetwear * 0.32;
    }
    if (families.has('denim')) {
      score += streetwearDemand * 0.22 + relaxedDemand * 0.08 + personaStreetBias * 0.14;
      score -= refinedDemand * 0.42 + structuredDemand * 0.16;
    }
    if (sub === 'cargo trousers' || /\bcargo\b/.test(text)) {
      score += streetwearDemand * 0.22 + personaStreetBias * 0.16;
      score -= refinedDemand * 0.32 + structuredDemand * 0.14;
    }
    if (/\bjogger|track|sweat\b/.test(text)) {
      score += streetwearDemand * 0.04;
      score -= refinedDemand * 0.24 + nonSportDemand * 0.18;
    }
    if (sub === 'shorts') {
      score += streetwearDemand * 0.08 + relaxedDemand * 0.05;
      score -= refinedDemand * 0.28 + structuredDemand * 0.08;
    }
    if (sub === 'skirt' || /\bskirt\b/.test(text)) score -= 0.22 + streetwearDemand * 0.16 + nonSportDemand * 0.16 + refinedDemand * 0.08;
    if (/\blegging|legging\b/.test(text)) score -= 0.28 + refinedDemand * 0.18 + streetwearDemand * 0.1;
    if (families.has('loungewear')) score -= 0.18 + refinedDemand * 0.18 + nonSportDemand * 0.12;
    if (/\bhiking|mountain|trail|utility\b/.test(text)) score -= refinedDemand * 0.12 + promptProfile.minimal * 0.08;
    if (/\bfootball|basketball|kit|jersey\b/.test(text)) score -= 0.22 + nonSportDemand * 0.4;
    if (gymContext) {
      if (/\bgym|training|workout|athletic|performance|legging|leggings|jogger|joggers|shorts\b/.test(text)) score += 0.28;
      if (/\bfootball|soccer|basketball|jersey|kit|formula 1|f1|motorsport|racing\b/.test(text)) score -= 0.58 + promptProfile.sporty * 0.22;
      if (/\bdenim|jean|jeans\b/.test(text)) score -= 0.18 + promptProfile.sporty * 0.08;
    }
    score += Math.max(0, itemProfile.classic - 0.45) * refinedDemand * 0.16;
    score += Math.max(0, itemProfile.structured - 0.45) * structuredDemand * 0.16;
    score += Math.max(0, itemProfile.streetwear - 0.45) * streetwearDemand * 0.14;
  } else if (slot === 'shoes') {
    if (menGuard && /\b(pump|pumps|heel|heels|stiletto|stilettos|slingback|slingbacks|mary jane|mary janes|tabi)\b/.test(text)) {
      score -= 0.58 + refinedDemand * 0.36 + nonSportDemand * 0.12;
    }
    if (isSmartCasualShoeSubtype(sub) || isFormalSubtype(sub)) {
      score += 0.22 + refinedDemand * 0.28 + structuredDemand * 0.1;
      score -= streetwearDemand * 0.08 + personaStreetBias * 0.16;
      if (streetwearDemand > refinedDemand + 0.08 && anchorRefined < anchorStreetwear + 0.04) {
        score -= 0.26 + streetwearDemand * 0.34 + nonSportDemand * 0.12;
      }
      if (anchorStreetwear > anchorRefined + 0.1) score -= 0.22 + anchorStreetwear * 0.42 + anchorSport * 0.12;
    }
    if (sub === 'boots' || families.has('boot_family')) {
      score += streetwearDemand * 0.14 + Math.max(promptProfile.understated, promptProfile.classic) * 0.03 + personaStreetBias * 0.16;
      score -= refinedDemand * 0.34 + promptProfile.minimal * 0.22;
    }
    if (isAthleticShoeSubtype(sub)) {
      score += streetwearDemand * 0.08 + controls.sportTolerance * 0.06 + personaStreetBias * 0.22;
      score -= nonSportDemand * 0.46 + refinedDemand * 0.18;
    }
    if (isOpenCasualShoeSubtype(sub) || families.has('loungewear') || /\bslipper|slide|sandal|lounge\b/.test(text)) {
      score -= 0.32 + refinedDemand * 0.28 + streetwearDemand * 0.18 + nonSportDemand * 0.34;
      if (streetwearDemand > refinedDemand + 0.08) {
        score -= 0.18 + streetwearDemand * 0.26 + nonSportDemand * 0.18;
      }
    }
    if (/\bmule|mules|clog|clogs|birkenstock|boston eva\b/.test(text)) {
      score -= 0.22 + refinedDemand * 0.28 + promptProfile.classic * 0.12;
    }
    if (/\bhiking|mountain|trail|workwear|work boot|cowboy|ugg\b/.test(text)) {
      score += streetwearDemand * 0.02;
      score -= refinedDemand * 0.42 + nonSportDemand * 0.24 + promptProfile.minimal * 0.18;
    }
    if (/\bfootball|basketball|cleat|soccer|trainer\b/.test(text)) score -= 0.2 + nonSportDemand * 0.42;
    score += Math.max(0, itemProfile.streetwear - 0.45) * streetwearDemand * 0.12;
    score += Math.max(0, itemProfile.refined - 0.42) * refinedDemand * 0.16;
  } else {
    score += Math.max(0, itemProfile.classic - 0.45) * refinedDemand * 0.04;
    score += Math.max(0, itemProfile.streetwear - 0.45) * streetwearDemand * 0.04;
  }

  return score;
}

function slotRoleCompatibilityScore(
  slot: CategoryMain,
  item: ScoredItem['item'],
  promptProfile: SemanticAxisProfile | null | undefined,
  intent: PromptIntentV2,
  controls: RuntimeSemanticControls,
  anchorDominance?: AnchorStyleDominance,
): number {
  if (!promptProfile) return 0;
  const sub = canonicalizeSubtype(item.sub || '');
  const families = new Set(subtypeFamily(sub));
  const itemProfile = deriveItemSemanticAxisProfile(item);
  const broadOutfit = broadSemanticOutfitIntent(intent);
  const contextualOuterwear = intent.setting_context.length > 0 || intent.activity_context.length > 0 || intent.daypart_context.length > 0 || intent.occasion_tags.length > 0;
  const contextualRelaxedFootwear = intent.occasion_tags.includes('lounge') || intent.occasion_tags.includes('sleepwear');
  const colours = Array.from(new Set(item.colours || []));
  const text = itemSemanticText(item);
  const neutralColours = new Set(['black', 'white', 'grey', 'beige', 'brown']);
  const nonNeutralRatio = colours.length
    ? colours.filter((colour) => !neutralColours.has(colour)).length / colours.length
    : 0;
  const anchorRefined = (anchorDominance?.refined || 0) * (anchorDominance?.strength || 0);
  const anchorStreetwear = (anchorDominance?.streetwear || 0) * (anchorDominance?.strength || 0);
  const anchorSport = (anchorDominance?.sport || 0) * (anchorDominance?.strength || 0);
  const menGuard = intent.target_gender === 'men';
  const refinedEvening = refinedEveningIntent(intent, promptProfile);
  const gymContext = intent.sport_context === 'gym';
  const personaStreetBias = intent.semantic_subjects.some((subject) => subject.kind === 'persona')
    ? Math.max(0, promptProfile.streetwear + promptProfile.graphic * 0.55 - promptProfile.refined * 0.35) * 0.5
    : 0;
  const personaBrandTerms = personaSoftBrandTerms(intent, slot);
  const personaBrandHit = personaBrandTerms.some((term) => itemEntityHit(item, term) || itemKeywordHit(item, term));
  const personaSlotPreference = personaPrefersSlot(intent, slot);
  const structureDemand = Math.max(promptProfile.structured, promptProfile.classic, controls.structureRichness) + anchorRefined * 0.26;
  const polishDemand = Math.max(promptProfile.refined, promptProfile.understated, controls.rolePurityWeight) + anchorRefined * 0.62 - anchorStreetwear * 0.14 - personaStreetBias * 0.12;
  const expressiveDemand = Math.max(promptProfile.streetwear, promptProfile.sporty, promptProfile.graphic, controls.noiseTolerance) + anchorStreetwear * 0.78 + anchorSport * 0.22 + personaStreetBias;
  let score = 0;

  if (personaBrandHit) {
    score += 0.08 + Math.max(promptProfile.streetwear, promptProfile.refined, promptProfile.classic) * 0.06;
  }
  if (personaSlotPreference) {
    score += 0.04;
  }

  if (controls.paletteStrictness >= 0.42 && promptProfile.neutral >= 0.52 && nonNeutralRatio > 0.34) {
    score -= (nonNeutralRatio - 0.34) * (0.2 + controls.paletteStrictness * 0.35);
  }

  if (slot === 'top') {
    if (menGuard && /\b(ruffled|blouse|camisole|tie neck|tie-neck)\b/.test(text)) {
      score -= 0.36 + polishDemand * 0.34;
    }
    if (families.has('shirt_family')) score += 0.14 + structureDemand * 0.18 + polishDemand * 0.12;
    if (families.has('shirt_family') && expressiveDemand > polishDemand + 0.08 && !/\bgraphic|logo|washed|distressed|oversized|hoodie|tee|t-shirt\b/.test(text)) {
      score -= 0.16 + expressiveDemand * 0.26;
    }
    if (families.has('soft_top_layer')) score += 0.06 + Math.max(promptProfile.relaxed, promptProfile.minimal) * 0.1;
    if ((sub === 'cardigan' || sub === 'sweater' || sub === 'polo') && expressiveDemand > polishDemand + 0.08 && !/\bgraphic|logo|washed|distressed|oversized\b/.test(text)) {
      score -= 0.14 + expressiveDemand * 0.22;
    }
    if (isFormalSubtype(sub)) score += 0.08 + structureDemand * 0.14;
    if (sub === 'tshirt' || sub === 'hoodie' || sub === 'sweatshirt') {
      score += expressiveDemand * 0.08 + personaStreetBias * 0.16;
      score -= Math.max(0, polishDemand - promptProfile.streetwear * 0.45) * 0.5;
      score -= Math.max(0, structureDemand - promptProfile.relaxed * 0.5) * 0.18;
    }
    if (/\btank|sleeveless|camisole|crop top\b/.test(text)) {
      score -= 0.14 + Math.max(0, polishDemand - promptProfile.streetwear * 0.4) * 0.42;
    }
    if (/\bgraphic|logo|distressed\b/.test(text)) {
      score -= 0.08 + Math.max(promptProfile.minimal, promptProfile.understated) * 0.18;
    }
    if (gymContext) {
      if (/\bgym|training|workout|athletic|performance|sports bra|sport bra\b/.test(text)) score += 0.28;
      if (/\bfootball|soccer|basketball|jersey|kit|formula 1|f1|motorsport|racing\b/.test(text)) score -= 0.52 + expressiveDemand * 0.14;
    }
    if (families.has('outerwear_family') && broadOutfit && !contextualOuterwear) {
      score -= (0.12 + controls.rolePurityWeight * 0.18) * Math.max(0.55, 1 - controls.noiseTolerance * 0.5);
    }
    score += Math.max(0, itemProfile.structured - 0.45) * structureDemand * 0.18;
    score += Math.max(0, itemProfile.understated - 0.45) * polishDemand * 0.12;
  } else if (slot === 'bottom') {
    if (menGuard && /\blegging|leggings\b/.test(text)) {
      score -= 0.46 + polishDemand * 0.3 + expressiveDemand * 0.12;
    }
    if (refinedEvening && /\blegging|leggings\b/.test(text)) {
      score -= 0.54 + polishDemand * 0.34 + structureDemand * 0.12;
    }
    if (isFormalSubtype(sub)) score += 0.16 + structureDemand * 0.18 + polishDemand * 0.1;
    if ((sub === 'trousers' || sub === 'tailored trousers' || sub === 'dress pants') && refinedEvening) {
      score += 0.16;
    }
    if (anchorStreetwear > anchorRefined + 0.1 && isFormalSubtype(sub)) score -= 0.18 + anchorStreetwear * 0.34;
    if (families.has('denim')) {
      score += expressiveDemand * 0.08 - structureDemand * 0.12;
      score -= Math.max(0, polishDemand - promptProfile.streetwear * 0.55) * 0.28;
    }
    if (families.has('loungewear')) score -= 0.08 + controls.rolePurityWeight * 0.12;
    if (/\bcargo|track|jogger|short|sweat/i.test(sub)) {
      score -= 0.12 + controls.rolePurityWeight * 0.18 + Math.max(0, structureDemand - controls.noiseTolerance) * 0.1;
    }
    if (/\blegging|skirt\b/.test(text)) {
      score -= 0.16 + polishDemand * 0.14 + Math.max(0, expressiveDemand - promptProfile.relaxed) * 0.06;
    }
    if (gymContext) {
      if (/\bgym|training|workout|athletic|performance|legging|leggings|jogger|joggers|shorts\b/.test(text)) score += 0.24;
      if (/\bfootball|soccer|basketball|jersey|kit|formula 1|f1|motorsport|racing\b/.test(text)) score -= 0.56 + expressiveDemand * 0.16;
      if (/\bdenim|jean|jeans\b/.test(text)) score -= 0.16 + promptProfile.sporty * 0.08;
    }
    score += Math.max(0, itemProfile.structured - 0.45) * structureDemand * 0.2;
    score += Math.max(0, itemProfile.classic - 0.4) * polishDemand * 0.12;
  } else if (slot === 'shoes') {
    if (intent.sport_context !== 'none') {
      score += sportSpecificFootwearAdjustment(item, intent.sport_context);
    }
    if (menGuard && /\b(pump|pumps|heel|heels|stiletto|stilettos|slingback|slingbacks|mary jane|mary janes|tabi)\b/.test(text)) {
      score -= 0.54 + polishDemand * 0.32;
    }
    if (isSmartCasualShoeSubtype(sub) || isFormalSubtype(sub)) score += 0.14 + structureDemand * 0.15 + polishDemand * 0.12;
    if (personaStreetBias > 0.12 && (isSmartCasualShoeSubtype(sub) || isFormalSubtype(sub))) {
      score -= 0.18 + personaStreetBias * 0.22;
    }
    if (expressiveDemand > polishDemand + 0.08 && (isSmartCasualShoeSubtype(sub) || isFormalSubtype(sub))) {
      score -= 0.2 + expressiveDemand * 0.3 + Math.max(0, 0.26 - controls.sportTolerance) * 0.12;
    }
    if (anchorStreetwear > anchorRefined + 0.1 && (isSmartCasualShoeSubtype(sub) || isFormalSubtype(sub))) {
      score -= 0.2 + anchorStreetwear * 0.42 + anchorSport * 0.12;
    }
    if (families.has('boot_family')) {
      score += expressiveDemand * 0.08 - polishDemand * 0.14 + personaStreetBias * 0.14;
      score -= Math.max(0, polishDemand - promptProfile.streetwear * 0.55) * 0.28;
    }
    if (isAthleticShoeSubtype(sub) || isOpenCasualShoeSubtype(sub)) {
      score -= 0.12 + Math.max(0, polishDemand - controls.sportTolerance) * 0.24;
      if (personaStreetBias > 0.12 && isAthleticShoeSubtype(sub)) score += 0.26 + personaStreetBias * 0.16;
      if (expressiveDemand > polishDemand + 0.08) {
        score -= 0.14 + expressiveDemand * 0.24;
      }
    }
    if (isOpenCasualShoeSubtype(sub) && !contextualRelaxedFootwear) {
      score -= 0.12 + controls.slotRoleSpecificity * 0.18 + Math.max(0, structureDemand - promptProfile.relaxed) * 0.1 + Math.max(0, polishDemand - promptProfile.relaxed) * 0.08;
    }
    if (families.has('loungewear') && !contextualRelaxedFootwear) {
      score -= 0.06 + controls.slotRoleSpecificity * 0.12;
      if (expressiveDemand > polishDemand + 0.08) {
        score -= 0.12 + expressiveDemand * 0.22;
      }
    }
    if (/\bmule|mules|clog|clogs|birkenstock|boston eva\b/.test(text)) {
      score -= 0.18 + polishDemand * 0.22 + structureDemand * 0.08;
    }
    score += Math.max(0, itemProfile.refined - 0.42) * polishDemand * 0.14;
  } else {
    if (isFormalSubtype(sub)) score += 0.12 + polishDemand * 0.12;
    if (families.has('loungewear')) score -= 0.08 + controls.rolePurityWeight * 0.1;
    score += Math.max(0, itemProfile.minimal - 0.45) * Math.max(promptProfile.minimal, controls.aestheticPurity) * 0.14;
  }

  return score;
}

function semanticAdmissionScore(
  semanticBlend: number,
  axisAlignment: number,
  mismatchPenalty: number,
  roleFit: number,
  familyFit: number,
  cleanliness: number,
  anchorPreservation: number,
  controls: RuntimeSemanticControls,
): number {
  const normalizedBlend = Math.max(0, Math.min(1, 0.5 + semanticBlend / 4));
  const normalizedMismatch = Math.max(0, Math.min(1, mismatchPenalty / 1.75));
  return Math.max(
    0,
    Math.min(
      1,
      (normalizedBlend * 0.34) +
        (axisAlignment * 0.24) +
        ((0.5 + roleFit) * 0.22) +
        ((0.5 + familyFit) * 0.14) +
        (cleanliness * 0.28) -
        (Math.max(0, 0.58 - anchorPreservation) * (0.16 + controls.explicitConstraintStrength * 0.22)) +
        (anchorPreservation * (0.08 + controls.explicitConstraintStrength * 0.18)) -
        (normalizedMismatch * (0.22 + controls.rolePurityWeight * 0.18)),
    ),
  );
}

export class CandidateRanker {
  private readonly baseRanker = new BaseCandidateRanker();
  private frontierDiagnostics: CandidateFrontierDiagnostics = {
    semantic_frontier_share: 0,
    semantic_candidate_source: {},
    slot_semantic_viability: {},
    slot_semantic_valid_floor: {},
  };

  private requiredSlots(intent: PromptIntentV2): Set<CategoryMain> {
    const slots = intent.required_categories.length
      ? intent.required_categories
      : (intent.requested_slots.length ? intent.requested_slots : SLOT_ORDER);
    return new Set(slots);
  }

  private slotSemanticViability(
    candidates: ScoredItem[],
    slotProfile: SlotConstraintProfile,
    limit: number,
    required: boolean,
    controls: RuntimeSemanticControls,
  ): number {
    if (slotProfile.lockMode === 'exact' || slotProfile.lockMode === 'family') return 0;
    const clean = candidates.filter((candidate) =>
      (candidate.constraintCleanliness || 0) >= (controls.explicitConstraintStrength >= 0.28 ? 0.999 : 0.5) &&
      (!hasAnchoredConstraint(slotProfile) || (candidate.anchorPreservation || 0) >= 0.56),
    );
    if (!clean.length) return 0;
    const ordered = [...clean].sort((a, b) => ((b.semanticAdmission || 0) - (a.semanticAdmission || 0)) || ((b.roleFit || 0) - (a.roleFit || 0)));
    const sample = ordered.slice(0, Math.max(1, Math.min(6, Math.ceil(limit * 0.32))));
    const countTarget = required
      ? Math.max(2, Math.min(limit, Math.ceil(limit * 0.22)))
      : Math.max(1, Math.min(limit, Math.ceil(limit * 0.14)));
    const admissionCut = 0.26 + controls.rolePurityWeight * 0.08 + controls.explicitConstraintStrength * 0.04;
    const strong = clean.filter((candidate) => (candidate.semanticAdmission || 0) >= admissionCut);
    const meanAdmission = sample.reduce((sum, candidate) => sum + (candidate.semanticAdmission || 0), 0) / sample.length;
    const meanRoleFit = sample.reduce((sum, candidate) => sum + clamp01(0.5 + (candidate.roleFit || 0)), 0) / sample.length;
    const meanFamilyFit = sample.reduce((sum, candidate) => sum + clamp01(0.5 + (candidate.familyFit || 0)), 0) / sample.length;
    const meanCleanliness = sample.reduce((sum, candidate) => sum + (candidate.constraintCleanliness || 0), 0) / sample.length;
    const bestAdmission = ordered[0]?.semanticAdmission || 0;
    const availability = Math.min(1, clean.length / countTarget);
    const coverage = Math.min(1, strong.length / countTarget);
    return clamp01(
      (availability * 0.3) +
      (coverage * 0.22) +
      (bestAdmission * 0.18) +
      (meanAdmission * 0.18) +
      (meanRoleFit * 0.08) +
      (meanFamilyFit * 0.08) +
      (meanCleanliness * 0.04),
    );
  }

  private slotSemanticValidityFloor(
    viability: number,
    required: boolean,
    controls: RuntimeSemanticControls,
    slotProfile: SlotConstraintProfile,
  ): number {
    if (slotProfile.lockMode === 'exact' || slotProfile.lockMode === 'family') return 1;
    return clamp01(
      0.24 +
      controls.explicitConstraintStrength * 0.08 +
      controls.rolePurityWeight * 0.08 +
      (required ? 0.04 : 0) +
      (slotProfile.lockMode === 'broad' ? 0.03 : 0) -
      viability * (required ? 0.08 : 0.02),
    );
  }

  public buildSlotProfiles(
    intent: PromptIntentV2,
    items: any[],
    corpusStats?: SemanticCorpusStats | null,
  ): Record<CategoryMain, SlotConstraintProfile> {
    const profiles = this.baseRanker.buildSlotProfiles(intent, items, corpusStats || undefined);
    const brandTerms = brandCoverageTerms(intent);
    const targetBrandSlots = targetedBrandSlots(intent, items);
    for (const slot of SLOT_ORDER) {
      const subjects = semanticSubjectsForSlot(intent, slot);
      const nonBrandEntityPriors = Array.from(new Set(
        [
          ...intent.team_focus,
          ...subjects
            .filter((subject) => subject.kind === 'team' || subject.kind === 'item_line')
            .flatMap((subject) => [subject.label, ...(subject.soft_brand_priors || [])]),
        ]
          .map((value) => normalizeText(value || '').trim())
          .filter(Boolean),
      ));
      const includeBrandTerms =
        brandTerms.length > 0 &&
        (
          intent.brand_fit_mode === 'full_brand_coverage' ||
          (intent.brand_fit_mode === 'single_brand_presence' && targetBrandSlots.has(slot))
        );
      const entityPriors = Array.from(new Set([
        ...nonBrandEntityPriors,
        ...(includeBrandTerms ? brandTerms : []),
      ]));
      if (!entityPriors.length) continue;
      const profile = profiles[slot];
      profiles[slot] = {
        ...profile,
        preferred_entities: Array.from(new Set([...(profile.preferred_entities || []), ...entityPriors])),
        lockMode: includeBrandTerms && profile.lockMode === 'broad' ? 'attribute' : profile.lockMode,
        diversityExempt: (profile.lockMode === 'exact' || profile.variantMode === 'locked'),
      };
    }
    return profiles;
  }

  private subjectRichness(intent: PromptIntentV2, slot?: CategoryMain): number {
    const subjects = slot ? semanticSubjectsForSlot(intent, slot) : intent.semantic_subjects;
    if (!subjects.length) return 0;
    const tokenMass = subjects.reduce((sum, subject) => sum +
      subject.style_axes.length +
      subject.silhouette_terms.length +
      subject.palette_terms.length +
      subject.category_preferences.length +
      subject.soft_brand_priors.length, 0);
    return Math.min(1.8, 0.4 + subjects.length * 0.22 + tokenMass * 0.035);
  }

  private effectivePerRoleLimit(intent: PromptIntentV2, perRoleLimit: number, embeddingMode: EmbeddingMode): number {
    if (embeddingMode === 'off') return perRoleLimit;
    const semanticBoost = intent.semantic_subjects.length ? 10 : 0;
    const paletteBoost = intent.palette_mode !== 'unconstrained' ? 2 : 0;
    const broadBoost = intent.requested_slots.length >= 2 ? 6 : 3;
    const viabilityBoost = broadSemanticOutfitIntent(intent) ? 8 : 0;
    return perRoleLimit + semanticBoost + paletteBoost + broadBoost + viabilityBoost;
  }

  private semanticPoolLimit(intent: PromptIntentV2, perRoleLimit: number): number {
    return perRoleLimit + 18 + Math.round(this.subjectRichness(intent) * 10) + (broadSemanticOutfitIntent(intent) ? 10 : 0);
  }

  private semanticFrontierQuota(
    intent: PromptIntentV2,
    slot: CategoryMain,
    slotProfile: SlotConstraintProfile,
    promptEmbeddings: PromptEmbeddingState,
    limit: number,
  ): number {
    const informativeness = Math.max(0, Math.min(1, promptEmbeddings.semanticInformativeness ?? 0));
    if (informativeness < 0.58) return 0;
    if (slotProfile.lockMode === 'exact' || slotProfile.lockMode === 'family') return 0;
    const semanticDemand = semanticSubjectsForSlot(intent, slot).length > 0 || broadSemanticOutfitIntent(intent);
    if (!semanticDemand) return 0;
    const ratio =
      (slotProfile.lockMode === 'broad' ? 0.18 : 0.12) +
      (broadSemanticOutfitIntent(intent) ? 0.08 : 0) +
      (semanticSubjectsForSlot(intent, slot).length ? 0.06 : 0) +
      informativeness * 0.08;
    return Math.max(2, Math.min(Math.max(2, limit - 1), Math.round(limit * Math.min(0.4, ratio))));
  }

  private directSemanticScore(
    itemId: string,
    slot: CategoryMain,
    promptEmbeddings: PromptEmbeddingState,
    embeddings: LoadedEmbeddings,
  ): { style: number; identity: number; general: number } {
    const promptGeneral = promptEmbeddings.slotPromptVectors[slot] || promptEmbeddings.promptVector;
    const promptIdentity = promptEmbeddings.slotIdentityVectors[slot] || promptEmbeddings.identityVector || promptGeneral;
    const promptStyle = promptEmbeddings.slotStyleVectors[slot] || promptEmbeddings.styleVector || promptGeneral;
    const itemGeneral = embeddings.slotVectors[slot].get(itemId) || embeddings.itemVectors.get(itemId) || [];
    const itemIdentity = embeddings.slotIdentityVectors[slot].get(itemId) || embeddings.identityVectors.get(itemId) || itemGeneral;
    const itemStyle = embeddings.slotStyleVectors[slot].get(itemId) || embeddings.styleVectors.get(itemId) || itemGeneral;
    return {
      style: promptStyle.length && itemStyle.length ? cosineSimilarity(promptStyle, itemStyle) : 0,
      identity: promptIdentity.length && itemIdentity.length ? cosineSimilarity(promptIdentity, itemIdentity) : 0,
      general: promptGeneral.length && itemGeneral.length ? cosineSimilarity(promptGeneral, itemGeneral) : 0,
    };
  }

  private semanticWeights(
    intent: PromptIntentV2,
    slot: CategoryMain,
    slotProfile: SlotConstraintProfile,
    promptEmbeddings: PromptEmbeddingState,
    controls: RuntimeSemanticControls,
  ) {
    const scopedSubjects = semanticSubjectsForSlot(intent, slot);
    const subjectKinds = new Set(scopedSubjects.map((subject) => subject.kind));
    const informativeness = Math.max(0, Math.min(1, promptEmbeddings.semanticInformativeness ?? 0));
    const lockBase =
      slotProfile.lockMode === 'exact'
        ? 0.16
        : slotProfile.lockMode === 'family'
          ? 0.38
          : slotProfile.lockMode === 'attribute'
            ? 0.82
            : 1.18;
    const richness = this.subjectRichness(intent, slot);
    let style = 0.68 * lockBase + richness * 0.34;
    let identity = 0.34 * lockBase + richness * 0.16;
    let general = 0.22 * lockBase + richness * 0.12;
    if (subjectKinds.has('persona') || subjectKinds.has('style_archetype') || subjectKinds.has('theme')) {
      style += 0.42;
      general += 0.18;
    }
    if (subjectKinds.has('brand') || subjectKinds.has('team') || subjectKinds.has('item_line')) {
      identity += 0.38;
    }
    style *= 0.88 + informativeness * 0.28 + controls.semanticExpansionStrength * 0.34;
    general *= 0.94 + informativeness * 0.06;
    identity *= 0.94 + informativeness * 0.08;
    if (broadSemanticOutfitIntent(intent)) {
      style *= 0.76 + controls.semanticExpansionStrength * 0.24;
      identity *= 0.9 + controls.explicitConstraintStrength * 0.06;
      general *= 0.88 + controls.slotRoleSpecificity * 0.04;
    }
    return { style, identity, general };
  }

  private rerankSlotCandidates(
    slot: CategoryMain,
    candidates: ScoredItem[],
    intent: PromptIntentV2,
    slotProfile: SlotConstraintProfile,
    slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
    promptEmbeddings: PromptEmbeddingState,
    embeddings: LoadedEmbeddings,
    embeddingMode: EmbeddingMode,
    slotSemanticViability = 0,
    requiredSlot = false,
    slotSemanticFloor = 1,
  ): ScoredItem[] {
    if (embeddingMode === 'off' || !promptEmbeddings.available) return candidates;
    const scopedSubjects = semanticSubjectsForSlot(intent, slot);
    const informativeness = Math.max(0, Math.min(1, promptEmbeddings.semanticInformativeness ?? 0));
    const controls = deriveRuntimeSemanticControls(intent, promptEmbeddings.semanticAxisProfile, informativeness);
    const regime = promptRegime(intent, controls, informativeness);
    const anchorDominance = deriveAnchorStyleDominance(slot, slotProfiles, intent, promptEmbeddings.semanticAxisProfile);
    const semanticDiscipline = clamp01(
      controls.rolePurityWeight * 0.62 +
      controls.structureRichness * 0.18 +
      (1 - controls.sportTolerance) * 0.14 -
      controls.noiseTolerance * 0.16,
    );
    const weights = this.semanticWeights(intent, slot, slotProfile, promptEmbeddings, controls);
    let modeFactor =
      embeddingMode === 'hybrid'
        ? (0.84 + controls.semanticExpansionStrength * 0.38 - controls.explicitConstraintStrength * 0.08)
        : (0.68 + controls.semanticExpansionStrength * 0.08 - controls.explicitConstraintStrength * 0.04);
    if (embeddingMode === 'hybrid' && regime === 'constraint_dominant') {
      modeFactor = 0.68 + controls.semanticExpansionStrength * 0.08 - controls.explicitConstraintStrength * 0.04;
    }
    if (embeddingMode === 'hybrid' && regime === 'semantic_dominant') {
      modeFactor += 0.04;
    }
    if (embeddingMode === 'hybrid' && broadSemanticOutfitIntent(intent)) {
      modeFactor = 0.8 + controls.semanticExpansionStrength * 0.34 - controls.explicitConstraintStrength * 0.1;
      if (regime === 'constraint_dominant') {
        modeFactor = 0.68 + controls.semanticExpansionStrength * 0.08 - controls.explicitConstraintStrength * 0.04;
      } else if (regime === 'semantic_dominant') {
        modeFactor += 0.05;
      }
    }
    const semanticStageRelief =
      embeddingMode === 'hybrid' &&
      (slotProfile.lockMode === 'broad' || slotProfile.lockMode === 'attribute') &&
      slotSemanticViability >= 0.32
        ? Math.min(
            0.26,
            slotSemanticViability * 0.16 +
            controls.semanticExpansionStrength * 0.08 +
            (requiredSlot ? 0.04 : 0),
          )
        : 0;
    const stageProtectionGap = Math.max(
      0.28,
      1.8 -
        controls.stageProtectionRelaxation * 1.05 +
        controls.explicitConstraintStrength * 0.55 -
        ((slotProfile.lockMode === 'broad' || slotProfile.lockMode === 'attribute') ? slotSemanticViability * (requiredSlot ? (0.95 * semanticDiscipline) : 0.55) : 0) -
        semanticStageRelief -
        (
          embeddingMode === 'hybrid' &&
          broadSemanticOutfitIntent(intent) &&
          requiredSlot &&
          regime === 'semantic_dominant'
            ? (0.18 + slotSemanticViability * 0.24 + semanticDiscipline * 0.08)
            : 0
        ),
    );

    return [...candidates]
      .map((candidate) => {
        const semantic = this.directSemanticScore(candidate.item.id, slot, promptEmbeddings, embeddings);
        const itemAxes = deriveItemSemanticAxisProfile(candidate.item);
        const axisAlignment = semanticAxisAlignment(promptEmbeddings.semanticAxisProfile, itemAxes);
        const purityCorrection = (axisAlignment - 0.52) * (0.85 + informativeness * 0.75);
        const slotRequirementWeight = requiredSlot
          ? semanticDiscipline * (0.18 + slotSemanticViability * 0.34)
          : (0.08 + slotSemanticViability * 0.12);
        const mismatchPenalty = semanticMismatchPenalty(promptEmbeddings.semanticAxisProfile, itemAxes) * (0.24 + informativeness * 0.92 + slotRequirementWeight);
        const roleCompatibility = slotRoleCompatibilityScore(slot, candidate.item, promptEmbeddings.semanticAxisProfile, intent, controls, anchorDominance) * (0.18 + controls.rolePurityWeight * 0.62 + slotRequirementWeight * 0.8);
        const familyFit = slotFamilyFitScore(slot, candidate.item, promptEmbeddings.semanticAxisProfile, intent, controls, anchorDominance);
        const familyFitBoost = familyFit * (0.28 + controls.slotRoleSpecificity * 0.28 + slotRequirementWeight * 0.7);
        const cleanliness = constraintCleanliness(candidate);
        const anchorPreservation = anchorPreservationScore(candidate.item, slotProfile);
        const semanticBlend =
          (semantic.style * weights.style) +
          (semantic.identity * weights.identity) +
          (semantic.general * weights.general) +
          purityCorrection -
          mismatchPenalty +
          roleCompatibility +
          familyFitBoost;
        const subjectBoost = scopedSubjects.length ? 1 + Math.min(0.8, this.subjectRichness(intent, slot) * 0.3) : 1;
        const admission = semanticAdmissionScore(
          semanticBlend,
          axisAlignment,
          mismatchPenalty,
          roleCompatibility,
          familyFit,
          cleanliness,
          anchorPreservation,
          controls,
        );
        const constraintPenalty =
          cleanliness < 1
            ? (0.8 + controls.explicitConstraintStrength * 8.5)
            : 0;
        const anchorPenalty =
          hasAnchoredConstraint(slotProfile) && anchorPreservation < 0.5
            ? (0.5 - anchorPreservation) * (1.8 + controls.explicitConstraintStrength * 2.6)
            : 0;
        const requiredSemanticLift =
          requiredSlot &&
          (slotProfile.lockMode === 'broad' || slotProfile.lockMode === 'attribute') &&
          slotSemanticViability >= 0.42
            ? Math.max(0, admission - Math.max(0.22, slotSemanticFloor - 0.08)) *
                (0.9 + controls.semanticExpansionStrength * 1.1 + controls.rolePurityWeight * 0.8 + slotSemanticViability * 1.3) +
              Math.max(0, roleCompatibility) * (0.18 + slotSemanticViability * 0.34) +
              Math.max(0, familyFit) * (0.22 + slotSemanticViability * 0.42)
            : 0;
        const requiredSemanticDeficitPenalty =
          requiredSlot &&
          (slotProfile.lockMode === 'broad' || slotProfile.lockMode === 'attribute') &&
          slotSemanticViability >= 0.42
            ? Math.max(0, slotSemanticFloor - admission) *
              (0.8 + controls.semanticExpansionStrength * 1.45 + controls.rolePurityWeight * 0.95 + slotSemanticViability * 1.25)
            : 0;
        const roleFloorTarget =
          requiredSlot &&
          embeddingMode === 'hybrid' &&
          (slotProfile.lockMode === 'broad' || slotProfile.lockMode === 'attribute') &&
          slotSemanticViability >= 0.42
            ? clamp01(
                0.52 +
                slotSemanticViability * 0.14 +
                controls.rolePurityWeight * 0.1 +
                (((slot === 'bottom' || slot === 'shoes') && anchorDominance.streetwear > anchorDominance.refined + 0.08) ? (anchorDominance.strength * 0.06) : 0) +
                (((slot === 'top' || slot === 'bottom') && anchorDominance.refined > anchorDominance.streetwear + 0.08) ? (anchorDominance.strength * 0.05) : 0) +
                ((slot === 'top' || slot === 'bottom' || slot === 'shoes') ? 0.02 : 0),
              )
            : 0;
        const familyFloorTarget =
          requiredSlot &&
          embeddingMode === 'hybrid' &&
          (slotProfile.lockMode === 'broad' || slotProfile.lockMode === 'attribute') &&
          slotSemanticViability >= 0.42
            ? clamp01(
                0.52 +
                slotSemanticViability * 0.16 +
                controls.rolePurityWeight * 0.08 +
                (((slot === 'bottom' || slot === 'shoes') && anchorDominance.streetwear > anchorDominance.refined + 0.08) ? (anchorDominance.strength * 0.07) : 0) +
                (((slot === 'top' || slot === 'bottom') && anchorDominance.refined > anchorDominance.streetwear + 0.08) ? (anchorDominance.strength * 0.06) : 0) +
                ((slot === 'top' || slot === 'bottom' || slot === 'shoes') ? 0.03 : 0),
              )
            : 0;
        const normalizedRoleFit = clamp01(0.5 + roleCompatibility);
        const normalizedFamilyFit = clamp01(0.5 + familyFit);
        const roleFloorLift =
          roleFloorTarget > 0
            ? Math.max(0, normalizedRoleFit - roleFloorTarget) *
              (0.2 + controls.rolePurityWeight * 0.42 + slotSemanticViability * 0.36)
            : 0;
        const familyFloorLift =
          familyFloorTarget > 0
            ? Math.max(0, normalizedFamilyFit - familyFloorTarget) *
              (0.26 + controls.rolePurityWeight * 0.38 + slotSemanticViability * 0.42)
            : 0;
        const roleFloorDeficitPenalty =
          roleFloorTarget > 0
            ? Math.max(0, roleFloorTarget - normalizedRoleFit) *
              (1.4 + controls.rolePurityWeight * 1.55 + slotSemanticViability * 1.9)
            : 0;
        const familyFloorDeficitPenalty =
          familyFloorTarget > 0
            ? Math.max(0, familyFloorTarget - normalizedFamilyFit) *
              (1.6 + controls.rolePurityWeight * 1.6 + slotSemanticViability * 2.05)
            : 0;
        const weakAdmissionPenalty =
          embeddingMode === 'hybrid' && controls.semanticExpansionStrength >= 0.3 && admission < (requiredSlot ? (0.4 + semanticDiscipline * 0.06) : 0.4)
            ? ((requiredSlot ? (0.4 + semanticDiscipline * 0.06) : 0.4) - admission) * (1.6 + controls.rolePurityWeight * 1.8 + slotSemanticViability * (requiredSlot ? (2.2 * semanticDiscipline) : 0.8))
            : 0;
        return {
          ...candidate,
          semantic: semanticBlend,
          constraintCleanliness: cleanliness,
          semanticAdmission: admission,
          roleFit: roleCompatibility,
          anchorPreservation,
          familyFit,
          score:
            candidate.symbolic +
            (semanticBlend * modeFactor * subjectBoost) +
            requiredSemanticLift -
            roleFloorDeficitPenalty -
            familyFloorDeficitPenalty -
            constraintPenalty -
            anchorPenalty -
            requiredSemanticDeficitPenalty -
            weakAdmissionPenalty +
            roleFloorLift +
            familyFloorLift,
        };
      })
      .sort((a, b) => {
        if (a.stage !== b.stage) {
          const scoreGap = Math.abs((b.score || 0) - (a.score || 0));
          if (scoreGap < stageProtectionGap) return a.stage - b.stage;
        }
        if ((b.constraintCleanliness || 0) !== (a.constraintCleanliness || 0)) return (b.constraintCleanliness || 0) - (a.constraintCleanliness || 0);
        if ((b.anchorPreservation || 0) !== (a.anchorPreservation || 0)) return (b.anchorPreservation || 0) - (a.anchorPreservation || 0);
        if ((b.semanticAdmission || 0) !== (a.semanticAdmission || 0)) return (b.semanticAdmission || 0) - (a.semanticAdmission || 0);
        if (b.score !== a.score) return b.score - a.score;
        if (b.semantic !== a.semantic) return b.semantic - a.semantic;
        return b.symbolic - a.symbolic;
      });
  }

  private semanticFrontierEligible(intent: PromptIntentV2, slot: CategoryMain, slotProfile: SlotConstraintProfile, promptEmbeddings: PromptEmbeddingState): boolean {
    if (!promptEmbeddings.available) return false;
    if (slotProfile.lockMode === 'exact' || slotProfile.lockMode === 'family') return false;
    if (slotProfile.diversityExempt && slotProfile.lockMode !== 'broad') return false;
    return slotProfile.lockMode === 'broad' || slotProfile.lockMode === 'attribute' || semanticSubjectsForSlot(intent, slot).length > 0;
  }

  private hybridDivergenceBudget(
    intent: PromptIntentV2,
    slotProfile: SlotConstraintProfile,
    controls: RuntimeSemanticControls,
    slotViability: number,
    requiredSlot: boolean,
    informativeness: number,
  ): number {
    if (slotProfile.lockMode === 'exact' || slotProfile.lockMode === 'family') return 0;
    const regime = promptRegime(intent, controls, informativeness);
    if (regime === 'constraint_dominant') return 0;
    const broadness = slotProfile.lockMode === 'broad' ? 0.16 : (slotProfile.lockMode === 'attribute' ? 0.1 : 0.04);
    const multiSlot = (intent.requested_slots.length ? intent.requested_slots : SLOT_ORDER).length >= 2 ? 0.06 : 0;
    return clamp01(
      (informativeness * 0.22) +
      (controls.semanticExpansionStrength * 0.24) +
      (slotViability * 0.32) +
      (controls.rolePurityWeight * 0.08) +
      broadness +
      multiSlot +
      (requiredSlot ? 0.08 : 0.03) -
      (regime === 'mixed' ? 0.04 : 0) -
      (controls.explicitConstraintStrength * 0.24) -
      (Math.max(0, controls.noiseTolerance - controls.structureRichness) * 0.08),
    );
  }

  private rerankSuperiorityDelta(
    candidate: ScoredItem,
    baseline: ScoredItem,
    slotProfile: SlotConstraintProfile,
    controls: RuntimeSemanticControls,
  ): number {
    const candidateClean = candidate.constraintCleanliness ?? 1;
    const baselineClean = baseline.constraintCleanliness ?? 1;
    if (candidateClean + 0.001 < baselineClean) return Number.NEGATIVE_INFINITY;
    const candidateAnchor = candidate.anchorPreservation ?? 1;
    const baselineAnchor = baseline.anchorPreservation ?? 1;
    if (hasAnchoredConstraint(slotProfile) && candidateAnchor + 0.001 < baselineAnchor) return Number.NEGATIVE_INFINITY;
    const admissionDelta = (candidate.semanticAdmission ?? 0.5) - (baseline.semanticAdmission ?? 0.5);
    const roleFitDelta = (candidate.roleFit ?? 0) - (baseline.roleFit ?? 0);
    const familyFitDelta = (candidate.familyFit ?? 0) - (baseline.familyFit ?? 0);
    const semanticDelta = (candidate.semantic ?? 0) - (baseline.semantic ?? 0);
    const scoreDelta = (candidate.score ?? 0) - (baseline.score ?? 0);
    return (
      (admissionDelta * (1.85 + controls.semanticExpansionStrength * 0.7)) +
      (roleFitDelta * (1.2 + controls.rolePurityWeight * 0.65)) +
      (familyFitDelta * (1.45 + controls.slotRoleSpecificity * 0.6 + controls.rolePurityWeight * 0.5)) +
      (semanticDelta * 0.08) +
      (scoreDelta * 0.03) +
      ((candidateClean - baselineClean) * (0.45 + controls.explicitConstraintStrength * 0.35)) +
      ((candidateAnchor - baselineAnchor) * 0.35)
    );
  }

  private selectNovelSemanticCandidates(candidates: ScoredItem[], count: number): ScoredItem[] {
    const selected: ScoredItem[] = [];
    const seenFamilies = new Set<string>();
    const seenBrands = new Set<string>();
    const seenColours = new Set<string>();
    for (const candidate of [...candidates].sort((a, b) => ((b.semanticAdmission || 0) - (a.semanticAdmission || 0)) || (b.semantic - a.semantic))) {
      const familyNovel = candidate.family && !seenFamilies.has(candidate.family);
      const brandNovel = candidate.brandKey && !seenBrands.has(candidate.brandKey);
      const colourNovel = candidate.colourFamily && !seenColours.has(candidate.colourFamily);
      if (selected.length < count && (familyNovel || brandNovel || colourNovel || selected.length < Math.max(2, Math.ceil(count / 2)))) {
        selected.push(candidate);
        if (candidate.family) seenFamilies.add(candidate.family);
        if (candidate.brandKey) seenBrands.add(candidate.brandKey);
        if (candidate.colourFamily) seenColours.add(candidate.colourFamily);
      }
      if (selected.length >= count) break;
    }
    return selected;
  }

  private semanticPromptFuzziness(
    intent: PromptIntentV2,
    slot: CategoryMain,
    slotProfile: SlotConstraintProfile,
    promptEmbeddings: PromptEmbeddingState,
    controls: RuntimeSemanticControls,
  ): number {
    const subjects = semanticSubjectsForSlot(intent, slot);
    const subjectWeight = subjects.reduce((sum, subject) => sum + semanticSemanticKindWeight(subject.kind), 0);
    const broadness = broadSemanticOutfitIntent(intent) ? 0.16 : 0;
    const vibeWeight = Math.min(0.14, intent.vibe_tags.length * 0.03);
    const occasionWeight = Math.min(0.08, intent.occasion_tags.length * 0.02);
    const multiSlot = requestedSlotsForIntent(intent).length >= 2 ? 0.06 : 0;
    const informativeness = clamp01(promptEmbeddings.semanticInformativeness ?? 0);
    const explicitness = slotProfileExplicitness(slotProfile);
    return clamp01(
      0.08 +
      Math.min(0.32, subjectWeight) +
      broadness +
      vibeWeight +
      occasionWeight +
      multiSlot +
      informativeness * 0.16 +
      controls.semanticExpansionStrength * 0.14 -
      explicitness * 0.48 -
      controls.explicitConstraintStrength * 0.1,
    );
  }

  private symbolicSlotConfidence(
    rerankBaseline: ScoredItem[],
    limit: number,
  ): number {
    if (!rerankBaseline.length) return 0;
    const leader = rerankBaseline[0]!;
    const runnerUp = rerankBaseline[1] || null;
    const scoreGap = runnerUp ? Math.max(0, (leader.score || 0) - (runnerUp.score || 0)) : 1;
    const normalizedGap = clamp01(scoreGap / 2.4);
    const admission = clamp01(leader.semanticAdmission ?? 0.5);
    const cleanliness = clamp01(leader.constraintCleanliness ?? 1);
    const anchor = clamp01(leader.anchorPreservation ?? 1);
    const availability = clamp01(rerankBaseline.length / Math.max(1, Math.min(limit, 6)));
    const roleFit = clamp01(0.5 + (leader.roleFit || 0));
    const familyFit = clamp01(0.5 + (leader.familyFit || 0));
    return clamp01(
      admission * 0.24 +
      cleanliness * 0.16 +
      anchor * 0.16 +
      normalizedGap * 0.16 +
      availability * 0.12 +
      roleFit * 0.08 +
      familyFit * 0.08,
    );
  }

  private semanticNoveltyScore(candidate: ScoredItem, baseline: ScoredItem[]): number {
    const familySet = new Set(baseline.map((entry) => entry.family).filter(Boolean));
    const brandSet = new Set(baseline.map((entry) => entry.brandKey).filter(Boolean));
    const colourSet = new Set(baseline.map((entry) => entry.colourFamily).filter(Boolean));
    const subSet = new Set(baseline.map((entry) => canonicalizeSubtype(entry.item.sub || '')).filter(Boolean));
    let score = 0;
    if (candidate.family && !familySet.has(candidate.family)) score += 0.42;
    if (candidate.brandKey && !brandSet.has(candidate.brandKey)) score += 0.2;
    if (candidate.colourFamily && !colourSet.has(candidate.colourFamily)) score += 0.16;
    const sub = canonicalizeSubtype(candidate.item.sub || '');
    if (sub && !subSet.has(sub)) score += 0.22;
    return clamp01(score);
  }

  private semanticFallbackViability(
    candidates: ScoredItem[],
    limit: number,
    required: boolean,
    explorationBias: number,
  ): number {
    if (!candidates.length || explorationBias < 0.18) return 0;
    const ordered = [...candidates].sort((a, b) =>
      ((b.semanticAdmission || 0) - (a.semanticAdmission || 0)) ||
      ((b.roleFit || 0) - (a.roleFit || 0)) ||
      ((b.score || 0) - (a.score || 0))
    );
    const sample = ordered.slice(0, Math.max(1, Math.min(4, Math.ceil(limit * 0.24))));
    const countTarget = required
      ? Math.max(1, Math.min(limit, Math.ceil(limit * 0.18)))
      : Math.max(1, Math.min(limit, Math.ceil(limit * 0.12)));
    const availability = Math.min(1, ordered.length / countTarget);
    const meanAdmission = sample.reduce((sum, candidate) => sum + (candidate.semanticAdmission || 0), 0) / sample.length;
    const meanRoleFit = sample.reduce((sum, candidate) => sum + clamp01(0.5 + (candidate.roleFit || 0)), 0) / sample.length;
    const meanFamilyFit = sample.reduce((sum, candidate) => sum + clamp01(0.5 + (candidate.familyFit || 0)), 0) / sample.length;
    const bestAdmission = ordered[0]?.semanticAdmission || 0;
    return clamp01(
      availability * 0.34 +
      bestAdmission * 0.24 +
      meanAdmission * 0.2 +
      meanRoleFit * 0.12 +
      meanFamilyFit * 0.1,
    ) * explorationBias;
  }

  private buildHybridFrontier(
    slot: CategoryMain,
    symbolic: ScoredItem[],
    semanticPool: ScoredItem[],
    intent: PromptIntentV2,
    slotProfile: SlotConstraintProfile,
    slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
    promptEmbeddings: PromptEmbeddingState,
    embeddings: LoadedEmbeddings,
    limit: number,
  ): { candidates: ScoredItem[]; source: 'symbolic' | 'semantic_union' | 'mixed'; share: number; viability: number; validityFloor: number } {
    const symbolicTop = uniqueById(symbolic).slice(0, Math.max(limit, 1));
    const semanticTop = uniqueById(semanticPool);
    const symbolicIds = new Set(symbolicTop.map((candidate) => candidate.item.id));
    const semanticOnlySeedCount = semanticTop.filter((candidate) => !symbolicIds.has(candidate.item.id)).length;
    const semanticSeedBias = clamp01(
      semanticOnlySeedCount /
      Math.max(1, Math.ceil(limit * 0.16)),
    );
    const informativeness = Math.max(0, Math.min(1, promptEmbeddings.semanticInformativeness ?? 0));
    const controls = deriveRuntimeSemanticControls(intent, promptEmbeddings.semanticAxisProfile, informativeness);
    const regime = promptRegime(intent, controls, informativeness);
    const anchorDominance = deriveAnchorStyleDominance(slot, slotProfiles, intent, promptEmbeddings.semanticAxisProfile);
    const rerankBaseline = this.rerankSlotCandidates(slot, symbolicTop, intent, slotProfile, slotProfiles, promptEmbeddings, embeddings, 'rerank').slice(0, limit);
    const semanticDiscipline = clamp01(
      controls.rolePurityWeight * 0.62 +
      controls.structureRichness * 0.18 +
      (1 - controls.sportTolerance) * 0.14 -
      controls.noiseTolerance * 0.16,
    );
    const requiredSlots = this.requiredSlots(intent);
    const requiredSlot = requiredSlots.has(slot);
    if (!this.semanticFrontierEligible(intent, slot, slotProfile, promptEmbeddings)) {
      return {
        candidates: rerankBaseline,
        source: 'symbolic',
        share: 0,
        viability: 0,
        validityFloor: 1,
      };
    }
    const viabilityFirst = broadSemanticOutfitIntent(intent);
    let semanticQuota = this.semanticFrontierQuota(intent, slot, slotProfile, promptEmbeddings, limit);
    const floorRatio = viabilityFirst
      ? Math.max(0.46, 0.7 - informativeness * 0.18)
      : Math.max(0.42, 0.55 - informativeness * 0.1);
    let symbolicFloor = viabilityFirst
      ? Math.min(symbolicTop.length, Math.max(6, Math.min(Math.max(4, limit - semanticQuota), Math.ceil(limit * floorRatio))))
      : Math.min(symbolicTop.length, Math.max(3, Math.min(Math.max(3, limit - semanticQuota), Math.ceil(limit * floorRatio))));
    if (viabilityFirst && symbolicTop.length < Math.max(4, Math.ceil(limit * 0.45))) {
      return {
        candidates: rerankBaseline,
        source: 'symbolic',
        share: 0,
        viability: 0,
        validityFloor: 1,
      };
    }

    const semanticEvaluated = uniqueById(semanticPool)
      .map((candidate) => {
        const direct = this.directSemanticScore(candidate.item.id, slot, promptEmbeddings, embeddings);
        const weights = this.semanticWeights(intent, slot, slotProfile, promptEmbeddings, controls);
        const itemAxes = deriveItemSemanticAxisProfile(candidate.item);
        const axisAlignment = semanticAxisAlignment(promptEmbeddings.semanticAxisProfile, itemAxes);
        const purityCorrection = (axisAlignment - 0.52) * (0.85 + informativeness * 0.75);
        const mismatchPenalty = semanticMismatchPenalty(promptEmbeddings.semanticAxisProfile, itemAxes) * (0.24 + informativeness * 0.92);
        const roleCompatibility = slotRoleCompatibilityScore(slot, candidate.item, promptEmbeddings.semanticAxisProfile, intent, controls, anchorDominance) * (0.18 + controls.rolePurityWeight * 0.62);
        const familyFit = slotFamilyFitScore(slot, candidate.item, promptEmbeddings.semanticAxisProfile, intent, controls, anchorDominance);
        const familyFitBoost = familyFit * (0.28 + controls.slotRoleSpecificity * 0.28);
        const cleanliness = constraintCleanliness(candidate);
        const anchorPreservation = anchorPreservationScore(candidate.item, slotProfile);
        const semanticBlend =
          (direct.style * weights.style) +
          (direct.identity * weights.identity) +
          (direct.general * weights.general) +
          purityCorrection -
          mismatchPenalty +
          roleCompatibility +
          familyFitBoost;
        const admission = semanticAdmissionScore(
          semanticBlend,
          axisAlignment,
          mismatchPenalty,
          roleCompatibility,
          familyFit,
          cleanliness,
          anchorPreservation,
          controls,
        );
        return {
          ...candidate,
          directSemantic: direct,
          semantic: semanticBlend,
          constraintCleanliness: cleanliness,
          semanticAdmission: admission,
          roleFit: roleCompatibility,
          anchorPreservation,
          familyFit,
          score: candidate.symbolic + semanticBlend - ((1 - cleanliness) * (1.4 + controls.explicitConstraintStrength * 6)),
        };
      });
    const promptFuzziness = this.semanticPromptFuzziness(intent, slot, slotProfile, promptEmbeddings, controls);
    const symbolicConfidence = this.symbolicSlotConfidence(rerankBaseline, limit);
    const weakSymbolicConfidence = Math.max(0, 0.7 - symbolicConfidence);
    const semanticExplorationBias = clamp01(
      promptFuzziness * 0.66 +
      weakSymbolicConfidence * 0.38 +
      (regime === 'semantic_dominant' ? 0.1 : 0) -
      (regime === 'constraint_dominant' ? 0.2 : 0),
    );
    const baseSlotViability = this.slotSemanticViability(semanticEvaluated, slotProfile, limit, requiredSlot, controls);
    const provisionalAdmissionThreshold = this.slotSemanticValidityFloor(baseSlotViability, requiredSlot, controls, slotProfile);
    const fallbackRoleFitFloor = requiredSlot ? 0.42 : 0;
    const fallbackFamilyFitFloor = requiredSlot ? 0.42 : 0;
    const fallbackAdmissionThreshold = clamp01(
      Math.max(
        0.14,
        provisionalAdmissionThreshold - (0.12 + semanticExplorationBias * 0.08 + weakSymbolicConfidence * 0.04),
      ),
    );
    const fallbackSemantic = semanticEvaluated.filter((candidate) =>
      (candidate.constraintCleanliness || 0) >= (controls.explicitConstraintStrength >= 0.28 ? 0.999 : 0.5) &&
      (!hasAnchoredConstraint(slotProfile) || (candidate.anchorPreservation || 0) >= Math.max(0.44, 0.56 - semanticExplorationBias * 0.12)) &&
      (candidate.semanticAdmission || 0) >= fallbackAdmissionThreshold &&
      (fallbackRoleFitFloor <= 0 || clamp01(0.5 + (candidate.roleFit || 0)) >= fallbackRoleFitFloor) &&
      (fallbackFamilyFitFloor <= 0 || clamp01(0.5 + (candidate.familyFit || 0)) >= fallbackFamilyFitFloor),
    );
    const slotViability = Math.max(
      baseSlotViability,
      this.semanticFallbackViability(fallbackSemantic, limit, requiredSlot, semanticExplorationBias),
    );
    const viableAdmissionThreshold = this.slotSemanticValidityFloor(slotViability, requiredSlot, controls, slotProfile);
    if (
      semanticSeedBias > 0 &&
      regime !== 'constraint_dominant' &&
      (slotProfile.lockMode === 'broad' || slotProfile.lockMode === 'attribute')
    ) {
      semanticQuota = Math.max(
        semanticQuota,
        Math.min(
          Math.max(1, limit - 1),
          Math.max(
            1,
            Math.ceil(
              limit * (
                0.08 +
                semanticSeedBias * 0.08 +
                Math.max(0, slotViability - 0.28) * 0.1 +
                Math.max(0, weakSymbolicConfidence - 0.04) * 0.18
              ),
            ),
          ),
        ),
      );
      if (symbolicConfidence < 0.82 || slotViability >= 0.34 || semanticExplorationBias >= 0.36) {
        symbolicFloor = Math.max(
          Math.min(requiredSlot ? 1 : 1, symbolicTop.length),
          Math.min(symbolicTop.length, symbolicFloor - 1),
        );
      }
    }
    const roleFitFloor =
      requiredSlot && regime !== 'constraint_dominant'
        ? clamp01(0.48 + slotViability * 0.12 + controls.rolePurityWeight * 0.08 + ((slot === 'bottom' || slot === 'shoes') ? 0.03 : 0))
        : 0;
    const familyFitFloor =
      requiredSlot && regime !== 'constraint_dominant'
        ? clamp01(0.5 + slotViability * 0.12 + controls.rolePurityWeight * 0.08 + ((slot === 'bottom' || slot === 'shoes') ? 0.04 : 0))
        : 0;
    if (requiredSlot && semanticDiscipline >= 0.32 && slotViability >= 0.52) {
      semanticQuota = Math.max(semanticQuota, Math.min(Math.max(2, limit - 1), Math.max(2, Math.ceil(limit * (0.16 + slotViability * 0.12)))));
      symbolicFloor = Math.max(2, Math.min(symbolicTop.length, symbolicFloor - Math.max(1, Math.ceil(slotViability * 2.2))));
    }
    const semanticPreservationBias = clamp01(
      promptFuzziness * 0.56 +
      slotViability * 0.26 +
      weakSymbolicConfidence * 0.34 +
      (regime === 'semantic_dominant' ? 0.12 : 0) -
      (regime === 'constraint_dominant' ? 0.22 : 0),
    );
    if (semanticPreservationBias >= 0.28) {
      semanticQuota = Math.max(
        semanticQuota,
        Math.min(
          Math.max(2, limit - 1),
          Math.max(
            2,
            Math.ceil(limit * (0.16 + semanticPreservationBias * 0.2 + (requiredSlot ? 0.04 : 0))),
          ),
        ),
      );
      symbolicFloor = Math.max(
        Math.min(requiredSlot ? 2 : 1, symbolicTop.length),
        Math.min(symbolicTop.length, symbolicFloor - Math.max(0, Math.ceil(semanticPreservationBias * 1.6) - 1)),
      );
    }
    const viableSemantic = semanticEvaluated.filter((candidate) =>
      (candidate.constraintCleanliness || 0) >= (controls.explicitConstraintStrength >= 0.28 ? 0.999 : 0.5) &&
      (!hasAnchoredConstraint(slotProfile) || (candidate.anchorPreservation || 0) >= 0.56) &&
      (candidate.semanticAdmission || 0) >= viableAdmissionThreshold &&
      (roleFitFloor <= 0 || clamp01(0.5 + (candidate.roleFit || 0)) >= roleFitFloor) &&
      (familyFitFloor <= 0 || clamp01(0.5 + (candidate.familyFit || 0)) >= familyFitFloor),
    );
    const minimumViableSemanticShare =
      requiredSlot
        ? Math.max(1, Math.round(Math.min(limit * 0.34, 1 + controls.semanticExpansionStrength * 3 + slotViability * 2)))
        : Math.max(1, Math.round(Math.min(limit * 0.22, 1 + controls.semanticExpansionStrength * 3)));
    if (regime === 'constraint_dominant' || (controls.semanticExpansionStrength >= 0.34 && requiredSlot && semanticDiscipline >= 0.32 && slotViability < 0.28)) {
      return {
        candidates: rerankBaseline,
        source: 'symbolic',
        share: 0,
        viability: slotViability,
        validityFloor: viableAdmissionThreshold,
      };
    }
    const fallbackCoverageTarget = requiredSlot
      ? Math.max(1, Math.min(limit, Math.ceil(limit * 0.16)))
      : Math.max(1, Math.min(limit, Math.ceil(limit * 0.1)));
    if (controls.semanticExpansionStrength >= 0.34 && requiredSlot && semanticDiscipline >= 0.32 && viableSemantic.length < minimumViableSemanticShare && slotViability < 0.46 && fallbackSemantic.length < fallbackCoverageTarget) {
      return {
        candidates: rerankBaseline,
        source: 'symbolic',
        share: 0,
        viability: slotViability,
        validityFloor: viableAdmissionThreshold,
      };
    }

    const semanticBand = viableSemantic.length
      ? viableSemantic
      : (fallbackSemantic.length
          ? fallbackSemantic
          : semanticEvaluated.filter((candidate) =>
          (candidate.constraintCleanliness || 0) >= 0.999 &&
          (!hasAnchoredConstraint(slotProfile) || (candidate.anchorPreservation || 0) >= 0.4),
        ));
    const styleTop = [...semanticBand].sort((a, b) => {
      const left = a.directSemantic?.style || 0;
      const right = b.directSemantic?.style || 0;
      return right - left;
    }).slice(0, viabilityFirst ? Math.max(2, Math.ceil(limit * 0.35)) : Math.max(3, Math.ceil(limit * 0.55)));
    const identityTop = [...semanticBand].sort((a, b) => {
      const left = a.directSemantic?.identity || 0;
      const right = b.directSemantic?.identity || 0;
      return right - left;
    }).slice(0, viabilityFirst ? Math.max(1, Math.ceil(limit * 0.2)) : Math.max(2, Math.ceil(limit * 0.35)));
    const generalTop = [...semanticBand].sort((a, b) => {
      const left = a.directSemantic?.general || 0;
      const right = b.directSemantic?.general || 0;
      return right - left;
    }).slice(0, viabilityFirst ? Math.max(2, Math.ceil(limit * 0.22)) : Math.max(2, Math.ceil(limit * 0.35)));
    const noveltyTop = this.selectNovelSemanticCandidates(
      semanticBand,
      viabilityFirst ? Math.max(3, Math.ceil(limit * 0.22)) : Math.max(2, Math.ceil(limit * 0.3)),
    );

    const unionIds = new Set<string>();
    const union: ScoredItem[] = [];
    const pushCandidate = (candidate: ScoredItem) => {
      if (unionIds.has(candidate.item.id)) return;
      unionIds.add(candidate.item.id);
      union.push(candidate);
    };

    if (requiredSlot && semanticDiscipline >= 0.32 && slotViability >= 0.52) {
      [...semanticBand]
        .sort((a, b) => ((b.semanticAdmission || 0) - (a.semanticAdmission || 0)) || ((b.roleFit || 0) - (a.roleFit || 0)))
        .slice(0, Math.max(1, Math.min(semanticQuota, Math.ceil(limit * (0.12 + slotViability * 0.08)))))
        .forEach(pushCandidate);
    }
    rerankBaseline.slice(0, Math.min(symbolicFloor, rerankBaseline.length)).forEach(pushCandidate);
    styleTop.forEach(pushCandidate);
    identityTop.forEach(pushCandidate);
    generalTop.forEach(pushCandidate);
    noveltyTop.forEach(pushCandidate);
    if (semanticQuota > 0) {
      const semanticLeaders = [...semanticBand]
        .sort((a, b) => ((b.semanticAdmission || 0) - (a.semanticAdmission || 0)) || (b.semantic - a.semantic))
        .slice(0, Math.max(semanticQuota * 3, semanticQuota + 4));
      let covered = semanticLeaders.filter((candidate) => unionIds.has(candidate.item.id)).length;
      for (const candidate of semanticLeaders) {
        if (covered >= semanticQuota) break;
        if (unionIds.has(candidate.item.id)) continue;
        pushCandidate(candidate);
        covered += 1;
      }
    }

    const hybridOrdered = this.rerankSlotCandidates(
      slot,
      union,
      intent,
      slotProfile,
      slotProfiles,
      promptEmbeddings,
      embeddings,
      'hybrid',
      slotViability,
      requiredSlot,
      viableAdmissionThreshold,
    );

    const rerankIds = new Set(rerankBaseline.map((candidate) => candidate.item.id));
    const divergenceBudget = this.hybridDivergenceBudget(intent, slotProfile, controls, slotViability, requiredSlot, informativeness);
    const broadSemanticPressure =
      (slotProfile.lockMode === 'broad' || slotProfile.lockMode === 'attribute')
        ? clamp01(
            semanticPreservationBias * 0.5 +
            slotViability * 0.28 +
            weakSymbolicConfidence * 0.3 +
            semanticSeedBias * 0.42,
          )
        : 0;
    const promotionThresholdBase =
      0.01 +
      ((1 - divergenceBudget) * 0.04) +
      (controls.explicitConstraintStrength * 0.03) +
      (requiredSlot ? 0 : 0.01) -
      ((slot === 'bottom' || slot === 'shoes') ? 0.012 : 0) -
      broadSemanticPressure * 0.018;
    const hybridBaselineOrdered = hybridOrdered.filter((candidate) => rerankIds.has(candidate.item.id));
    const usedBaselineIds = new Set<string>();
    let finalCandidates: ScoredItem[] = rerankBaseline.map((fallback, index) => {
      const promoted = hybridBaselineOrdered.find((candidate) => {
        if (usedBaselineIds.has(candidate.item.id)) return false;
        if (candidate.item.id === fallback.item.id) return true;
        const delta = this.rerankSuperiorityDelta(candidate, fallback, slotProfile, controls);
        return delta >= promotionThresholdBase;
      }) || fallback;
      usedBaselineIds.add(promoted.item.id);
      const superiority = promoted.item.id === fallback.item.id
        ? 0
        : this.rerankSuperiorityDelta(promoted, fallback, slotProfile, controls);
      return {
        ...promoted,
        hybridOwnership: promoted.item.id === fallback.item.id ? ('rerank' as const) : ('baseline_promotion' as const),
        hybridSemanticOnly: false,
        rerankReferenceScore: fallback.score ?? fallback.symbolic,
        rerankReferenceAdmission: fallback.semanticAdmission ?? 0.5,
        rerankReferenceRoleFit: fallback.roleFit ?? 0,
        rerankReferenceFamilyFit: fallback.familyFit ?? 0,
        rerankSuperiority: Number(superiority.toFixed(6)),
      } as ScoredItem;
    });
    const protectedCount = Math.min(
      (slotProfile.lockMode === 'broad' || slotProfile.lockMode === 'attribute') && broadSemanticPressure >= 0.46
        ? 1
        : (requiredSlot ? 2 : 1),
      finalCandidates.length,
    );
    const maxSemanticOnly = Math.min(
      Math.max(0, finalCandidates.length - protectedCount),
      Math.max(
        0,
        Math.round((finalCandidates.length - protectedCount) * (divergenceBudget + semanticPreservationBias * 0.22) * (requiredSlot ? 0.72 : 0.46)),
      ),
    );
    const superiorityThreshold =
      0.015 +
      ((1 - divergenceBudget) * 0.05) +
      (controls.explicitConstraintStrength * 0.04) +
      (requiredSlot ? 0 : 0.01) -
      (regime === 'semantic_dominant' ? 0.012 : 0) -
      ((slot === 'bottom' || slot === 'shoes') && requiredSlot ? 0.015 : 0) -
      broadSemanticPressure * 0.026;
    const replacementOrder = finalCandidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ index }) => index >= protectedCount)
      .sort((a, b) =>
        (((a.candidate.semanticAdmission || 0) - (b.candidate.semanticAdmission || 0))) ||
        (((a.candidate.roleFit || 0) - (b.candidate.roleFit || 0))) ||
        ((a.candidate.score || 0) - (b.candidate.score || 0))
      );
    const replaceableIndices = replacementOrder.map((entry) => entry.index);
    const semanticOnlyPool = hybridOrdered
      .filter((candidate) =>
        !rerankIds.has(candidate.item.id) &&
        (candidate.constraintCleanliness || 0) >= (controls.explicitConstraintStrength >= 0.28 ? 0.999 : 0.5) &&
        (!hasAnchoredConstraint(slotProfile) || (candidate.anchorPreservation || 0) >= 0.56) &&
        (candidate.semanticAdmission || 0) >= viableAdmissionThreshold,
      )
      .sort((a, b) =>
        (this.semanticNoveltyScore(b, rerankBaseline) - this.semanticNoveltyScore(a, rerankBaseline)) ||
        ((b.semanticAdmission || 0) - (a.semanticAdmission || 0)) ||
        ((b.roleFit || 0) - (a.roleFit || 0)) ||
        ((b.score || 0) - (a.score || 0))
      );
    const broadSemanticReserveThreshold = clamp01(
      Math.max(
        fallbackAdmissionThreshold,
        viableAdmissionThreshold -
          (
            0.08 +
            broadSemanticPressure * 0.08 +
            semanticSeedBias * 0.06 +
            weakSymbolicConfidence * 0.04
          ),
      ),
    );
    const semanticOnlyReservePool =
      semanticOnlyPool.length || regime === 'constraint_dominant' || (slotProfile.lockMode !== 'broad' && slotProfile.lockMode !== 'attribute')
        ? semanticOnlyPool
        : hybridOrdered
            .filter((candidate) =>
              !rerankIds.has(candidate.item.id) &&
              (candidate.constraintCleanliness || 0) >= (controls.explicitConstraintStrength >= 0.28 ? 0.999 : 0.5) &&
              (!hasAnchoredConstraint(slotProfile) || (candidate.anchorPreservation || 0) >= Math.max(0.48, 0.56 - broadSemanticPressure * 0.08)) &&
              (candidate.semanticAdmission || 0) >= broadSemanticReserveThreshold &&
              (roleFitFloor <= 0 || clamp01(0.5 + (candidate.roleFit || 0)) >= Math.max(0.42, roleFitFloor - 0.08)) &&
              (familyFitFloor <= 0 || clamp01(0.5 + (candidate.familyFit || 0)) >= Math.max(0.42, familyFitFloor - 0.08)),
            )
            .sort((a, b) =>
              (this.semanticNoveltyScore(b, rerankBaseline) - this.semanticNoveltyScore(a, rerankBaseline)) ||
              ((b.semanticAdmission || 0) - (a.semanticAdmission || 0)) ||
              ((b.roleFit || 0) - (a.roleFit || 0)) ||
              ((b.score || 0) - (a.score || 0))
            );
    let replacements = 0;
    for (const candidate of semanticOnlyPool) {
      if (replacements >= maxSemanticOnly || !replaceableIndices.length) break;
      let bestIndex = -1;
      let bestDelta = Number.NEGATIVE_INFINITY;
      for (const index of replaceableIndices) {
        const noveltyBonus = this.semanticNoveltyScore(candidate, rerankBaseline) * (0.06 + semanticPreservationBias * 0.12 + weakSymbolicConfidence * 0.08);
        const delta = this.rerankSuperiorityDelta(candidate, finalCandidates[index], slotProfile, controls) + noveltyBonus;
        if (delta > bestDelta) {
          bestDelta = delta;
          bestIndex = index;
        }
      }
      if (bestIndex < 0 || bestDelta < superiorityThreshold) continue;
      finalCandidates[bestIndex] = {
        ...candidate,
        hybridOwnership: 'semantic_only' as const,
        hybridSemanticOnly: true,
        rerankReferenceScore: finalCandidates[bestIndex]?.score ?? rerankBaseline[bestIndex]?.symbolic ?? 0,
        rerankReferenceAdmission: finalCandidates[bestIndex]?.semanticAdmission ?? 0.5,
        rerankReferenceRoleFit: finalCandidates[bestIndex]?.roleFit ?? 0,
        rerankReferenceFamilyFit: finalCandidates[bestIndex]?.familyFit ?? 0,
        rerankSuperiority: Number(bestDelta.toFixed(6)),
      };
      replaceableIndices.splice(replaceableIndices.indexOf(bestIndex), 1);
      replacements += 1;
    }
    const reservedSemanticOnly = semanticOnlyReservePool.length && regime !== 'constraint_dominant'
      ? Math.min(
          Math.max(0, finalCandidates.length - protectedCount),
          Math.max(
            0,
            Math.min(
              limit >= 7 &&
                semanticPreservationBias >= 0.62 &&
                semanticOnlyPool.length > 0
                ? 2
                : 1,
              Math.round(
                (semanticPreservationBias + semanticExplorationBias + broadSemanticPressure * 0.35) *
                  (requiredSlot ? 2.2 : 1.4),
              ),
            ),
          ),
        )
      : 0;
    if (reservedSemanticOnly > 0) {
      const usedIds = new Set(finalCandidates.map((candidate) => candidate.item.id));
      const semanticOnlyCount = finalCandidates.filter((candidate) => !rerankIds.has(candidate.item.id)).length;
      let needed = Math.max(0, reservedSemanticOnly - semanticOnlyCount);
      const rescueThreshold = -(
        0.08 +
        semanticPreservationBias * 0.12 +
        semanticExplorationBias * 0.08 +
        weakSymbolicConfidence * 0.1 +
        (requiredSlot ? 0.02 : 0)
      );
      const rescueTargets = () => finalCandidates
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ index }) => index >= protectedCount)
        .sort((a, b) =>
          ((a.candidate.semanticAdmission || 0) - (b.candidate.semanticAdmission || 0)) ||
          ((a.candidate.roleFit || 0) - (b.candidate.roleFit || 0)) ||
          ((a.candidate.score || 0) - (b.candidate.score || 0))
        );
      for (const candidate of semanticOnlyReservePool) {
        if (needed <= 0) break;
        if (usedIds.has(candidate.item.id)) continue;
        const targets = rescueTargets();
        const rescueTarget = targets[0];
        if (!rescueTarget) break;
        const noveltyBonus = this.semanticNoveltyScore(candidate, rerankBaseline) * (0.08 + semanticPreservationBias * 0.12 + semanticExplorationBias * 0.08);
        const rescueDelta = this.rerankSuperiorityDelta(candidate, rescueTarget.candidate, slotProfile, controls) + noveltyBonus;
        if (rescueDelta < rescueThreshold) continue;
        finalCandidates[rescueTarget.index] = {
          ...candidate,
          hybridOwnership: 'semantic_only' as const,
          hybridSemanticOnly: true,
          rerankReferenceScore: rescueTarget.candidate.score ?? rerankBaseline[rescueTarget.index]?.symbolic ?? 0,
          rerankReferenceAdmission: rescueTarget.candidate.semanticAdmission ?? 0.5,
          rerankReferenceRoleFit: rescueTarget.candidate.roleFit ?? 0,
          rerankReferenceFamilyFit: rescueTarget.candidate.familyFit ?? 0,
          rerankSuperiority: Number(rescueDelta.toFixed(6)),
        };
        usedIds.add(candidate.item.id);
        needed -= 1;
      }
    }

    const protectedBaselineIds = new Set(rerankBaseline.slice(0, protectedCount).map((candidate) => candidate.item.id));
    const protectedAnchors = rerankBaseline
      .slice(0, protectedCount)
      .map((baseline) => finalCandidates.find((candidate) => candidate.item.id === baseline.item.id) || baseline);
    const sortedTail = finalCandidates
      .filter((candidate) => !protectedBaselineIds.has(candidate.item.id))
      .sort((a, b) =>
        ((b.score || 0) - (a.score || 0)) ||
        ((b.semanticAdmission || 0) - (a.semanticAdmission || 0)) ||
        ((b.roleFit || 0) - (a.roleFit || 0))
      )
      .slice(0, Math.max(0, limit - protectedAnchors.length));
    finalCandidates = [...protectedAnchors, ...sortedTail].slice(0, limit);

    const semanticOnlyCount = finalCandidates.filter((candidate) => !rerankIds.has(candidate.item.id)).length;
    const share = finalCandidates.length ? semanticOnlyCount / finalCandidates.length : 0;
    const source: 'symbolic' | 'semantic_union' | 'mixed' =
      share === 0 ? 'symbolic' : share >= 0.99 ? 'semantic_union' : 'mixed';
    return { candidates: finalCandidates, source, share, viability: slotViability, validityFloor: viableAdmissionThreshold };
  }

  public buildCandidates(
    items: any[],
    intent: PromptIntentV2,
    slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
    perRoleLimit: number,
    promptEmbeddings: PromptEmbeddingState,
    embeddings: LoadedEmbeddings,
    embeddingMode: EmbeddingMode,
    debug: boolean,
  ): Record<CategoryMain, ScoredItem[]> {
    const startedAt = Date.now();
    precomputeItemFeatures(items);
    const effectiveLimit = this.effectivePerRoleLimit(intent, perRoleLimit, embeddingMode);
    const reranked: Record<CategoryMain, ScoredItem[]> = { top: [], bottom: [], shoes: [], mono: [] };
    const sourceBySlot: Partial<Record<CategoryMain, 'symbolic' | 'semantic_union' | 'mixed'>> = {};
    const viabilityBySlot: Partial<Record<CategoryMain, number>> = {};
    const floorBySlot: Partial<Record<CategoryMain, number>> = {};
    let totalSemanticShare = 0;
    let semanticSlots = 0;

    let symbolicCandidates: Record<CategoryMain, ScoredItem[]> = { top: [], bottom: [], shoes: [], mono: [] };
    let hybridCandidates: Record<CategoryMain, ScoredItem[]> | null = null;

    if (embeddingMode === 'off' || !promptEmbeddings.available) {
      const symbolicStartedAt = Date.now();
      symbolicCandidates = this.baseRanker.buildCandidates(
        items,
        intent,
        slotProfiles,
        effectiveLimit,
        promptEmbeddings,
        embeddings,
        'off',
        debug,
      );
      logCandidateTiming('candidate_ranker_symbolic_complete', {
        prompt: String((intent as any)?.prompt || ''),
        ms: Date.now() - symbolicStartedAt,
        effective_limit: effectiveLimit,
        embedding_mode: embeddingMode,
        counts: Object.fromEntries(SLOT_ORDER.map((slot) => [slot, symbolicCandidates[slot]?.length || 0])),
      });
      logCandidateTiming('candidate_ranker_complete', {
        prompt: String((intent as any)?.prompt || ''),
        ms: Date.now() - startedAt,
        path: 'symbolic_only',
      });
      this.frontierDiagnostics = {
        semantic_frontier_share: 0,
        semantic_candidate_source: {},
        slot_semantic_viability: {},
        slot_semantic_valid_floor: {},
      };
      return symbolicCandidates;
    }

    if (embeddingMode === 'rerank') {
      const symbolicStartedAt = Date.now();
      symbolicCandidates = this.baseRanker.buildCandidates(
        items,
        intent,
        slotProfiles,
        effectiveLimit,
        promptEmbeddings,
        embeddings,
        'off',
        debug,
      );
      logCandidateTiming('candidate_ranker_symbolic_complete', {
        prompt: String((intent as any)?.prompt || ''),
        ms: Date.now() - symbolicStartedAt,
        effective_limit: effectiveLimit,
        embedding_mode: embeddingMode,
        counts: Object.fromEntries(SLOT_ORDER.map((slot) => [slot, symbolicCandidates[slot]?.length || 0])),
      });
      for (const slot of SLOT_ORDER) {
        reranked[slot] = this.rerankSlotCandidates(
          slot,
          symbolicCandidates[slot] || [],
          intent,
          slotProfiles[slot],
          slotProfiles,
          promptEmbeddings,
          embeddings,
          embeddingMode,
        ).slice(0, effectiveLimit);
        sourceBySlot[slot] = 'symbolic';
      }
      this.frontierDiagnostics = {
        semantic_frontier_share: 0,
        semantic_candidate_source: sourceBySlot,
        slot_semantic_viability: {},
        slot_semantic_valid_floor: {},
      };
      logCandidateTiming('candidate_ranker_complete', {
        prompt: String((intent as any)?.prompt || ''),
        ms: Date.now() - startedAt,
        path: 'rerank_only',
      });
      return reranked;
    }

    const hybridLimit = this.semanticPoolLimit(intent, effectiveLimit);
    const dualStartedAt = Date.now();
    const dualCandidates = this.baseRanker.buildCandidatesDual(
      items,
      intent,
      slotProfiles,
      effectiveLimit,
      hybridLimit,
      promptEmbeddings,
      embeddings,
      debug,
    );
    symbolicCandidates = dualCandidates.symbolic;
    hybridCandidates = dualCandidates.hybrid;
    logCandidateTiming('candidate_ranker_symbolic_complete', {
      prompt: String((intent as any)?.prompt || ''),
      ms: Date.now() - dualStartedAt,
      effective_limit: effectiveLimit,
      embedding_mode: embeddingMode,
      counts: Object.fromEntries(SLOT_ORDER.map((slot) => [slot, symbolicCandidates[slot]?.length || 0])),
    });
    logCandidateTiming('candidate_ranker_hybrid_complete', {
      prompt: String((intent as any)?.prompt || ''),
      ms: Date.now() - dualStartedAt,
      semantic_limit: hybridLimit,
      counts: Object.fromEntries(SLOT_ORDER.map((slot) => [slot, hybridCandidates[slot]?.length || 0])),
    });

    for (const slot of SLOT_ORDER) {
      const slotStartedAt = Date.now();
      const built = this.buildHybridFrontier(
        slot,
        symbolicCandidates[slot] || [],
        hybridCandidates[slot] || [],
        intent,
        slotProfiles[slot],
        slotProfiles,
        promptEmbeddings,
        embeddings,
        effectiveLimit,
      );
      reranked[slot] = built.candidates;
      logCandidateTiming('candidate_ranker_slot_frontier_complete', {
        prompt: String((intent as any)?.prompt || ''),
        slot,
        ms: Date.now() - slotStartedAt,
        symbolic_count: symbolicCandidates[slot]?.length || 0,
        hybrid_count: hybridCandidates[slot]?.length || 0,
        final_count: built.candidates.length,
        source: built.source,
        viability: Number(built.viability.toFixed(6)),
      });
      sourceBySlot[slot] = built.source;
      viabilityBySlot[slot] = Number(built.viability.toFixed(6));
      floorBySlot[slot] = Number(built.validityFloor.toFixed(6));
      if (built.candidates.length) {
        totalSemanticShare += built.share;
        semanticSlots += 1;
      }
    }

    this.frontierDiagnostics = {
      semantic_frontier_share: semanticSlots ? Number((totalSemanticShare / semanticSlots).toFixed(6)) : 0,
      semantic_candidate_source: sourceBySlot,
      slot_semantic_viability: viabilityBySlot,
      slot_semantic_valid_floor: floorBySlot,
    };
    logCandidateTiming('candidate_ranker_complete', {
      prompt: String((intent as any)?.prompt || ''),
      ms: Date.now() - startedAt,
      path: 'hybrid',
      semantic_frontier_share: this.frontierDiagnostics.semantic_frontier_share,
    });
    return reranked;
  }

  public getFrontierDiagnostics(): CandidateFrontierDiagnostics {
    return this.frontierDiagnostics;
  }

  public precomputeItems(items: any[]): void {
    precomputeItemFeatures(items);
  }

  public buildScoreLookup(candidatesBySlot: Record<CategoryMain, ScoredItem[]>): Record<string, ScoredItem> {
    return this.baseRanker.buildScoreLookup(candidatesBySlot);
  }
}
