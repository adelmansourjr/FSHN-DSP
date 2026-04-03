import {
  CategoryMain,
  Colour,
  IndexItem,
  SLOT_ORDER,
  canonicalizeSubtype,
  isAthleticShoeSubtype,
  isFormalSubtype,
  isOpenCasualShoeSubtype,
  isSmartCasualShoeSubtype,
  normalizeText,
  subtypeFamily,
} from '../fashion_taxonomy';
import { cosineSimilarity } from '../semantic_embeddings';
import { OutfitAssembler as BaseOutfitAssembler, requestRandom } from '../og_recommendation/RecommendationService';
import { deriveItemSemanticAxisProfile, deriveRuntimeSemanticControls, RuntimeSemanticControls, SemanticAxisProfile } from '../style_semantics';
import {
  CandidateScore as ScoredItem,
  CandidateFrontierDiagnostics,
  EmbeddingMode,
  LoadedEmbeddings,
  Outfit,
  PromptEmbeddingState,
  ScoredOutfit,
  SlotConstraintProfile,
} from './types';
import { PromptIntentV2 } from './types';

const NEUTRAL_COLOURS = new Set<Colour>(['black', 'white', 'grey', 'beige', 'brown']);

function semanticSubjectSlots(intent: PromptIntentV2): CategoryMain[] {
  if (!intent.semantic_subjects.length) return [];
  const explicit = intent.semantic_subjects.flatMap((subject) => subject.slots || []);
  if (explicit.length) return Array.from(new Set(explicit));
  if (intent.semantic_subjects.some((subject) => subject.scope === 'global')) {
    return intent.requested_slots.length ? intent.requested_slots : SLOT_ORDER;
  }
  if (intent.requested_slots.length === 1) return intent.requested_slots;
  return [];
}

function broadSemanticOutfitIntent(intent: PromptIntentV2): boolean {
  if (intent.assembly_mode !== 'full_outfit') return false;
  if ((intent.requested_slots.length ? intent.requested_slots : SLOT_ORDER).length < 3) return false;
  const slotScopedSubjects = intent.semantic_subjects.filter((subject) => subject.scope === 'slot' || (subject.slots || []).length > 0);
  if (slotScopedSubjects.length) return false;
  return !!(
    intent.vibe_tags.length ||
    intent.semantic_subjects.some((subject) => subject.kind === 'style_archetype' || subject.kind === 'theme')
  );
}

function fullOutfitDiversityIntent(intent: PromptIntentV2): boolean {
  if (intent.assembly_mode !== 'full_outfit') return false;
  if ((intent.requested_slots.length ? intent.requested_slots : SLOT_ORDER).length < 2) return false;
  return intent.requested_form !== 'mono_only' && intent.requested_form !== 'mono_and_shoes';
}

function brandTerms(intent: PromptIntentV2): string[] {
  const terms = new Set<string>();
  for (const value of intent.brand_focus || []) {
    const norm = normalizeFocusToken(value);
    if (norm) terms.add(norm);
  }
  for (const subject of intent.semantic_subjects || []) {
    if (subject.kind !== 'brand') continue;
    for (const value of [subject.label, ...(subject.soft_brand_priors || [])]) {
      const norm = normalizeFocusToken(value);
      if (norm) terms.add(norm);
    }
  }
  return Array.from(terms);
}

function normalizeFocusToken(value: string): string {
  return normalizeText(value || '').trim();
}

function focusTerms(intent: PromptIntentV2): string[] {
  const terms = new Set<string>();
  for (const value of [...intent.brand_focus, ...intent.team_focus]) {
    const norm = normalizeFocusToken(value);
    if (norm) terms.add(norm);
  }
  for (const subject of intent.semantic_subjects) {
    if (subject.kind !== 'brand' && subject.kind !== 'team' && subject.kind !== 'item_line') continue;
    for (const value of [subject.label, ...(subject.soft_brand_priors || [])]) {
      const norm = normalizeFocusToken(value);
      if (norm) terms.add(norm);
    }
  }
  return Array.from(terms);
}

function itemFocusText(item: IndexItem | undefined): string {
  if (!item) return '';
  const tokens = [
    item.id,
    (item as any).name,
    (item as any).title,
    (item as any).brand,
    (item as any).label,
    (item as any).description,
    ...((item as any).entities || []),
    ...(((item as any).entityMeta || []).flatMap((entry: any) => [entry?.text, entry?.label, entry?.name])),
  ];
  return normalizeText(tokens.filter(Boolean).join(' '));
}

function itemMatchesFocus(item: IndexItem | undefined, focus: string[]): boolean {
  if (!item || !focus.length) return false;
  const text = itemFocusText(item);
  if (!text) return false;
  return focus.some((term) => text.includes(term));
}

function requestedSlots(intent: PromptIntentV2): CategoryMain[] {
  return (intent.requested_slots.length ? intent.requested_slots : SLOT_ORDER).filter((slot): slot is CategoryMain => !!slot);
}

function outfitFocusCoverage(outfit: Outfit, intent: PromptIntentV2): { hits: number; ratio: number } {
  const focus = focusTerms(intent);
  if (!focus.length) return { hits: 0, ratio: 0 };
  const slots = requestedSlots(intent);
  if (!slots.length) return { hits: 0, ratio: 0 };
  let hits = 0;
  for (const slot of slots) {
    if (itemMatchesFocus(outfit[slot], focus)) hits += 1;
  }
  return { hits, ratio: hits / slots.length };
}

function itemMatchesBrand(item: IndexItem | undefined, terms: string[]): boolean {
  if (!item || !terms.length) return false;
  const text = itemFocusText(item);
  if (!text) return false;
  return terms.some((term) => text.includes(term));
}

function outfitBrandCoverage(outfit: Outfit, intent: PromptIntentV2): { hits: number; ratio: number } {
  const terms = brandTerms(intent);
  if (!terms.length) return { hits: 0, ratio: 0 };
  const slots = requestedSlots(intent);
  if (!slots.length) return { hits: 0, ratio: 0 };
  let hits = 0;
  for (const slot of slots) {
    if (itemMatchesBrand(outfit[slot], terms)) hits += 1;
  }
  return { hits, ratio: hits / slots.length };
}

function oldMoneyMensIntent(intent: PromptIntentV2): boolean {
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

function aggregateOutfitAxisProfile(outfit: Outfit): SemanticAxisProfile {
  const items = outfitItems(outfit).map((entry) => deriveItemSemanticAxisProfile(entry.item));
  if (!items.length) return emptySemanticAxisProfile();
  const out = emptySemanticAxisProfile();
  const axes = Object.keys(out) as Array<keyof SemanticAxisProfile>;
  for (const axis of axes) {
    out[axis] = items.reduce((sum, item) => sum + item[axis], 0) / items.length;
  }
  return out;
}

function outfitSemanticMetrics(
  promptProfile: SemanticAxisProfile | null | undefined,
  outfit: Outfit,
): { mean: number; min: number; spread: number; combined: number } {
  const alignments = outfitItems(outfit).map((entry) => semanticAxisAlignment(promptProfile, deriveItemSemanticAxisProfile(entry.item)));
  if (!alignments.length) return { mean: 0.5, min: 0.5, spread: 0, combined: 0.5 };
  const mean = alignments.reduce((sum, value) => sum + value, 0) / alignments.length;
  const min = Math.min(...alignments);
  const max = Math.max(...alignments);
  const spread = max - min;
  const combined = Math.max(0, Math.min(1, (mean * 0.58) + (min * 0.42) - (spread * 0.16)));
  return { mean, min, spread, combined };
}

function outfitRuntimeMetrics(
  outfit: Outfit,
  scoreLookup: Record<string, ScoredItem>,
): {
  cleanlinessMean: number;
  cleanlinessMin: number;
  admissionMean: number;
  admissionMin: number;
  roleFitMean: number;
  roleFitMin: number;
  anchorMean: number;
  anchorMin: number;
} {
  const scores = outfitItems(outfit)
    .map((entry) => scoreLookup[entry.item.id])
    .filter((entry): entry is ScoredItem => !!entry);
  if (!scores.length) {
    return {
      cleanlinessMean: 1,
      cleanlinessMin: 1,
      admissionMean: 0.5,
      admissionMin: 0.5,
      roleFitMean: 0,
      roleFitMin: 0,
      anchorMean: 1,
      anchorMin: 1,
    };
  }
  const cleanliness = scores.map((entry) => entry.constraintCleanliness ?? (entry.negativeViolated ? 0 : 1));
  const admission = scores.map((entry) => entry.semanticAdmission ?? 0.5);
  const roleFit = scores.map((entry) => entry.roleFit ?? 0);
  const anchor = scores.map((entry) => entry.anchorPreservation ?? 1);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    cleanlinessMean: mean(cleanliness),
    cleanlinessMin: Math.min(...cleanliness),
    admissionMean: mean(admission),
    admissionMin: Math.min(...admission),
    roleFitMean: mean(roleFit),
    roleFitMin: Math.min(...roleFit),
    anchorMean: mean(anchor),
    anchorMin: Math.min(...anchor),
  };
}

function outfitItems(outfit: Outfit): Array<{ slot: CategoryMain; item: IndexItem }> {
  return SLOT_ORDER
    .map((slot) => ({ slot, item: outfit[slot] }))
    .filter((entry): entry is { slot: CategoryMain; item: IndexItem } => !!entry.item);
}

function outfitSignature(outfit: Outfit): string {
  return outfitItems(outfit).map((entry) => entry.item.id).sort().join('|');
}

function coreOutfitSignature(outfit: Outfit): string {
  if (outfit.mono?.id) return `mono:${outfit.mono.id}`;
  const topId = outfit.top?.id || '';
  const bottomId = outfit.bottom?.id || '';
  if (!topId && !bottomId) return '';
  return `top:${topId || '-'}|bottom:${bottomId || '-'}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function explicitConstraintCount(intent: PromptIntentV2): number {
  return SLOT_ORDER.reduce((sum, slot) => {
    const constraint = intent.slot_constraints[slot];
    if (!constraint) return sum;
    return sum +
      (constraint.required_keywords || []).length +
      (constraint.anchor_entities || []).length +
      (constraint.anchor_colours || []).length +
      (constraint.preferred_subs || []).length +
      (constraint.excluded_keywords || []).length +
      (constraint.excluded_entities || []).length +
      (constraint.excluded_colours || []).length +
      (constraint.excluded_subs || []).length;
  }, 0);
}

function assemblyPromptBroadness(intent: PromptIntentV2): number {
  const requestedSlots = Array.isArray(intent.requested_slots) ? intent.requested_slots : [];
  const vibeTags = Array.isArray(intent.vibe_tags) ? intent.vibe_tags : [];
  const semanticSubjects = Array.isArray(intent.semantic_subjects) ? intent.semantic_subjects : [];
  const globalPaletteColours = Array.isArray(intent.global_palette_colours) ? intent.global_palette_colours : [];
  const colourHints = Array.isArray((intent as any).colour_hints) ? (intent as any).colour_hints : [];
  const requestedSlotCount = (requestedSlots.length ? requestedSlots : SLOT_ORDER).length;
  const explicitConstraints = explicitConstraintCount(intent);
  let score = 0.18;
  score += broadSemanticOutfitIntent(intent) ? 0.32 : 0;
  score += Math.min(0.18, vibeTags.length * 0.05);
  score += Math.min(0.18, semanticSubjects.length * 0.045);
  score += requestedSlotCount >= 3 ? 0.12 : requestedSlotCount === 2 ? 0.04 : -0.08;
  score += globalPaletteColours.length ? -0.08 : 0.04;
  score += colourHints.length ? -0.06 : 0.03;
  score -= Math.min(0.3, explicitConstraints * 0.022);
  return clamp01(score);
}

function selectAssemblyCandidates(
  candidates: ScoredItem[],
  limit: number,
  noveltyWeight: number,
): ScoredItem[] {
  if (candidates.length <= limit) return candidates;
  const selected: ScoredItem[] = [];
  const seenIds = new Set<string>();
  const seenFamilies = new Set<string>();
  const seenBrands = new Set<string>();
  const seenColours = new Set<string>();
  const working = [...candidates];

  while (selected.length < limit && working.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < working.length; index++) {
      const candidate = working[index];
      let adjusted = candidate.score - (index * 0.025);
      if (!seenFamilies.has(candidate.family || '')) adjusted += noveltyWeight * 0.9;
      else adjusted -= noveltyWeight * 0.18;
      if (candidate.brandKey && !seenBrands.has(candidate.brandKey)) adjusted += noveltyWeight * 0.28;
      else if (candidate.brandKey) adjusted -= noveltyWeight * 0.08;
      if (candidate.colourFamily && !seenColours.has(candidate.colourFamily)) adjusted += noveltyWeight * 0.22;
      else if (candidate.colourFamily) adjusted -= noveltyWeight * 0.05;
      if (candidate.variantBoosted) adjusted += noveltyWeight * 0.1;
      if (candidate.anchorPreservation !== undefined) adjusted += (candidate.anchorPreservation - 0.5) * 0.22;
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestIndex = index;
      }
    }
    const chosen = working.splice(bestIndex, 1)[0];
    if (seenIds.has(chosen.item.id)) continue;
    selected.push(chosen);
    seenIds.add(chosen.item.id);
    if (chosen.family) seenFamilies.add(chosen.family);
    if (chosen.brandKey) seenBrands.add(chosen.brandKey);
    if (chosen.colourFamily) seenColours.add(chosen.colourFamily);
  }

  return selected.sort((a, b) => b.score - a.score);
}

function approximateOutfitBandLimit(intent: PromptIntentV2, poolSize: number): number {
  const broadness = assemblyPromptBroadness(intent);
  if (poolSize <= 1) return Math.max(96, Math.round(88 + broadness * 84));
  return Math.max(poolSize * 42, Math.round(120 + broadness * 120));
}

function approximateOutfitScore(outfit: Outfit, scoreLookup: Record<string, ScoredItem>): number {
  return outfitItems(outfit).reduce((sum, entry) => {
    const score = scoreLookup[entry.item.id];
    if (!score) return sum;
    return sum + score.score + (score.anchorPreservation || 0) * 0.2 + (score.roleFit || 0) * 0.35;
  }, 0);
}

function weightedChoice<T>(items: T[], weights: number[], rng: () => number = Math.random): T {
  const safeWeights = weights.map((weight) => Number.isFinite(weight) && weight > 0 ? weight : 0);
  const total = safeWeights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return items[0];
  let cursor = rng() * total;
  for (let index = 0; index < items.length; index++) {
    cursor -= safeWeights[index];
    if (cursor <= 0) return items[index];
  }
  return items[items.length - 1];
}

function outfitSlotIds(outfit: Outfit) {
  return {
    top: outfit.top?.id || '',
    bottom: outfit.bottom?.id || '',
    shoes: outfit.shoes?.id || '',
    mono: outfit.mono?.id || '',
  };
}

function broadFinalistRarityBonus(outfits: Outfit[], index: number): number {
  if (!outfits.length || index < 0 || index >= outfits.length) return 0;
  const current = outfitSlotIds(outfits[index]);
  const coreCounts = new Map<string, number>();
  const topCounts = new Map<string, number>();
  const bottomCounts = new Map<string, number>();
  const shoeCounts = new Map<string, number>();

  for (const outfit of outfits) {
    const ids = outfitSlotIds(outfit);
    const core = coreOutfitSignature(outfit);
    if (core) coreCounts.set(core, (coreCounts.get(core) || 0) + 1);
    if (ids.top) topCounts.set(ids.top, (topCounts.get(ids.top) || 0) + 1);
    if (ids.bottom) bottomCounts.set(ids.bottom, (bottomCounts.get(ids.bottom) || 0) + 1);
    if (ids.shoes) shoeCounts.set(ids.shoes, (shoeCounts.get(ids.shoes) || 0) + 1);
  }

  let bonus = 0;
  const currentCore = coreOutfitSignature(outfits[index]);
  if (currentCore) bonus += Math.max(0, 2 - (coreCounts.get(currentCore) || 0)) * 0.9;
  if (current.top) bonus += Math.max(0, 3 - (topCounts.get(current.top) || 0)) * 0.45;
  if (current.bottom) bonus += Math.max(0, 3 - (bottomCounts.get(current.bottom) || 0)) * 0.35;
  if (current.shoes) bonus += Math.max(0, 3 - (shoeCounts.get(current.shoes) || 0)) * 0.18;
  return bonus;
}

function shortlistFinalists<T extends { adjusted: number }>(
  candidates: T[],
  broadness: number,
  poolSize: number,
): T[] {
  if (!candidates.length) return [];
  const requested = Math.max(
    1,
    Math.min(candidates.length, (poolSize <= 1 ? 4 : 3) + Math.round(broadness * (poolSize <= 1 ? 7 : 6))),
  );
  const floor = candidates[0].adjusted - (0.55 + broadness * (poolSize <= 1 ? 1.8 : 1.3));
  return candidates
    .filter((candidate, index) => index < requested || candidate.adjusted >= floor)
    .slice(0, Math.max(requested, poolSize <= 1 ? 8 : 7));
}

function sampleFinalist<T extends { adjusted: number }>(
  finalists: T[],
  broadness: number,
  epsilon: number,
  poolSize: number,
): T {
  if (finalists.length <= 1) return finalists[0];
  const anchor = finalists[0].adjusted;
  const weights = finalists.map((candidate, index) => {
    const gap = Math.max(0, anchor - candidate.adjusted);
    const closeness = Math.exp(-gap / (0.62 + broadness * (poolSize <= 1 ? 1.7 : 1.35) + epsilon * 3.1));
    const rankPrior = 1 / (1 + index * (poolSize <= 1 ? 0.18 : 0.26));
    return closeness * rankPrior;
  });
  return weightedChoice(finalists, weights, requestRandom);
}

function diversityTargets(scored: ScoredOutfit[], intent: PromptIntentV2, poolSize: number): Partial<Record<CategoryMain, number>> {
  if (!fullOutfitDiversityIntent(intent) || !broadSemanticOutfitIntent(intent) || poolSize <= 1) return {};
  const uniques: Record<CategoryMain, Set<string>> = { top: new Set(), bottom: new Set(), shoes: new Set(), mono: new Set() };
  for (const look of scored) {
    for (const { slot, item } of outfitItems(look.outfit)) uniques[slot].add(item.id);
  }
  const oldMoneyMen = oldMoneyMensIntent(intent);
  return {
    top: Math.min(uniques.top.size, oldMoneyMen ? Math.max(8, Math.ceil(poolSize * 0.82)) : Math.max(5, Math.ceil(poolSize * 0.65))),
    bottom: Math.min(uniques.bottom.size, Math.max(4, Math.ceil(poolSize * 0.48))),
    shoes: Math.min(uniques.shoes.size, Math.max(3, Math.ceil(poolSize * 0.35))),
  };
}

function candidateCoverageGain(
  candidate: ScoredOutfit,
  scoreLookup: Record<string, ScoredItem>,
  seenIds: Record<CategoryMain, Set<string>>,
  seenFamilies: Record<CategoryMain, Set<string>>,
  targets: Partial<Record<CategoryMain, number>>,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  prioritySlots: CategoryMain[],
): number {
  let gain = 0;
  for (const slot of prioritySlots) {
    if (slotProfiles[slot].diversityExempt) continue;
    const target = targets[slot] || 0;
    if (!target || seenIds[slot].size >= target) continue;
    const item = candidate.outfit[slot];
    if (!item) continue;
    const meta = scoreLookup[item.id];
    if (!seenIds[slot].has(item.id)) gain += 3.6;
    const family = meta?.family || canonicalizeSubtype(item.sub || '');
    if (family && !seenFamilies[slot].has(family)) gain += 1.1;
  }
  return gain;
}

function candidateImprovesCoverage(
  candidate: ScoredOutfit,
  scoreLookup: Record<string, ScoredItem>,
  seenIds: Record<CategoryMain, Set<string>>,
  seenFamilies: Record<CategoryMain, Set<string>>,
  targets: Partial<Record<CategoryMain, number>>,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
  prioritySlots: CategoryMain[],
): boolean {
  return candidateCoverageGain(candidate, scoreLookup, seenIds, seenFamilies, targets, slotProfiles, prioritySlots) > 0;
}

type PromptRegime = 'constraint_dominant' | 'semantic_dominant' | 'mixed';

interface AnchorStyleDominance {
  refined: number;
  streetwear: number;
  sport: number;
  strength: number;
}

function uniqueColours(item: IndexItem | undefined): Colour[] {
  return Array.from(new Set((item?.colours || []))) as Colour[];
}

function chromaticColours(item: IndexItem | undefined): Colour[] {
  return uniqueColours(item).filter((colour) => !NEUTRAL_COLOURS.has(colour));
}

function isColourMatch(item: IndexItem | undefined, colour: Colour): boolean {
  return uniqueColours(item).includes(colour);
}

function tonalMatch(item: IndexItem | undefined, targets: Colour[]): boolean {
  if (!item || !targets.length) return false;
  const colours = uniqueColours(item);
  if (!colours.length) return false;
  if (colours.some((colour) => targets.includes(colour))) return true;
  const hasNeutral = colours.some((colour) => NEUTRAL_COLOURS.has(colour));
  const targetNeutral = targets.some((colour) => NEUTRAL_COLOURS.has(colour));
  return hasNeutral && targetNeutral;
}

function paletteAdjustment(outfit: Outfit, intent: PromptIntentV2): number {
  const entries = outfitItems(outfit);
  const items = entries.map((entry) => entry.item);
  if (!items.length) return 0;

  if (intent.palette_mode === 'colorful') {
    const colourfulItems = items.filter((item) => chromaticColours(item).length > 0).length;
    const chromaticFamilies = Array.from(new Set(items.flatMap((item) => chromaticColours(item))));
    let score = 0;
    if (colourfulItems >= 2) score += 2.4;
    else score -= 4.8;
    if (chromaticFamilies.length >= 2 && chromaticFamilies.length <= 3) score += 3.2;
    else if (chromaticFamilies.length === 1) score -= 1.3;
    else if (chromaticFamilies.length >= 4) score -= 2.2;
    if (colourfulItems >= 2 && chromaticFamilies.length >= 2 && chromaticFamilies.length <= 3) score += 1.2;
    return score;
  }

  if ((intent.palette_mode === 'monochrome' || intent.palette_mode === 'tonal') && intent.global_palette_colours.length) {
    const paletteTargets = intent.global_palette_colours;
    const exactHits = items.filter((item) => paletteTargets.some((colour) => isColourMatch(item, colour))).length;
    const tonalHits = items.filter((item) => tonalMatch(item, paletteTargets)).length;
    const foreignItems = items.length - tonalHits;
    const modeFactor = intent.palette_mode === 'monochrome' ? 1.55 : 1.15;
    let score = exactHits * modeFactor * 1.8;
    score += (tonalHits - exactHits) * (intent.palette_mode === 'monochrome' ? 0.4 : 0.85);
    if (intent.palette_override_strength === 'hard') {
      score -= foreignItems * (intent.palette_mode === 'monochrome' ? 2.4 : 1.6);
      if (exactHits >= Math.max(2, items.length - 1)) score += 1.1;
    } else {
      score -= foreignItems * 0.75;
    }
    return score;
  }

  return 0;
}

function semanticPalettePrior(
  outfit: Outfit,
  intent: PromptIntentV2,
  promptProfile: SemanticAxisProfile | null | undefined,
  informativeness: number,
): number {
  if (intent.palette_mode !== 'unconstrained') return 0;
  if (intent.colour_hints.length || intent.global_palette_colours.length) return 0;
  if (!promptProfile) return 0;
  const controls = deriveRuntimeSemanticControls(intent, promptProfile, informativeness);
  if (controls.paletteStrictness < 0.42) return 0;
  const items = outfitItems(outfit).map((entry) => entry.item);
  if (!items.length) return 0;
  const neutralRatio = items.reduce((sum, item) => {
    const colours = uniqueColours(item);
    if (!colours.length) return sum;
    return sum + (colours.filter((colour) => NEUTRAL_COLOURS.has(colour)).length / colours.length);
  }, 0) / items.length;
  const chromaticShare = items.filter((item) => chromaticColours(item).length > 0).length / items.length;
  return (
    Math.max(0, neutralRatio - 0.55) * (0.6 + controls.paletteStrictness * 1.1) -
    Math.max(0, chromaticShare - controls.diversityEnvelope) * (0.45 + controls.paletteStrictness * 0.8)
  );
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

function explicitPaletteCoverageIntent(intent: PromptIntentV2): boolean {
  const required = requiredSlots(intent);
  return (
    (intent.palette_mode === 'tonal' || intent.palette_mode === 'monochrome') &&
    intent.global_palette_colours.length > 0 &&
    (required.has('top') || required.has('bottom') || required.has('mono'))
  );
}

function paletteTargetCoverage(outfit: Outfit, intent: PromptIntentV2): number {
  if (!intent.global_palette_colours.length) return 0;
  const items = [outfit.top, outfit.bottom, outfit.mono].filter((item): item is IndexItem => !!item);
  if (!items.length) return 0;
  const hits = items.filter((item) => intent.global_palette_colours.some((colour) => isColourMatch(item, colour))).length;
  return hits / items.length;
}

function lockModeStrength(lockMode: SlotConstraintProfile['lockMode']): number {
  if (lockMode === 'exact') return 1;
  if (lockMode === 'family') return 0.84;
  if (lockMode === 'attribute') return 0.62;
  return 0.22;
}

function itemStyleDominance(slot: CategoryMain, item: IndexItem, slotProfile: SlotConstraintProfile): AnchorStyleDominance {
  const profile = deriveItemSemanticAxisProfile(item);
  const sub = canonicalizeSubtype(item.sub || '');
  const families = new Set(subtypeFamily(sub));
  const text = normalizeText([
    item.name || '',
    item.name_normalized || '',
    item.sub || '',
    ...(item.style_markers || []).map((entry) => String(entry || '')),
  ].join(' '));
  let refined = Math.max(profile.refined, profile.classic * 0.92, profile.minimal * 0.74, profile.understated * 0.82);
  let streetwear = Math.max(profile.streetwear, profile.graphic * 0.72, profile.relaxed * 0.34);
  let sport = profile.sporty;

  if (isFormalSubtype(sub) || isSmartCasualShoeSubtype(sub) || /\btailored|loafer|derby|oxford|dress shirt|trouser|classic|minimal|understated\b/.test(text)) {
    refined = Math.max(refined, 0.78);
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
    streetwear = Math.max(streetwear, 0.76);
  }
  if (isAthleticShoeSubtype(sub) || /\bfootball|basketball|soccer|jersey|kit|cleat|trainer|sport\b/.test(text)) {
    sport = Math.max(sport, 0.82);
  }
  if (slot === 'top' && /\bhoodie|sweatshirt|tshirt|tee|jersey\b/.test(text)) streetwear = Math.max(streetwear, 0.84);
  if (slot === 'bottom' && /\bcargo|jeans|denim|track|jogger\b/.test(text)) streetwear = Math.max(streetwear, 0.8);
  if (slot === 'shoes' && (families.has('boot_family') || sub === 'sneakers')) streetwear = Math.max(streetwear, 0.78);
  if (slot === 'shoes' && (isFormalSubtype(sub) || isSmartCasualShoeSubtype(sub))) refined = Math.max(refined, 0.8);

  return {
    refined: clamp01(refined),
    streetwear: clamp01(streetwear),
    sport: clamp01(sport),
    strength: clamp01(lockModeStrength(slotProfile.lockMode) * (0.45 + slotProfile.specificity * 0.55)),
  };
}

function partnerAnchorCompatibility(
  partnerSlot: CategoryMain,
  partnerItem: IndexItem,
  dominance: AnchorStyleDominance,
): number {
  const profile = deriveItemSemanticAxisProfile(partnerItem);
  const sub = canonicalizeSubtype(partnerItem.sub || '');
  const families = new Set(subtypeFamily(sub));
  const text = normalizeText([
    partnerItem.name || '',
    partnerItem.name_normalized || '',
    partnerItem.sub || '',
    ...(partnerItem.style_markers || []).map((entry) => String(entry || '')),
  ].join(' '));
  const refinedish = Math.max(profile.refined, profile.classic * 0.9, profile.minimal * 0.68, profile.understated * 0.8);
  const streetwearish = Math.max(profile.streetwear, profile.graphic * 0.7, profile.relaxed * 0.34);
  const sporty = profile.sporty;
  let score = 0;

  if (dominance.streetwear > dominance.refined + 0.08) {
    score += (streetwearish - refinedish * 0.42) * (0.55 + dominance.strength * 0.4);
    score -= sporty * dominance.sport * 0.18;
    if (partnerSlot === 'bottom' && isFormalSubtype(sub)) score -= 0.38 + dominance.strength * 0.28;
    if (partnerSlot === 'shoes' && (isFormalSubtype(sub) || isSmartCasualShoeSubtype(sub))) score -= 0.44 + dominance.strength * 0.34;
    if (partnerSlot === 'shoes' && (families.has('boot_family') || sub === 'sneakers')) score += 0.14 + dominance.strength * 0.18;
    if (partnerSlot === 'bottom' && (families.has('denim') || /\bcargo|jeans|denim\b/.test(text))) score += 0.14 + dominance.strength * 0.18;
  } else if (dominance.refined > dominance.streetwear + 0.08) {
    score += (refinedish - streetwearish * 0.46 - sporty * 0.18) * (0.58 + dominance.strength * 0.42);
    if (partnerSlot === 'shoes' && (isFormalSubtype(sub) || isSmartCasualShoeSubtype(sub))) score += 0.18 + dominance.strength * 0.18;
    if (partnerSlot === 'bottom' && (sub === 'trousers' || sub === 'tailored trousers' || sub === 'dress pants' || isFormalSubtype(sub))) {
      score += 0.16 + dominance.strength * 0.2;
    }
    if (partnerSlot === 'bottom' && (families.has('denim') || /\bcargo|jogger|track|short\b/.test(text))) score -= 0.34 + dominance.strength * 0.24;
    if (partnerSlot === 'shoes' && (families.has('boot_family') || isAthleticShoeSubtype(sub) || isOpenCasualShoeSubtype(sub))) score -= 0.32 + dominance.strength * 0.28;
  }
  return score;
}

function anchorCarriedCoherence(
  outfit: Outfit,
  slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
): number {
  const entries = outfitItems(outfit);
  if (entries.length < 2) return 0;
  const anchors = entries.filter((entry) => {
    const profile = slotProfiles[entry.slot];
    return profile.lockMode !== 'broad' || profile.specificity >= 0.62;
  });
  if (!anchors.length) return 0;
  let weighted = 0;
  let total = 0;
  for (const anchor of anchors) {
    const dominance = itemStyleDominance(anchor.slot, anchor.item, slotProfiles[anchor.slot]);
    if (dominance.strength < 0.34) continue;
    for (const partner of entries) {
      if (partner.slot === anchor.slot) continue;
      const roleWeight =
        partner.slot === 'shoes' || partner.slot === 'bottom'
          ? 1.1
          : 0.78;
      weighted += partnerAnchorCompatibility(partner.slot, partner.item, dominance) * roleWeight;
      total += roleWeight;
    }
  }
  return total > 0 ? weighted / total : 0;
}

function requiredSlots(intent: PromptIntentV2): Set<CategoryMain> {
  const slots = intent.required_categories.length
    ? intent.required_categories
    : (intent.requested_slots.length ? intent.requested_slots : SLOT_ORDER);
  return new Set(slots);
}

function requiredSlotRuntimeMetrics(
  outfit: Outfit,
  scoreLookup: Record<string, ScoredItem>,
  required: Set<CategoryMain>,
  frontierDiagnostics?: CandidateFrontierDiagnostics,
): {
  admissionMean: number;
  admissionMin: number;
  roleFitMean: number;
  roleFitMin: number;
  familyFitMean: number;
  familyFitMin: number;
  weakestDeficit: number;
  deficitMean: number;
} {
  const entries = outfitItems(outfit)
    .filter((entry) => required.has(entry.slot))
    .map((entry) => ({ slot: entry.slot, score: scoreLookup[entry.item.id] }))
    .filter((entry): entry is { slot: CategoryMain; score: ScoredItem } => !!entry.score);
  if (!entries.length) {
    return {
      admissionMean: 0.5,
      admissionMin: 0.5,
      roleFitMean: 0,
      roleFitMin: 0,
      familyFitMean: 0.5,
      familyFitMin: 0.5,
      weakestDeficit: 0,
      deficitMean: 0,
    };
  }
  const admissions = entries.map((entry) => entry.score.semanticAdmission ?? 0.5);
  const roleFits = entries.map((entry) => entry.score.roleFit ?? 0);
  const familyFits = entries.map((entry) => clamp01(0.5 + (entry.score.familyFit ?? 0)));
  const deficits = entries.map((entry) => {
    const viability = frontierDiagnostics?.slot_semantic_viability?.[entry.slot] ?? 0;
    const floor = frontierDiagnostics?.slot_semantic_valid_floor?.[entry.slot] ?? 0;
    if (viability < 0.32) return 0;
    const admissionDeficit = Math.max(0, floor - (entry.score.semanticAdmission ?? 0.5));
    const roleFitDeficit = Math.max(0, (0.5 + viability * 0.15) - clamp01(0.5 + (entry.score.roleFit ?? 0)));
    const familyFitDeficit = Math.max(0, (0.52 + viability * 0.18) - clamp01(0.5 + (entry.score.familyFit ?? 0)));
    return (admissionDeficit * (1 + viability * 1.05)) + (roleFitDeficit * 0.9) + (familyFitDeficit * 1.25);
  });
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    admissionMean: mean(admissions),
    admissionMin: Math.min(...admissions),
    roleFitMean: mean(roleFits),
    roleFitMin: Math.min(...roleFits),
    familyFitMean: mean(familyFits),
    familyFitMin: Math.min(...familyFits),
    weakestDeficit: Math.max(...deficits),
    deficitMean: mean(deficits),
  };
}

function rerankDivergenceMetrics(
  outfit: Outfit,
  scoreLookup: Record<string, ScoredItem>,
): {
  divergenceCount: number;
  superiorityMean: number;
  superiorityMin: number;
  familyFitGainMean: number;
  familyFitGainMin: number;
  weakestDeficit: number;
} {
  const entries = outfitItems(outfit)
    .map((entry) => scoreLookup[entry.item.id])
    .filter((entry): entry is ScoredItem => !!entry && entry.hybridOwnership !== 'rerank');
  if (!entries.length) {
    return {
      divergenceCount: 0,
      superiorityMean: 0,
      superiorityMin: 0,
      familyFitGainMean: 0,
      familyFitGainMin: 0,
      weakestDeficit: 0,
    };
  }
  const superiorities = entries.map((entry) => entry.rerankSuperiority ?? 0);
  const familyFitGains = entries.map((entry) => (entry.familyFit ?? 0) - (entry.rerankReferenceFamilyFit ?? 0));
  const mean = superiorities.reduce((sum, value) => sum + value, 0) / superiorities.length;
  const min = Math.min(...superiorities);
  const familyFitMean = familyFitGains.reduce((sum, value) => sum + value, 0) / familyFitGains.length;
  const familyFitMin = Math.min(...familyFitGains);
  return {
    divergenceCount: entries.length,
    superiorityMean: mean,
    superiorityMin: min,
    familyFitGainMean: familyFitMean,
    familyFitGainMin: familyFitMin,
    weakestDeficit: Math.max(0, 0.03 - min) + Math.max(0, 0.015 - familyFitMin),
  };
}

export class OutfitAssembler {
  private readonly baseAssembler = new BaseOutfitAssembler();

  public async warmPairwiseCompatibilityCache(candidatesBySlot: Record<CategoryMain, ScoredItem[]>): Promise<void> {
    await this.baseAssembler.warmPairwiseCompatibilityCache(candidatesBySlot);
  }

  private assemblySlotLimit(slot: CategoryMain, intent: PromptIntentV2, poolSize: number, size: number): number {
    const broadness = assemblyPromptBroadness(intent);
    const base =
      poolSize <= 1
        ? { top: 18, bottom: 16, shoes: 18, mono: 14 }[slot]
        : { top: 24, bottom: 20, shoes: 22, mono: 18 }[slot];
    const widened = Math.round(base + broadness * (poolSize <= 1 ? 8 : 10));
    return Math.min(size, Math.max(poolSize <= 1 ? 12 : 16, widened));
  }

  private trimCandidatesForAssembly(
    candidatesBySlot: Record<CategoryMain, ScoredItem[]>,
    intent: PromptIntentV2,
    poolSize: number,
  ): Record<CategoryMain, ScoredItem[]> {
    const broadness = assemblyPromptBroadness(intent);
    const noveltyWeight = 0.38 + broadness * 1.15;
    const trimmed: Record<CategoryMain, ScoredItem[]> = { top: [], bottom: [], shoes: [], mono: [] };
    for (const slot of SLOT_ORDER) {
      const candidates = candidatesBySlot[slot] || [];
      const limit = this.assemblySlotLimit(slot, intent, poolSize, candidates.length);
      trimmed[slot] = selectAssemblyCandidates(candidates, limit, noveltyWeight);
    }
    return trimmed;
  }

  private trimOutfitsBeforeRerank(
    outfits: Outfit[],
    intent: PromptIntentV2,
    scoreLookup: Record<string, ScoredItem>,
    poolSize: number,
  ): Outfit[] {
    const limit = approximateOutfitBandLimit(intent, poolSize);
    if (outfits.length <= limit) return outfits;

    const ranked = outfits
      .map((outfit) => ({ outfit, score: approximateOutfitScore(outfit, scoreLookup), signature: outfitSignature(outfit) }))
      .sort((a, b) => b.score - a.score);
    const selected: Outfit[] = [];
    const usedSignatures = new Set<string>();
    const broadness = assemblyPromptBroadness(intent);
    const familySeen: Record<CategoryMain, Set<string>> = { top: new Set(), bottom: new Set(), shoes: new Set(), mono: new Set() };
    const pushOutfit = (outfit: Outfit): boolean => {
      const signature = outfitSignature(outfit);
      if (usedSignatures.has(signature)) return false;
      usedSignatures.add(signature);
      selected.push(outfit);
      for (const { slot, item } of outfitItems(outfit)) {
        const family = scoreLookup[item.id]?.family || canonicalizeSubtype(item.sub || '');
        if (family) familySeen[slot].add(family);
      }
      return true;
    };

    if (broadSemanticOutfitIntent(intent) && fullOutfitDiversityIntent(intent)) {
      const oldMoneyMen = oldMoneyMensIntent(intent);
      const seedSpan = Math.min(limit, Math.max(poolSize * 2, 24));
      const seedSource = ranked.slice(0, seedSpan);
      const uniqueCountFor = (slot: CategoryMain) => new Set(
        seedSource.map((candidate) => candidate.outfit[slot]?.id || '').filter(Boolean),
      ).size;
      const seedSlotIds = (
        slot: CategoryMain,
        target: number,
        allowFamilies = false,
      ) => {
        const seenIds = new Set<string>();
        const seenSeedFamilies = new Set<string>();
        for (const candidate of seedSource) {
          const item = candidate.outfit[slot];
          if (!item) continue;
          const id = item.id;
          const family = scoreLookup[id]?.family || canonicalizeSubtype(item.sub || '');
          if (seenIds.has(id)) continue;
          if (allowFamilies && family && seenSeedFamilies.has(family)) continue;
          if (!pushOutfit(candidate.outfit)) continue;
          seenIds.add(id);
          if (family) seenSeedFamilies.add(family);
          if (seenIds.size >= target) break;
        }
      };
      seedSlotIds('top', Math.min(uniqueCountFor('top'), oldMoneyMen ? Math.max(8, Math.ceil(poolSize * 0.68)) : Math.max(5, Math.ceil(poolSize * 0.45))), true);
      seedSlotIds('shoes', Math.min(uniqueCountFor('shoes'), Math.max(4, Math.ceil(poolSize * 0.35))), true);
      seedSlotIds('bottom', Math.min(uniqueCountFor('bottom'), Math.max(4, Math.ceil(poolSize * 0.32))), false);
    }

    for (const candidate of ranked) {
      if (selected.length >= limit) break;
      if (usedSignatures.has(candidate.signature)) continue;
      let keep = true;
      if (broadness >= 0.45) {
        for (const { slot, item } of outfitItems(candidate.outfit)) {
          const family = scoreLookup[item.id]?.family || canonicalizeSubtype(item.sub || '');
          if (!family) continue;
          if (familySeen[slot].has(family) && selected.length < Math.round(limit * 0.72)) {
            keep = false;
            break;
          }
        }
      }
      if (!keep) continue;
      pushOutfit(candidate.outfit);
    }

    if (selected.length >= Math.min(limit, 24)) return selected;
    for (const candidate of ranked) {
      if (selected.length >= limit) break;
      if (usedSignatures.has(candidate.signature)) continue;
      pushOutfit(candidate.outfit);
    }
    return selected;
  }

  private pickSingleLook(
    boosted: ScoredOutfit[],
    intent: PromptIntentV2,
    epsilon: number,
  ): ScoredOutfit[] {
    if (!boosted.length) return [];
    const broadness = assemblyPromptBroadness(intent);
    const shortlistBase = broadSemanticOutfitIntent(intent) ? 7 : 3;
    const shortlistSize = Math.max(1, Math.min(boosted.length, shortlistBase + Math.round(broadness * 3)));
    const floor = boosted[0].score - (0.9 + broadness * 1.9);
    const shortlist = boosted
      .filter((look, index) => index < shortlistSize || look.score >= floor)
      .slice(0, Math.max(shortlistSize, broadSemanticOutfitIntent(intent) ? 10 : 6));
    const pickWindow = shortlist.slice(0, Math.max(1, Math.min(shortlist.length, broadSemanticOutfitIntent(intent) ? (4 + Math.round(broadness * 5)) : (2 + Math.round(broadness * 4)))));
    if (pickWindow.length <= 1) return pickWindow.slice(0, 1);
    const anchorScore = pickWindow[0].score;
    const pickOutfits = pickWindow.map((look) => look.outfit);
    const weights = pickWindow.map((look, index) => {
      const gap = Math.max(0, anchorScore - look.score);
      const closeness = Math.exp(-gap / (0.7 + broadness * 1.45 + epsilon * 3.2));
      const rankPrior = 1 / (1 + index * 0.18);
      const rarity = 1 + broadFinalistRarityBonus(pickOutfits, index) * (0.32 + broadness * 0.36);
      return closeness * rankPrior * rarity;
    });
    return [weightedChoice(pickWindow, weights, requestRandom)];
  }

  public assembleOutfits(
    candidatesBySlot: Record<CategoryMain, ScoredItem[]>,
    intent: PromptIntentV2,
    scoreLookup: Record<string, ScoredItem>,
    slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
    poolSize: number,
  ): Outfit[] {
    const trimmedCandidates = this.trimCandidatesForAssembly(candidatesBySlot, intent, poolSize);
    const outfits = this.baseAssembler.assembleOutfits(trimmedCandidates, intent, scoreLookup, slotProfiles, poolSize);
    return this.trimOutfitsBeforeRerank(outfits, intent, scoreLookup, poolSize);
  }

  private semanticWeight(
    intent: PromptIntentV2,
    embeddingMode: EmbeddingMode,
    informativeness: number,
    controls: RuntimeSemanticControls,
  ): number {
    if (embeddingMode === 'off') return 0;
    const regime = promptRegime(intent, controls, informativeness);
    let weight = embeddingMode === 'hybrid' ? 3.1 : 1.4;
    const subjectRichness = Math.min(2, 0.35 + intent.semantic_subjects.length * 0.2 + (
      intent.semantic_subjects.reduce((sum, subject) => sum + subject.style_axes.length + subject.silhouette_terms.length + subject.palette_terms.length, 0) * 0.03
    ));
    if (intent.semantic_subjects.length) weight += subjectRichness;
    if (intent.semantic_subjects.some((subject) => subject.kind === 'persona' || subject.kind === 'style_archetype' || subject.kind === 'theme')) {
      weight += 0.55;
    }
    if (intent.semantic_subjects.some((subject) => subject.scope === 'slot')) weight += 0.2;
    if (broadSemanticOutfitIntent(intent)) weight *= 0.72;
    if (embeddingMode === 'hybrid' && regime === 'constraint_dominant') weight = Math.min(weight, 1.45);
    if (embeddingMode === 'hybrid' && regime === 'semantic_dominant') weight += 0.28;
    return weight;
  }

  private semanticBoostGuard(intent: PromptIntentV2, baseBand: ScoredOutfit[]): number {
    if (!broadSemanticOutfitIntent(intent)) return 1;
    const scoped = baseBand.slice(0, Math.min(baseBand.length, 12));
    if (!scoped.length) return 0.6;
    const uniqueSignatures = new Set(scoped.map((look) => SLOT_ORDER.map((slot) => look.outfit[slot]?.id || '').filter(Boolean).join('|'))).size;
    const signatureRatio = uniqueSignatures / scoped.length;
    if (scoped.length < 6) return 0.58;
    if (signatureRatio < 0.45) return 0.68;
    if (signatureRatio < 0.65) return 0.82;
    return 1;
  }

  private selectFinalDiversified(
    scored: ScoredOutfit[],
    intent: PromptIntentV2,
    slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
    promptEmbeddings: PromptEmbeddingState,
    scoreLookup: Record<string, ScoredItem>,
    frontierDiagnostics: CandidateFrontierDiagnostics | undefined,
    poolSize: number,
    epsilon: number,
  ): ScoredOutfit[] {
    const selected: ScoredOutfit[] = [];
    const informativeness = Math.max(0, Math.min(1, promptEmbeddings.semanticInformativeness ?? 0));
    const controls = deriveRuntimeSemanticControls(intent, promptEmbeddings.semanticAxisProfile, informativeness);
    const regime = promptRegime(intent, controls, informativeness);
    const required = requiredSlots(intent);
    const semanticDiscipline = clamp01(
      controls.rolePurityWeight * 0.62 +
      controls.structureRichness * 0.18 +
      (1 - controls.sportTolerance) * 0.14 -
      controls.noiseTolerance * 0.16,
    );
    const hasConstraintCleanAlternatives = scored.some((look) => outfitRuntimeMetrics(look.outfit, scoreLookup).cleanlinessMin >= 0.999);
    const hasAnchorPreservingAlternatives = scored.some((look) => outfitRuntimeMetrics(look.outfit, scoreLookup).anchorMin >= 0.58);
    const hasRequiredSemanticAlternatives = scored.some((look) => requiredSlotRuntimeMetrics(look.outfit, scoreLookup, required, frontierDiagnostics).weakestDeficit <= 0.08);
    const hasPaletteCoverageAlternatives = explicitPaletteCoverageIntent(intent) &&
      scored.some((look) => paletteTargetCoverage(look.outfit, intent) > 0);
    const remaining = [...scored].filter((look) => {
      const runtime = outfitRuntimeMetrics(look.outfit, scoreLookup);
      const requiredRuntime = requiredSlotRuntimeMetrics(look.outfit, scoreLookup, required, frontierDiagnostics);
      if (hasConstraintCleanAlternatives && controls.explicitConstraintStrength >= 0.26 && runtime.cleanlinessMin < 0.999) return false;
      if (hasAnchorPreservingAlternatives && controls.explicitConstraintStrength >= 0.26 && runtime.anchorMin < 0.42) return false;
      if (hasRequiredSemanticAlternatives && controls.semanticExpansionStrength >= 0.4 && semanticDiscipline >= 0.32 && requiredRuntime.weakestDeficit > 0.24) return false;
      if (hasPaletteCoverageAlternatives && paletteTargetCoverage(look.outfit, intent) <= 0) return false;
      return true;
    });
    const usedSignatures = new Set<string>();
    const seenCoreSignatures = new Set<string>();
    const seenIds: Record<CategoryMain, Set<string>> = { top: new Set(), bottom: new Set(), shoes: new Set(), mono: new Set() };
    const seenFamilies: Record<CategoryMain, Set<string>> = { top: new Set(), bottom: new Set(), shoes: new Set(), mono: new Set() };
    const personaScopedSlots = new Set(semanticSubjectSlots(intent));
    const coverageTargets = diversityTargets(scored, intent, poolSize);

    while (selected.length < poolSize && remaining.length) {
      const rescored: Array<{ candidate: ScoredOutfit; adjusted: number; signature: string }> = [];
      const semanticRichSelection =
        controls.semanticExpansionStrength >= 0.54 &&
        controls.explicitConstraintStrength <= 0.28 &&
        broadSemanticOutfitIntent(intent);
      const bestPurityInBand = semanticRichSelection
        ? remaining.reduce((best, look) => Math.max(best, outfitSemanticMetrics(promptEmbeddings.semanticAxisProfile, look.outfit).combined), 0)
        : 0;
      const bestAdmissionInBand = semanticRichSelection
        ? remaining.reduce((best, look) => Math.max(best, outfitRuntimeMetrics(look.outfit, scoreLookup).admissionMean), 0)
        : 0;
      const bestFocusCoverage = remaining.reduce((best, look) => Math.max(best, outfitFocusCoverage(look.outfit, intent).ratio), 0);
      const bestBrandHits =
        intent.brand_fit_mode !== 'none'
          ? remaining.reduce((best, look) => Math.max(best, outfitBrandCoverage(look.outfit, intent).hits), 0)
          : 0;
      const bestBrandCoverage =
        intent.brand_fit_mode !== 'none'
          ? remaining.reduce((best, look) => Math.max(best, outfitBrandCoverage(look.outfit, intent).ratio), 0)
          : 0;
      const coverageNeeds = SLOT_ORDER
        .map((slot) => {
          const target = coverageTargets[slot] || 0;
          if (!target || slotProfiles[slot].diversityExempt) return { slot, need: 0 };
          return {
            slot,
            need: Math.max(0, target - seenIds[slot].size) * (slot === 'top' ? 1.35 : slot === 'bottom' ? 1.15 : 0.55),
          };
        })
        .filter((entry) => entry.need > 0)
        .sort((a, b) => b.need - a.need);
      const prioritySlots = coverageNeeds.length
        ? coverageNeeds.filter((entry) => entry.need >= coverageNeeds[0].need * 0.82).map((entry) => entry.slot)
        : [];

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        let adjusted = candidate.score;
        const signature = SLOT_ORDER.map((slot) => candidate.outfit[slot]?.id || '').filter(Boolean).sort().join('|');
        if (usedSignatures.has(signature)) continue;
        const purity = outfitSemanticMetrics(promptEmbeddings.semanticAxisProfile, candidate.outfit);
        const runtime = outfitRuntimeMetrics(candidate.outfit, scoreLookup);
        const requiredRuntime = requiredSlotRuntimeMetrics(candidate.outfit, scoreLookup, required, frontierDiagnostics);
        const rerankRuntime = rerankDivergenceMetrics(candidate.outfit, scoreLookup);
        const paletteCoverage = paletteTargetCoverage(candidate.outfit, intent);
        const anchorCoherence = anchorCarriedCoherence(candidate.outfit, slotProfiles);
        const focusCoverage = outfitFocusCoverage(candidate.outfit, intent);
        const brandCoverage = outfitBrandCoverage(candidate.outfit, intent);
        adjusted += (purity.combined - 0.52) * (0.45 + controls.rolePurityWeight * 1.15);
        adjusted += (purity.min - 0.5) * (0.2 + controls.rolePurityWeight * 0.7);
        adjusted -= purity.spread * (0.08 + (1 - controls.diversityEnvelope) * 0.32);
        adjusted += (runtime.roleFitMean * (0.18 + controls.rolePurityWeight * 0.55));
        adjusted += ((runtime.cleanlinessMean - 0.5) * (controls.explicitConstraintStrength * 1.8));
        adjusted += ((runtime.admissionMean - 0.5) * (controls.semanticExpansionStrength * 1.2));
        adjusted += ((runtime.anchorMean - 0.5) * (controls.explicitConstraintStrength * 1.5));
        adjusted += semanticDiscipline * ((requiredRuntime.admissionMean - 0.5) * (0.45 + controls.semanticExpansionStrength * 1.1));
        adjusted += semanticDiscipline * (requiredRuntime.roleFitMean * (0.12 + controls.rolePurityWeight * 0.34));
        adjusted += semanticDiscipline * ((requiredRuntime.familyFitMean - 0.5) * (0.34 + controls.rolePurityWeight * 0.62));
        adjusted += semanticDiscipline * ((requiredRuntime.familyFitMin - 0.5) * (0.28 + controls.rolePurityWeight * 0.58));
        adjusted -= semanticDiscipline * requiredRuntime.weakestDeficit * (1.9 + controls.semanticExpansionStrength * 2.8 + controls.rolePurityWeight * 1.8);
        adjusted -= semanticDiscipline * requiredRuntime.deficitMean * (1.05 + controls.semanticExpansionStrength * 1.45);
        adjusted += rerankRuntime.superiorityMean * (0.14 + controls.semanticExpansionStrength * 0.38);
        adjusted += rerankRuntime.familyFitGainMean * (0.24 + controls.rolePurityWeight * 0.3);
        adjusted -= rerankRuntime.weakestDeficit * (1.2 + controls.semanticExpansionStrength * 1.7 + controls.rolePurityWeight * 0.95);
        adjusted += anchorCoherence * (0.95 + controls.rolePurityWeight * 0.5);
        if (explicitPaletteCoverageIntent(intent)) {
          adjusted += paletteCoverage * (0.7 + controls.paletteStrictness * 1.1);
          if (paletteCoverage <= 0 && hasPaletteCoverageAlternatives) {
            adjusted -= 3.2 + controls.paletteStrictness * 2.4;
          }
        }
        if (semanticRichSelection) {
          const semanticFloor = bestPurityInBand - (0.22 - informativeness * 0.06);
          if (purity.combined < semanticFloor) {
            adjusted -= (semanticFloor - purity.combined) * (2.6 + informativeness * 3.2);
          }
          const admissionFloor = bestAdmissionInBand - Math.max(0.12, 0.26 - controls.diversityEnvelope * 0.12);
          if (runtime.admissionMean < admissionFloor) {
            adjusted -= (admissionFloor - runtime.admissionMean) * (2 + controls.rolePurityWeight * 2.6);
          }
        }
        if (focusCoverage.hits > 0) {
          adjusted += focusCoverage.hits * (1.4 + controls.rolePurityWeight * 0.55);
          adjusted += focusCoverage.ratio * (0.9 + controls.semanticExpansionStrength * 0.45);
        } else if (bestFocusCoverage > 0.34) {
          adjusted -= 2.4 + bestFocusCoverage * 2.2;
        }
        if (intent.brand_fit_mode === 'single_brand_presence') {
          if (brandCoverage.hits > 0) {
            adjusted += 4.8 + brandCoverage.hits * 1.2 + brandCoverage.ratio * 1.4;
          } else if (bestBrandCoverage > 0) {
            adjusted -= 9.5 + bestBrandCoverage * 3.4;
          }
        } else if (intent.brand_fit_mode === 'full_brand_coverage') {
          adjusted += brandCoverage.hits * 4.8 + brandCoverage.ratio * 8.4;
          if (bestBrandHits > brandCoverage.hits) {
            adjusted -= (bestBrandHits - brandCoverage.hits) * (11.6 + controls.rolePurityWeight * 2.8);
          }
          if (bestBrandCoverage > brandCoverage.ratio) {
            adjusted -= (bestBrandCoverage - brandCoverage.ratio) * 11.8;
          }
        }

        for (const slot of SLOT_ORDER) {
          if (slotProfiles[slot].diversityExempt) continue;
          const item = candidate.outfit[slot];
          if (!item) continue;
          if (seenIds[slot].has(item.id)) {
            adjusted -= personaScopedSlots.has(slot) ? 1.2 : 3.6;
          } else {
            adjusted += personaScopedSlots.has(slot) ? 0.25 : 1.1;
          }
        }

        for (const prior of selected) {
          if (candidate.vector.length && prior.vector.length) {
            adjusted -= cosineSimilarity(candidate.vector, prior.vector) * (0.75 + controls.diversityEnvelope * 0.7);
          }
        }
        adjusted += semanticPalettePrior(candidate.outfit, intent, promptEmbeddings.semanticAxisProfile, informativeness);
        if (prioritySlots.length) {
          adjusted += candidateCoverageGain(
            candidate,
            scoreLookup,
            seenIds,
            seenFamilies,
            coverageTargets,
            slotProfiles,
            prioritySlots,
          ) * 1.35;
        }
        const coreSignature = coreOutfitSignature(candidate.outfit);
        if (coreSignature && broadSemanticOutfitIntent(intent)) {
          if (!seenCoreSignatures.has(coreSignature)) adjusted += 3.2;
          else adjusted -= 6.6;
        }
        rescored.push({ candidate, adjusted, signature });
      }
      if (!rescored.length) break;
      rescored.sort((a, b) => b.adjusted - a.adjusted);
      const coveragePool = prioritySlots.length
        ? rescored
            .filter((entry) => candidateImprovesCoverage(
              entry.candidate,
              scoreLookup,
              seenIds,
              seenFamilies,
              coverageTargets,
              slotProfiles,
              prioritySlots,
            ))
            .sort((a, b) => {
              const gainDiff =
                candidateCoverageGain(b.candidate, scoreLookup, seenIds, seenFamilies, coverageTargets, slotProfiles, prioritySlots) -
                candidateCoverageGain(a.candidate, scoreLookup, seenIds, seenFamilies, coverageTargets, slotProfiles, prioritySlots);
              if (gainDiff !== 0) return gainDiff;
              return b.adjusted - a.adjusted;
            })
        : [];
      let finalistPool = shortlistFinalists(
        coveragePool.length ? coveragePool : rescored,
        Math.max(controls.diversityEnvelope, broadSemanticOutfitIntent(intent) ? 0.72 : controls.diversityEnvelope),
        poolSize,
      );
      if (broadSemanticOutfitIntent(intent) && finalistPool.length > 1) {
        const finalistOutfits = finalistPool.map((entry) => entry.candidate.outfit);
        finalistPool = finalistPool
          .map((entry, index) => ({
            ...entry,
            adjusted:
              entry.adjusted +
              broadFinalistRarityBonus(finalistOutfits, index) * (1.05 + assemblyPromptBroadness(intent) * 1.15) +
              (
                oldMoneyMensIntent(intent)
                  ? Math.max(0, 3 - finalistOutfits.filter((outfit) => outfit.top?.id && outfit.top.id === finalistOutfits[index].top?.id).length) * 0.65
                  : 0
              ),
          }))
          .sort((a, b) => b.adjusted - a.adjusted);
      }
      const chosenEntry = sampleFinalist(finalistPool, controls.diversityEnvelope, epsilon, poolSize);
      const chosen = chosenEntry.candidate;
      const signature = chosenEntry.signature;
      const chosenIndex = remaining.findIndex((entry) => entry === chosen);
      if (chosenIndex >= 0) remaining.splice(chosenIndex, 1);
      if (usedSignatures.has(signature)) continue;
      usedSignatures.add(signature);
      selected.push(chosen);
      const chosenCoreSignature = coreOutfitSignature(chosen.outfit);
      if (chosenCoreSignature) seenCoreSignatures.add(chosenCoreSignature);
      for (const slot of SLOT_ORDER) {
        const item = chosen.outfit[slot];
        if (item) {
          seenIds[slot].add(item.id);
          const family = scoreLookup[item.id]?.family || canonicalizeSubtype(item.sub || '');
          if (family) seenFamilies[slot].add(family);
        }
      }
    }

    return selected;
  }

  public scoreAndDiversify(
    outfits: Outfit[],
    intent: PromptIntentV2,
    slotProfiles: Record<CategoryMain, SlotConstraintProfile>,
    scoreLookup: Record<string, ScoredItem>,
    promptEmbeddings: PromptEmbeddingState,
    embeddings: LoadedEmbeddings,
    embeddingMode: EmbeddingMode,
    poolSize: number,
    jitter: number,
    epsilon: number,
    frontierDiagnostics: CandidateFrontierDiagnostics | undefined,
    debug: boolean,
  ): ScoredOutfit[] {
    const singleLookMode = poolSize <= 1;
    const broadPrompt = broadSemanticOutfitIntent(intent);
    const bandSize =
      singleLookMode
        ? (intent.palette_mode === 'unconstrained' ? 12 : 18)
        : (
            intent.palette_mode === 'unconstrained'
              ? Math.max(poolSize * 2, broadPrompt ? 24 : 18)
              : Math.max(poolSize * 3, broadPrompt ? 36 : 24)
          );
    const baseBand = this.baseAssembler.scoreAndDiversify(
      outfits,
      intent,
      slotProfiles,
      scoreLookup,
      promptEmbeddings,
      embeddings,
      embeddingMode,
      bandSize,
      jitter,
      epsilon,
      debug,
    );

    if (embeddingMode === 'off' || !baseBand.length) {
      return baseBand.slice(0, poolSize);
    }

    const informativeness = Math.max(0, Math.min(1, promptEmbeddings.semanticInformativeness ?? 0));
    const controls = deriveRuntimeSemanticControls(intent, promptEmbeddings.semanticAxisProfile, informativeness);
    const regime = promptRegime(intent, controls, informativeness);
    const semanticWeight =
      this.semanticWeight(intent, embeddingMode, informativeness, controls) *
      this.semanticBoostGuard(intent, baseBand) *
      (0.88 + informativeness * 0.22);
    const required = requiredSlots(intent);
    const semanticDiscipline = clamp01(
      controls.rolePurityWeight * 0.62 +
      controls.structureRichness * 0.18 +
      (1 - controls.sportTolerance) * 0.14 -
      controls.noiseTolerance * 0.16,
    );
    const boosted = baseBand
      .map((look) => {
        const purity = outfitSemanticMetrics(promptEmbeddings.semanticAxisProfile, look.outfit);
        const runtime = outfitRuntimeMetrics(look.outfit, scoreLookup);
        const requiredRuntime = requiredSlotRuntimeMetrics(look.outfit, scoreLookup, required, frontierDiagnostics);
        const rerankRuntime = rerankDivergenceMetrics(look.outfit, scoreLookup);
        const paletteCoverage = paletteTargetCoverage(look.outfit, intent);
        const anchorCoherence = anchorCarriedCoherence(look.outfit, slotProfiles);
        const purityBoost =
          ((purity.combined - 0.52) * (0.82 + controls.rolePurityWeight * 1.2)) +
          ((purity.min - 0.5) * (0.28 + controls.rolePurityWeight * 0.8)) -
          (purity.spread * (0.1 + (1 - controls.diversityEnvelope) * 0.26));
        const runtimeBoost =
          ((runtime.cleanlinessMean - 0.5) * (controls.explicitConstraintStrength * 1.8)) +
          ((runtime.admissionMean - 0.5) * (controls.semanticExpansionStrength * 1.4)) +
          (runtime.roleFitMean * (0.2 + controls.rolePurityWeight * 0.5)) +
          ((runtime.anchorMean - 0.5) * (controls.explicitConstraintStrength * 1.4));
        const requiredRuntimeBoost =
          semanticDiscipline * (
            ((requiredRuntime.admissionMean - 0.5) * (0.55 + controls.semanticExpansionStrength * 1.2)) +
            (requiredRuntime.roleFitMean * (0.14 + controls.rolePurityWeight * 0.34)) -
            ((0.5 - requiredRuntime.familyFitMean) * (0.42 + controls.rolePurityWeight * 0.62)) -
            ((0.5 - requiredRuntime.familyFitMin) * (0.46 + controls.rolePurityWeight * 0.68)) -
            (requiredRuntime.weakestDeficit * (2.1 + controls.semanticExpansionStrength * 2.9 + controls.rolePurityWeight * 1.9)) -
            (requiredRuntime.deficitMean * (1.15 + controls.semanticExpansionStrength * 1.55))
          );
        const rerankRuntimeBoost =
          (rerankRuntime.superiorityMean * (0.16 + controls.semanticExpansionStrength * 0.42)) -
          (Math.max(0, -rerankRuntime.familyFitGainMean) * (0.88 + controls.rolePurityWeight * 0.82)) +
          (Math.max(0, rerankRuntime.familyFitGainMean) * (0.26 + controls.rolePurityWeight * 0.34)) -
          (rerankRuntime.weakestDeficit * (1.26 + controls.semanticExpansionStrength * 1.8 + controls.rolePurityWeight * 1.02));
        const paletteCoverageBoost =
          explicitPaletteCoverageIntent(intent)
            ? (
                paletteCoverage * (0.9 + controls.paletteStrictness * 1.3) -
                (paletteCoverage <= 0 ? (2.4 + controls.paletteStrictness * 2.4) : 0)
              )
            : 0;
        const regimeGuard =
          embeddingMode === 'hybrid' && regime === 'constraint_dominant'
            ? Math.min(0, (purity.combined - 0.52) * 0.3)
            : 0;
        return {
          ...look,
          score:
            look.score +
            (look.semantic * semanticWeight) +
            purityBoost +
            runtimeBoost +
            requiredRuntimeBoost +
            rerankRuntimeBoost +
            (anchorCoherence * (1.05 + controls.rolePurityWeight * 0.6)) +
            paletteCoverageBoost +
            regimeGuard +
            paletteAdjustment(look.outfit, intent) +
            semanticPalettePrior(look.outfit, intent, promptEmbeddings.semanticAxisProfile, informativeness),
        };
      })
      .sort((a, b) => b.score - a.score);

    if (singleLookMode) {
      return this.pickSingleLook(boosted, intent, epsilon);
    }

    return this.selectFinalDiversified(boosted, intent, slotProfiles, promptEmbeddings, scoreLookup, frontierDiagnostics, poolSize, epsilon);
  }
}
