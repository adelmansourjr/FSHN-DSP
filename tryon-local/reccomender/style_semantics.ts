import {
  CategoryMain,
  IndexItem,
  OccasionTag,
  PromptIntent,
  SLOT_ORDER,
  canonicalizeSubtype,
  inferItemOccasionTags,
  isAthleticShoeSubtype,
  isFormalSubtype,
  isHeelFamilySubtype,
  isLoungeSubtype,
  isOpenCasualShoeSubtype,
  isSleepwearSubtype,
  isSmartCasualShoeSubtype,
  normalizeText,
  subtypeFamily,
} from './fashion_taxonomy';
import { SemanticCorpusStats, filterCorpusTerms } from './canonical_index';
import { uniq } from './text';

export const STYLE_MARKERS = [
  'graphic',
  'logo',
  'distressed',
  'embroidered',
  'embellished',
  'camouflage',
  'technical',
  'tailored',
  'knit',
  'denim',
  'leather',
  'suede',
  'linen',
  'sport_kit',
  'outerwear',
  'clean_basic',
] as const;

export type StyleMarker = (typeof STYLE_MARKERS)[number];

export interface StyleSignals {
  style_markers: StyleMarker[];
  formality_score: number;
  streetwear_score: number;
  cleanliness_score: number;
  comfort_score: number;
  sportiness_score: number;
  openness_score: number;
  classic_score: number;
}

export interface SemanticAxisProfile {
  refined: number;
  classic: number;
  minimal: number;
  relaxed: number;
  structured: number;
  neutral: number;
  understated: number;
  sporty: number;
  streetwear: number;
  graphic: number;
}

export interface RuntimeSemanticControls {
  structureRichness: number;
  aestheticPurity: number;
  noiseTolerance: number;
  sportTolerance: number;
  paletteStrictness: number;
  slotRoleSpecificity: number;
  explicitConstraintStrength: number;
  semanticExpansionStrength: number;
  rolePurityWeight: number;
  diversityEnvelope: number;
  stageProtectionRelaxation: number;
}

export interface SemanticTextBundle {
  general: string;
  identity: string;
  style: string;
  slots: Partial<Record<CategoryMain, string>>;
  slot_identity: Partial<Record<CategoryMain, string>>;
  slot_style: Partial<Record<CategoryMain, string>>;
}

interface SemanticBundleOptions {
  corpus?: SemanticCorpusStats | null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function uniqueNormalized(values: Array<string | null | undefined>): string[] {
  return uniq(values.map((value) => normalizeText(value)).filter(Boolean));
}

function joinParts(parts: Array<string | null | undefined>): string {
  return normalizeText(parts.filter(Boolean).join(' | '));
}

function baseItemText(item: Partial<IndexItem>): string {
  return normalizeText([
    item.sub || '',
    item.name || '',
    item.name_normalized || '',
    ...(item.identity_entities || []),
    ...(item.vibes || []),
    ...(item.occasion_tags || []),
    ...(item.entities || []),
    ...((item.entityMeta || []).map((entity) => entity.text || '')),
  ].join(' '));
}

function inferredOccasions(item: Partial<IndexItem>): OccasionTag[] {
  return item.occasion_tags?.length ? item.occasion_tags : inferItemOccasionTags(item);
}

function semanticMaterialTags(text: string, signals: StyleSignals): string[] {
  const tags = new Set<string>();
  if (signals.style_markers.includes('linen')) tags.add('linen');
  if (signals.style_markers.includes('leather')) tags.add('leather');
  if (signals.style_markers.includes('suede')) tags.add('suede');
  if (/\bcotton\b/.test(text)) tags.add('cotton');
  if (/\bwool|cashmere|merino|alpaca|mohair\b/.test(text)) tags.add('wool');
  if (/\bdenim\b/.test(text)) tags.add('denim');
  if (/\bnylon|polyester|shell|technical\b/.test(text)) tags.add('technical_fabric');
  return Array.from(tags);
}

function semanticSilhouetteTags(item: Partial<IndexItem>, text: string, sub: string): string[] {
  const tags = new Set<string>();
  if (item.fit) tags.add(item.fit);
  if (/\brelaxed|wide leg|wide-leg|straight leg|straight-leg\b/.test(text)) tags.add('relaxed');
  if (/\btailored|slim|tapered|structured\b/.test(text)) tags.add('structured');
  if (/\bover(?:sized)?|boxy\b/.test(text)) tags.add('oversized');
  if (/\bcropped\b/.test(text)) tags.add('cropped');
  const families = subtypeFamily(sub);
  if (families.includes('outerwear_family')) tags.add('layering_piece');
  if (families.includes('soft_top_layer')) tags.add('soft_layer');
  if (families.includes('denim')) tags.add('denim_silhouette');
  return Array.from(tags);
}

function semanticPolishTags(item: Partial<IndexItem>, signals: StyleSignals): string[] {
  const tags = new Set<string>();
  if (signals.classic_score >= 0.65) tags.add('classic_leaning');
  if (signals.formality_score >= 0.68) tags.add('polished');
  else if (signals.formality_score >= 0.48) tags.add('smart_casual_polished');
  if (signals.cleanliness_score >= 0.72) tags.add('clean_finish');
  if (signals.cleanliness_score <= 0.38) tags.add('noisy_finish');
  if (signals.comfort_score >= 0.68) tags.add('comfort_leaning');
  if (signals.openness_score >= 0.58) tags.add('warm_weather');
  if (signals.streetwear_score >= 0.58) tags.add('streetwear_leaning');
  if (signals.sportiness_score >= 0.58 || (item.sportMeta?.sport && item.sportMeta.sport !== 'none')) tags.add('sport_leaning');
  return Array.from(tags);
}

function semanticPaletteTags(colours: string[], signals: StyleSignals): string[] {
  const tags = new Set<string>();
  if (!colours.length) return [];
  const neutral = new Set(['black', 'white', 'grey', 'beige', 'brown']);
  const earth = new Set(['beige', 'brown', 'green']);
  const neutralCount = colours.filter((colour) => neutral.has(colour)).length;
  const chromaticCount = colours.length - neutralCount;
  if (neutralCount === colours.length) tags.add('neutral');
  if (colours.some((colour) => earth.has(colour))) tags.add('earth_tones');
  if (chromaticCount === 0 && colours.length <= 2) tags.add('monochromatic');
  if (chromaticCount <= 1 && signals.cleanliness_score >= 0.62) tags.add('muted');
  if (colours.every((colour) => ['black', 'grey', 'brown'].includes(colour))) tags.add('dark_neutral');
  if (colours.every((colour) => ['white', 'beige', 'grey'].includes(colour))) tags.add('light_neutral');
  return Array.from(tags);
}

function neutralColourRatio(colours: string[]): number {
  if (!colours.length) return 0;
  const neutral = new Set(['black', 'white', 'grey', 'beige', 'brown']);
  return colours.filter((colour) => neutral.has(colour)).length / colours.length;
}

function loudMarkerCount(signals: StyleSignals): number {
  return [
    'graphic',
    'logo',
    'distressed',
    'embellished',
    'camouflage',
    'sport_kit',
  ].filter((marker) => signals.style_markers.includes(marker as StyleMarker)).length;
}

export function bucketSemanticAxis(value: number): 'low' | 'medium' | 'high' {
  if (value >= 0.67) return 'high';
  if (value >= 0.34) return 'medium';
  return 'low';
}

export function semanticAxisText(profile: SemanticAxisProfile): string {
  return joinParts([
    `axes refined ${bucketSemanticAxis(profile.refined)}`,
    `classic ${bucketSemanticAxis(profile.classic)}`,
    `minimal ${bucketSemanticAxis(profile.minimal)}`,
    `relaxed ${bucketSemanticAxis(profile.relaxed)}`,
    `structured ${bucketSemanticAxis(profile.structured)}`,
    `neutral ${bucketSemanticAxis(profile.neutral)}`,
    `understated ${bucketSemanticAxis(profile.understated)}`,
    `sporty ${bucketSemanticAxis(profile.sporty)}`,
    `streetwear ${bucketSemanticAxis(profile.streetwear)}`,
    `graphic ${bucketSemanticAxis(profile.graphic)}`,
  ]);
}

export function deriveRuntimeSemanticControls(
  intent: Partial<PromptIntent> | null | undefined,
  profile: SemanticAxisProfile | null | undefined,
  informativeness = 0,
): RuntimeSemanticControls {
  const safe = profile || {
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
  const semanticDirectives = (intent as {
    semantic_directives?: {
      style_axes?: string[];
      silhouette_terms?: string[];
      palette_terms?: string[];
    };
  } | null)?.semantic_directives;
  const requiredSlots = new Set([
    ...((intent?.required_categories || []) as CategoryMain[]),
    ...((intent?.optional_categories || []) as CategoryMain[]),
    ...(((intent as { requested_slots?: CategoryMain[] } | null)?.requested_slots || []) as CategoryMain[]),
  ]);
  const slotScopedSubjects = (((intent as { semantic_subjects?: Array<{ scope?: string; slots?: CategoryMain[] }> } | null)?.semantic_subjects) || [])
    .filter((subject) => subject.scope === 'slot' || (subject.slots || []).length > 0);
  const slotConstraintSignals = SLOT_ORDER.reduce((sum, slot) => {
    const constraint = intent?.slot_constraints?.[slot];
    if (!constraint) return sum;
    return sum + [
      constraint.preferred_subs.length,
      constraint.required_keywords.length,
      constraint.preferred_entities.length,
      constraint.colour_hints.length,
      constraint.excluded_subs.length,
      constraint.excluded_keywords.length,
      (constraint.excluded_entities || []).length,
      (constraint.excluded_colours || []).length,
    ].reduce((inner, value) => inner + value, 0);
  }, 0);
  const negatives = intent?.negative_constraints;
  const negativeSignalCount =
    (negatives?.excluded_categories.length || 0) +
    (negatives?.excluded_keywords.length || 0) +
    (negatives?.excluded_subs.length || 0) +
    (negatives?.excluded_brands.length || 0) +
    (negatives?.excluded_teams.length || 0) +
    (negatives?.non_sport ? 1 : 0) +
    (negatives?.no_logos ? 1 : 0);
  const explicitColourStrength =
    (intent?.colour_hints?.length || 0) +
    SLOT_ORDER.reduce((sum, slot) => sum + (intent?.slot_constraints?.[slot]?.colour_hints.length || 0), 0);
  const structureRichness = clamp01(
    (Math.max(0, Math.min(1, informativeness)) * 0.42) +
    (((safe.refined + safe.classic + safe.minimal + safe.structured) / 4) * 0.38) +
    ((semanticDirectives?.style_axes?.length || 0) * 0.012) +
    ((semanticDirectives?.silhouette_terms?.length || 0) * 0.02),
  );
  const expressiveVariance = clamp01(
    (safe.streetwear * 0.42) +
    (safe.sporty * 0.28) +
    (safe.graphic * 0.3) +
    (safe.relaxed * 0.12),
  );
  const aestheticPurity = clamp01(
    (safe.understated * 0.34) +
    (safe.minimal * 0.26) +
    (safe.neutral * 0.16) +
    (safe.classic * 0.14) +
    (safe.structured * 0.1),
  );
  const noiseTolerance = clamp01(0.16 + expressiveVariance * 0.76 - aestheticPurity * 0.34);
  const sportTolerance = clamp01(
    (safe.sporty * 0.74) +
    (safe.streetwear * 0.18) -
    ((negatives?.non_sport ? 0.28 : 0) + (safe.understated * 0.08)),
  );
  const paletteStrictness = clamp01(
    (explicitColourStrength ? 0.82 : 0) +
    (explicitColourStrength ? 0.08 : 0.0) +
    (explicitColourStrength ? 0 : (safe.neutral * 0.34 + safe.understated * 0.22 + safe.minimal * 0.16)) +
    ((intent?.palette_mode && intent.palette_mode !== 'unconstrained') ? 0.12 : 0),
  );
  const slotRoleSpecificity = clamp01(
    (requiredSlots.size >= 2 ? 0.24 : 0.08) +
    Math.min(0.3, slotConstraintSignals * 0.01) +
    Math.min(0.22, slotScopedSubjects.length * 0.08),
  );
  const explicitConstraintStrength = clamp01(
    (negativeSignalCount * 0.08) +
    Math.min(0.34, slotConstraintSignals * 0.012) +
    (explicitColourStrength ? 0.08 : 0) +
    ((negatives?.non_sport || negatives?.no_logos) ? 0.1 : 0),
  );
  const semanticExpansionStrength = clamp01(
    Math.max(0, Math.min(1, informativeness)) *
    (0.48 + structureRichness * 0.28 + expressiveVariance * 0.18 + slotRoleSpecificity * 0.12) *
    (1 - explicitConstraintStrength * 0.42),
  );
  const rolePurityWeight = clamp01(
    (structureRichness * 0.38) +
    (aestheticPurity * 0.36) +
    ((1 - noiseTolerance) * 0.18) +
    ((1 - sportTolerance) * 0.08),
  );
  const diversityEnvelope = clamp01(
    0.22 + noiseTolerance * 0.48 + expressiveVariance * 0.24 - rolePurityWeight * 0.14,
  );
  const stageProtectionRelaxation = clamp01(
    semanticExpansionStrength * 0.7 + rolePurityWeight * 0.18 - explicitConstraintStrength * 0.34,
  );
  return {
    structureRichness,
    aestheticPurity,
    noiseTolerance,
    sportTolerance,
    paletteStrictness,
    slotRoleSpecificity,
    explicitConstraintStrength,
    semanticExpansionStrength,
    rolePurityWeight,
    diversityEnvelope,
    stageProtectionRelaxation,
  };
}

export function deriveItemSemanticAxisProfile(item: Partial<IndexItem>, signals?: StyleSignals | null): SemanticAxisProfile {
  const resolvedSignals = signals || deriveStyleSignals(item);
  const colours = uniqueNormalized(item.colours || []);
  const neutralRatio = neutralColourRatio(colours);
  const loudness = Math.min(1, loudMarkerCount(resolvedSignals) / 3);
  const fit = normalizeText(item.fit || '');
  const relaxedFit = /\brelaxed|oversized|wide|baggy\b/.test(fit) ? 0.18 : 0;
  const structuredFit = /\bslim|tailored|regular\b/.test(fit) ? 0.1 : 0;
  const refined = clamp01(
    (resolvedSignals.formality_score * 0.4) +
    (resolvedSignals.cleanliness_score * 0.25) +
    (resolvedSignals.classic_score * 0.25) +
    (resolvedSignals.openness_score * 0.03) -
    (resolvedSignals.streetwear_score * 0.18) -
    (resolvedSignals.sportiness_score * 0.22) -
    (loudness * 0.14),
  );
  const classic = clamp01(
    (resolvedSignals.classic_score * 0.68) +
    (resolvedSignals.formality_score * 0.16) +
    (resolvedSignals.cleanliness_score * 0.1) -
    (resolvedSignals.streetwear_score * 0.12) -
    (resolvedSignals.sportiness_score * 0.12),
  );
  const minimal = clamp01(
    (resolvedSignals.cleanliness_score * 0.52) +
    (neutralRatio * 0.22) +
    (resolvedSignals.classic_score * 0.1) -
    (loudness * 0.3),
  );
  const relaxed = clamp01(
    (resolvedSignals.comfort_score * 0.38) +
    (resolvedSignals.openness_score * 0.08) +
    relaxedFit +
    (resolvedSignals.streetwear_score * 0.08) -
    (resolvedSignals.formality_score * 0.08),
  );
  const structured = clamp01(
    (resolvedSignals.formality_score * 0.3) +
    (resolvedSignals.classic_score * 0.2) +
    (resolvedSignals.cleanliness_score * 0.16) +
    structuredFit -
    relaxedFit * 0.5,
  );
  const neutral = clamp01(
    (neutralRatio * 0.7) +
    (resolvedSignals.cleanliness_score * 0.12) +
    (resolvedSignals.classic_score * 0.08),
  );
  const understated = clamp01(
    (resolvedSignals.cleanliness_score * 0.4) +
    (resolvedSignals.classic_score * 0.16) +
    (neutralRatio * 0.16) -
    (loudness * 0.3) -
    (resolvedSignals.streetwear_score * 0.08),
  );
  const sporty = clamp01(
    (resolvedSignals.sportiness_score * 0.72) +
    (resolvedSignals.streetwear_score * 0.06) +
    (loudness * 0.08)
  );
  const streetwear = clamp01(
    (resolvedSignals.streetwear_score * 0.72) +
    (resolvedSignals.sportiness_score * 0.08) +
    (loudness * 0.18),
  );
  const graphic = clamp01(
    loudness * 0.75 +
    (resolvedSignals.streetwear_score * 0.08),
  );
  return {
    refined,
    classic,
    minimal,
    relaxed,
    structured,
    neutral,
    understated,
    sporty,
    streetwear,
    graphic,
  };
}

function semanticAestheticTags(
  item: Partial<IndexItem>,
  signals: StyleSignals,
  materials: string[],
  silhouettes: string[],
  colours: string[],
  occasions: string[],
): string[] {
  const tags = new Set<string>();
  const loud =
    signals.style_markers.includes('graphic') ||
    signals.style_markers.includes('logo') ||
    signals.style_markers.includes('distressed') ||
    signals.style_markers.includes('embellished') ||
    signals.style_markers.includes('camouflage') ||
    signals.style_markers.includes('sport_kit');
  const premiumMaterials = materials.some((material) => ['wool', 'linen', 'suede', 'leather'].includes(material));
  const neutralPalette = colours.length > 0 && colours.every((colour) => ['black', 'white', 'grey', 'beige', 'brown'].includes(colour));
  const minimalVibe = (item.vibes || []).includes('minimal');
  const polishedOccasion = occasions.includes('formal') || occasions.includes('smart_casual') || occasions.includes('evening');

  if (signals.cleanliness_score >= 0.7 && !loud) tags.add('understated');
  if ((signals.classic_score >= 0.62 || polishedOccasion) && signals.cleanliness_score >= 0.68 && !loud) tags.add('sophisticated');
  if ((signals.cleanliness_score >= 0.72 && signals.streetwear_score < 0.4) || minimalVibe) tags.add('minimal');
  if (premiumMaterials && signals.cleanliness_score >= 0.62 && signals.classic_score >= 0.58) tags.add('high_quality');
  if (silhouettes.includes('structured') || signals.style_markers.includes('tailored')) tags.add('tailored');
  if (silhouettes.includes('relaxed') && signals.cleanliness_score >= 0.62) tags.add('relaxed_fit');
  if (
    premiumMaterials &&
    neutralPalette &&
    signals.cleanliness_score >= 0.72 &&
    signals.classic_score >= 0.62 &&
    signals.formality_score >= 0.42 &&
    signals.streetwear_score < 0.42 &&
    signals.sportiness_score < 0.35 &&
    !loud
  ) {
    tags.add('quiet_luxury_compatible');
  }
  return Array.from(tags);
}

function semanticFamilyTags(item: Partial<IndexItem>, signals: StyleSignals, occasions: OccasionTag[]): string[] {
  const tags = new Set<string>();
  if (signals.formality_score >= 0.6 || occasions.includes('formal') || occasions.includes('evening')) {
    tags.add('refined');
    tags.add('classic');
  }
  if (signals.classic_score >= 0.62) tags.add('old_money_compatible');
  if (signals.streetwear_score >= 0.45) tags.add('streetwear');
  if (signals.sportiness_score >= 0.55 || (item.sportMeta?.sport && item.sportMeta.sport !== 'none')) tags.add('sport_performance');
  if (occasions.includes('lounge') || occasions.includes('sleepwear') || signals.comfort_score >= 0.62) tags.add('lounge');
  if (occasions.includes('sleepwear') || signals.comfort_score >= 0.72) tags.add('sleep_ready');
  if (signals.openness_score >= 0.58) {
    tags.add('beach');
    tags.add('resort');
  }
  if (signals.formality_score >= 0.62 || occasions.includes('evening')) tags.add('nightlife');
  if (signals.classic_score >= 0.55 && signals.cleanliness_score >= 0.55) tags.add('office');
  if (signals.cleanliness_score >= 0.72 && signals.streetwear_score < 0.4) tags.add('clean_minimal');
  return Array.from(tags);
}

export function slotSemanticRoleText(slot: CategoryMain): string {
  if (slot === 'top') return 'role top upper outfit anchor';
  if (slot === 'bottom') return 'role bottom trouser base layer';
  if (slot === 'shoes') return 'role shoes footwear finishing layer';
  return 'role mono one piece outfit anchor';
}

function slotSemanticRoleDescriptors(slot: CategoryMain, profile: SemanticAxisProfile): string {
  const refinedLean = profile.refined + profile.classic + profile.understated;
  const cleanLean = profile.minimal + profile.neutral + profile.understated;
  const loudLean = profile.streetwear + profile.sporty + profile.graphic;
  const parts: string[] = [slotSemanticRoleText(slot)];

  if (slot === 'top') {
    if (refinedLean >= 1.15) parts.push('upper refined clean anchor');
    if (profile.structured >= 0.42) parts.push('upper structured layer');
    if (profile.relaxed >= 0.45) parts.push('upper relaxed layer');
    if (profile.streetwear >= 0.42) parts.push('upper streetwear layer');
    if (profile.sporty >= 0.42) parts.push('upper athletic layer');
  } else if (slot === 'bottom') {
    if (refinedLean >= 1.05) parts.push('bottom refined clean base');
    if (profile.structured >= 0.4) parts.push('bottom tailored structured base');
    if (profile.relaxed >= 0.45) parts.push('bottom relaxed base');
    if (profile.streetwear >= 0.42) parts.push('bottom streetwear utility base');
    if (profile.sporty >= 0.42) parts.push('bottom athletic base');
  } else if (slot === 'shoes') {
    if (refinedLean >= 1 && profile.sporty <= 0.35) parts.push('footwear smart clean finishing');
    if (cleanLean >= 1.05) parts.push('footwear understated finishing');
    if (profile.streetwear >= 0.42) parts.push('footwear streetwear finishing');
    if (profile.sporty >= 0.42) parts.push('footwear athletic performance');
  } else {
    if (refinedLean >= 1.05) parts.push('mono refined clean anchor');
    if (profile.relaxed >= 0.45) parts.push('mono relaxed shape');
    if (profile.streetwear >= 0.42) parts.push('mono streetwear statement');
  }

  if (cleanLean >= 1.1 && loudLean <= 0.7) parts.push('clean low noise role');
  if (profile.sporty >= 0.45 && refinedLean <= 0.95) parts.push('sport forward role');
  if (profile.streetwear >= 0.45 && refinedLean <= 0.95) parts.push('streetwear forward role');
  return joinParts(parts);
}

function scoreBucket(label: string, value: number): string {
  if (value >= 0.7) return `${label} high`;
  if (value >= 0.4) return `${label} medium`;
  return `${label} low`;
}

function filteredGenericEntities(item: Partial<IndexItem>, corpus?: SemanticCorpusStats | null): string[] {
  return filterCorpusTerms(
    (item.entityMeta || [])
      .filter((entity) => entity.type === 'generic' || entity.type === 'sponsor')
      .map((entity) => normalizeText(entity.text))
      .slice(0, 8),
    corpus,
    'entity',
  );
}

export function deriveStyleSignals(item: Partial<IndexItem>): StyleSignals {
  const text = baseItemText(item);
  const sub = canonicalizeSubtype(item.sub || '');
  const vibes = new Set(item.vibes || []);
  const occasions = new Set(inferredOccasions(item));
  const markers = new Set<StyleMarker>();

  if (/\bgraphic|print(?:ed)?|illustration|screen print|screenprint\b/.test(text)) markers.add('graphic');
  if (/\blogo|monogram|script logo|logo patch|logo detail|brand patch|brand mark\b/.test(text)) markers.add('logo');
  if (/\bdistressed|ripped|destroyed|frayed|washed out|faded|bootcut\b/.test(text)) markers.add('distressed');
  if (/\bembroider(?:ed|y)?|applique|appliqued|appliqué|patch pocket|crochet patch\b/.test(text)) markers.add('embroidered');
  if (/\brhinestone|stud(?:ded)?|embellish(?:ed)?|pearl|sequin|beaded|metal dots\b/.test(text)) markers.add('embellished');
  if (/\bcamo|camouflage\b/.test(text)) markers.add('camouflage');
  if (/\btechnical|performance|track|drawstring|utility|tactical|gore tex|goretex|windbreaker|shell|hiking|running|training|puffer|quilted|padded\b/.test(text)) markers.add('technical');
  if (/\btailored|pleated|crease|dress pants|tailored trousers|blazer|suit|tuxedo|oxford shirt|dress shirt|chino\b/.test(text) || isFormalSubtype(sub)) {
    markers.add('tailored');
  }
  if (/\bknit|cardigan|sweater|cashmere|wool|merino|polo sweater|piqu[eé]\b/.test(text) || subtypeFamily(sub).includes('soft_top_layer')) {
    markers.add('knit');
  }
  if (/\bdenim|jeans|five pocket|five-pocket\b/.test(text) || subtypeFamily(sub).includes('denim')) markers.add('denim');
  if (/\bleather\b/.test(text)) markers.add('leather');
  if (/\bsuede\b/.test(text)) markers.add('suede');
  if (/\blinen\b/.test(text)) markers.add('linen');
  if (/\bjersey|kit|home shirt|away shirt|third shirt|club shirt\b/.test(text) || item.sportMeta?.isKit) markers.add('sport_kit');
  if (subtypeFamily(sub).includes('outerwear_family') || /\bjacket|coat|parka|bomber|outerwear\b/.test(text)) markers.add('outerwear');

  const noisy = ['graphic', 'logo', 'distressed', 'embellished', 'camouflage', 'technical', 'sport_kit'].some((marker) =>
    markers.has(marker as StyleMarker),
  );
  const cleanSubtype =
    ['shirt', 'polo', 'dress shirt', 'oxford shirt', 'sweater', 'cardigan', 'blazer', 'suit jacket', 'waistcoat', 'jacket', 'bomber jacket', 'coat', 'tailored trousers', 'dress pants', 'trousers', 'jeans', 'loafers', 'boat shoes', 'oxford/derby', 'formal shoes', 'dress', 'cocktail dress', 'evening dress', 'gown'].includes(sub) ||
    isFormalSubtype(sub) ||
    isSmartCasualShoeSubtype(sub);
  if (cleanSubtype && !noisy) markers.add('clean_basic');

  let formality = 0.1;
  if (occasions.has('formal')) formality += 0.4;
  if (occasions.has('evening')) formality += 0.25;
  if (occasions.has('smart_casual')) formality += 0.12;
  if (vibes.has('formal')) formality += 0.25;
  if (vibes.has('chic')) formality += 0.14;
  if (vibes.has('preppy')) formality += 0.12;
  if (markers.has('tailored')) formality += 0.26;
  if (markers.has('linen')) formality += 0.06;
  if (markers.has('suede')) formality += 0.05;
  if (markers.has('graphic') || markers.has('distressed') || markers.has('camouflage') || markers.has('sport_kit')) formality -= 0.18;
  if (isOpenCasualShoeSubtype(sub) || isAthleticShoeSubtype(sub) || isLoungeSubtype(sub) || isSleepwearSubtype(sub)) formality -= 0.22;

  let streetwear = 0.05;
  if (vibes.has('streetwear')) streetwear += 0.38;
  if (vibes.has('edgy')) streetwear += 0.14;
  if (vibes.has('y2k')) streetwear += 0.12;
  if (vibes.has('techwear')) streetwear += 0.24;
  if (markers.has('graphic')) streetwear += 0.22;
  if (markers.has('logo')) streetwear += 0.16;
  if (markers.has('distressed')) streetwear += 0.18;
  if (markers.has('technical')) streetwear += 0.18;
  if (markers.has('sport_kit')) streetwear += 0.28;
  if (sub === 'hoodie' || sub === 'sweatshirt' || sub === 'tshirt' || sub === 'sneakers') streetwear += 0.18;
  if (markers.has('tailored') || isFormalSubtype(sub)) streetwear -= 0.12;
  if (isOpenCasualShoeSubtype(sub)) streetwear -= 0.08;

  let cleanliness = 0.55;
  if (markers.has('clean_basic')) cleanliness += 0.18;
  if (markers.has('tailored')) cleanliness += 0.14;
  if (markers.has('knit')) cleanliness += 0.08;
  if (markers.has('linen')) cleanliness += 0.06;
  if (markers.has('suede')) cleanliness += 0.05;
  if (markers.has('graphic')) cleanliness -= 0.18;
  if (markers.has('logo')) cleanliness -= 0.08;
  if (markers.has('distressed')) cleanliness -= 0.28;
  if (markers.has('embroidered')) cleanliness -= 0.1;
  if (markers.has('embellished')) cleanliness -= 0.22;
  if (markers.has('camouflage')) cleanliness -= 0.3;
  if (markers.has('technical')) cleanliness -= 0.18;
  if (markers.has('sport_kit')) cleanliness -= 0.24;
  if (isLoungeSubtype(sub) || isSleepwearSubtype(sub)) cleanliness -= 0.22;

  let comfort = 0.16;
  if (occasions.has('lounge') || occasions.has('sleepwear')) comfort += 0.34;
  if (vibes.has('comfy')) comfort += 0.28;
  if (markers.has('knit')) comfort += 0.16;
  if (sub === 'hoodie' || sub === 'sweatshirt' || sub === 'sweater' || sub === 'cardigan') comfort += 0.12;
  if (sub === 'pajama top' || sub === 'pajama pants' || sub === 'robe' || sub === 'nightgown' || sub === 'slippers') comfort += 0.34;
  if (isOpenCasualShoeSubtype(sub)) comfort += 0.08;
  if (markers.has('tailored') || isFormalSubtype(sub)) comfort -= 0.14;

  let sportiness = 0.04;
  if (vibes.has('sporty')) sportiness += 0.28;
  if (markers.has('sport_kit')) sportiness += 0.36;
  if (markers.has('technical')) sportiness += 0.22;
  if (item.sportMeta?.sport && item.sportMeta.sport !== 'none') sportiness += 0.32;
  if (isAthleticShoeSubtype(sub)) sportiness += 0.24;
  if (isHeelFamilySubtype(sub) || isFormalSubtype(sub)) sportiness -= 0.16;

  let openness = 0.06;
  if (markers.has('linen')) openness += 0.24;
  if (sub === 'shorts') openness += 0.28;
  if (sub === 'sandals/slides' || sub === 'slippers') openness += 0.34;
  if (sub === 'shirt' || sub === 'polo' || sub === 'tshirt') openness += 0.08;
  if (markers.has('outerwear') || sub === 'boots' || sub === 'coat' || sub === 'parka' || sub === 'puffer jacket') openness -= 0.22;

  let classic = 0.12;
  if (vibes.has('preppy') || vibes.has('formal') || vibes.has('chic') || vibes.has('minimal')) classic += 0.16;
  if (occasions.has('smart_casual') || occasions.has('formal')) classic += 0.18;
  if (markers.has('tailored')) classic += 0.24;
  if (markers.has('knit')) classic += 0.08;
  if (signalsFamilyLikeClassicSub(sub)) classic += 0.16;
  if (markers.has('graphic') || markers.has('distressed') || markers.has('camouflage') || markers.has('sport_kit')) classic -= 0.18;
  if (isAthleticShoeSubtype(sub) || isLoungeSubtype(sub) || isSleepwearSubtype(sub)) classic -= 0.16;

  return {
    style_markers: uniq(Array.from(markers)),
    formality_score: clamp01(formality),
    streetwear_score: clamp01(streetwear),
    cleanliness_score: clamp01(cleanliness),
    comfort_score: clamp01(comfort),
    sportiness_score: clamp01(sportiness),
    openness_score: clamp01(openness),
    classic_score: clamp01(classic),
  };
}

function signalsFamilyLikeClassicSub(sub: string): boolean {
  return [
    'shirt',
    'dress shirt',
    'oxford shirt',
    'polo',
    'cardigan',
    'sweater',
    'blazer',
    'suit jacket',
    'waistcoat',
    'trousers',
    'tailored trousers',
    'dress pants',
    'loafers',
    'boat shoes',
    'oxford/derby',
    'formal shoes',
  ].includes(sub);
}

export function buildItemSemanticBundle(item: Partial<IndexItem>, options: SemanticBundleOptions = {}): SemanticTextBundle {
  const corpus = options.corpus || null;
  const signals = deriveStyleSignals(item);
  const text = baseItemText(item);
  const sub = canonicalizeSubtype(item.sub || '');
  const colours = uniqueNormalized(item.colours || []);
  const vibes = uniqueNormalized(item.vibes || []);
  const occasions = uniqueNormalized(inferredOccasions(item));
  const families = uniqueNormalized(subtypeFamily(sub));
  const materials = uniqueNormalized(semanticMaterialTags(text, signals));
  const silhouettes = uniqueNormalized(semanticSilhouetteTags(item, text, sub));
  const polish = uniqueNormalized(semanticPolishTags(item, signals));
  const palette = uniqueNormalized(semanticPaletteTags(colours, signals));
  const aesthetics = uniqueNormalized(semanticAestheticTags(item, signals, materials, silhouettes, colours, occasions));
  const styleFamilies = uniqueNormalized(semanticFamilyTags(item, signals, inferredOccasions(item)));
  const axisProfile = deriveItemSemanticAxisProfile(item, signals);
  const brands = uniqueNormalized(
    (item.entityMeta || [])
      .filter((entity) => entity.type === 'brand')
      .map((entity) => entity.text),
  );
  const teams = uniqueNormalized(
    (item.entityMeta || [])
      .filter((entity) => entity.type === 'team')
      .map((entity) => entity.text),
  );
  const genericEntities = filteredGenericEntities(item, corpus);
  const nameText = normalizeText(item.name_normalized || item.name || '');

  const identity = joinParts([
    `category ${normalizeText(item.category || '')}`,
    sub ? `subtype ${sub}` : '',
    nameText ? `name ${nameText}` : '',
    colours.length ? `colours ${colours.join(' ')}` : '',
    brands.length ? `brands ${brands.join(' ')}` : '',
    teams.length ? `teams ${teams.join(' ')}` : '',
    genericEntities.length ? `entities ${genericEntities.join(' ')}` : '',
  ]);
  const style = joinParts([
    `category ${normalizeText(item.category || '')}`,
    vibes.length ? `vibes ${vibes.join(' ')}` : '',
    occasions.length ? `occasions ${occasions.join(' ')}` : '',
    signals.style_markers.length ? `markers ${signals.style_markers.join(' ')}` : '',
    families.length ? `families ${families.join(' ')}` : '',
    materials.length ? `materials ${materials.join(' ')}` : '',
    silhouettes.length ? `silhouette ${silhouettes.join(' ')}` : '',
    palette.length ? `palette ${palette.join(' ')}` : '',
    aesthetics.length ? `aesthetic ${aesthetics.join(' ')}` : '',
    semanticAxisText(axisProfile),
    polish.length ? `polish ${polish.join(' ')}` : '',
    styleFamilies.length ? `style_family ${styleFamilies.join(' ')}` : '',
    item.sportMeta?.sport ? `sport ${normalizeText(item.sportMeta.sport)}` : '',
    item.sportMeta?.isKit ? 'sport kit' : '',
    scoreBucket('formality', signals.formality_score),
    scoreBucket('streetwear', signals.streetwear_score),
    scoreBucket('cleanliness', signals.cleanliness_score),
    scoreBucket('comfort', signals.comfort_score),
    scoreBucket('sportiness', signals.sportiness_score),
    scoreBucket('openness', signals.openness_score),
    scoreBucket('classic', signals.classic_score),
  ]);
  const general = joinParts([identity, style]);

  const slots: Partial<Record<CategoryMain, string>> = {};
  const slotIdentity: Partial<Record<CategoryMain, string>> = {};
  const slotStyle: Partial<Record<CategoryMain, string>> = {};
  if (item.category) {
    const slotRoleText = slotSemanticRoleDescriptors(item.category, axisProfile);
    slots[item.category] = joinParts([general, slotRoleText]);
    slotIdentity[item.category] = joinParts([identity, slotRoleText]);
    slotStyle[item.category] = joinParts([style, slotRoleText]);
  }

  return {
    general,
    identity,
    style,
    slots,
    slot_identity: slotIdentity,
    slot_style: slotStyle,
  };
}

export function buildItemSemanticText(item: Partial<IndexItem>): string {
  return buildItemSemanticBundle(item).general;
}

function promptStyleText(intent?: Partial<PromptIntent>): string {
  if (!intent) return '';
  return joinParts([
    intent.requested_form ? `form ${normalizeText(intent.requested_form)}` : '',
    intent.vibe_tags?.length ? `vibes ${intent.vibe_tags.map((value) => normalizeText(value)).join(' ')}` : '',
    intent.occasion_tags?.length ? `occasions ${intent.occasion_tags.map((value) => normalizeText(value)).join(' ')}` : '',
    intent.setting_context?.length ? `setting ${intent.setting_context.map((value) => normalizeText(value)).join(' ')}` : '',
    intent.activity_context?.length ? `activity ${intent.activity_context.map((value) => normalizeText(value)).join(' ')}` : '',
    intent.daypart_context?.length ? `daypart ${intent.daypart_context.map((value) => normalizeText(value)).join(' ')}` : '',
    intent.persona_terms?.length ? `persona ${intent.persona_terms.map((value) => normalizeText(value)).join(' ')}` : '',
    intent.mono_requirement ? `mono ${normalizeText(String(intent.mono_requirement))}` : '',
    intent.shoe_requirement ? `shoes ${normalizeText(String(intent.shoe_requirement))}` : '',
    intent.fit_preference ? `fit ${normalizeText(String(intent.fit_preference))}` : '',
    intent.sport_context ? `sport ${normalizeText(intent.sport_context)}` : '',
    intent.negative_constraints?.non_sport ? 'guardrail non sport' : '',
    intent.negative_constraints?.no_logos ? 'guardrail no logos' : '',
  ]);
}

function promptIdentityText(prompt: string, intent?: Partial<PromptIntent>, options: SemanticBundleOptions = {}): string {
  const corpus = options.corpus || null;
  if (!intent) return joinParts([`prompt ${normalizeText(prompt)}`]);
  return joinParts([
    `prompt ${normalizeText(prompt)}`,
    intent.colour_hints?.length ? `colours ${intent.colour_hints.map((value) => normalizeText(value)).join(' ')}` : '',
    intent.brand_focus?.length ? `brands ${intent.brand_focus.map((value) => normalizeText(value)).join(' ')}` : '',
    intent.team_focus?.length ? `teams ${intent.team_focus.map((value) => normalizeText(value)).join(' ')}` : '',
    intent.specific_items?.length ? `items ${filterCorpusTerms(intent.specific_items, corpus, 'entity').join(' ')}` : '',
  ]);
}

function slotPromptIdentityText(slot: CategoryMain, intent?: Partial<PromptIntent>, options: SemanticBundleOptions = {}): string {
  const corpus = options.corpus || null;
  const slotIntent = intent?.slot_constraints?.[slot];
  return joinParts([
    slotSemanticRoleText(slot),
    slotIntent?.preferred_subs?.length ? `subtypes ${slotIntent.preferred_subs.map((value) => normalizeText(value)).join(' ')}` : '',
    slotIntent?.required_keywords?.length ? `keywords ${filterCorpusTerms(slotIntent.required_keywords, corpus, 'entity').join(' ')}` : '',
    slotIntent?.preferred_entities?.length ? `entities ${filterCorpusTerms(slotIntent.preferred_entities, corpus, 'entity').join(' ')}` : '',
    slotIntent?.colour_hints?.length ? `colours ${slotIntent.colour_hints.map((value) => normalizeText(value)).join(' ')}` : '',
    slotIntent?.fit_hints?.length ? `fit ${slotIntent.fit_hints.map((value) => normalizeText(value)).join(' ')}` : '',
  ]);
}

function slotPromptStyleText(slot: CategoryMain, intent?: Partial<PromptIntent>): string {
  const slotIntent = intent?.slot_constraints?.[slot];
  return joinParts([
    slotSemanticRoleText(slot),
    promptStyleText(intent),
    slotIntent?.occasion_hints?.length ? `occasions ${slotIntent.occasion_hints.map((value) => normalizeText(value)).join(' ')}` : '',
    slotIntent?.vibe_hints?.length ? `vibes ${slotIntent.vibe_hints.map((value) => normalizeText(value)).join(' ')}` : '',
  ]);
}

export function buildPromptSemanticBundle(prompt: string, intent?: Partial<PromptIntent>, options: SemanticBundleOptions = {}): SemanticTextBundle {
  const identity = promptIdentityText(prompt, intent, options);
  const style = promptStyleText(intent);
  const general = joinParts([identity, style]);
  const slots: Partial<Record<CategoryMain, string>> = {};
  const slotIdentity: Partial<Record<CategoryMain, string>> = {};
  const slotStyle: Partial<Record<CategoryMain, string>> = {};

  for (const slot of ['top', 'bottom', 'shoes', 'mono'] as const) {
    const hasCategory = intent?.required_categories?.includes(slot) || intent?.optional_categories?.includes(slot);
    const slotIntent = intent?.slot_constraints?.[slot];
    const hasSignals =
      hasCategory ||
      !!slotIntent?.preferred_subs?.length ||
      !!slotIntent?.required_keywords?.length ||
      !!slotIntent?.preferred_entities?.length ||
      !!slotIntent?.colour_hints?.length ||
      !!slotIntent?.occasion_hints?.length ||
      !!slotIntent?.vibe_hints?.length ||
      !!slotIntent?.fit_hints?.length;
    if (!hasSignals) continue;
    slotIdentity[slot] = slotPromptIdentityText(slot, intent, options);
    slotStyle[slot] = slotPromptStyleText(slot, intent);
    slots[slot] = joinParts([slotIdentity[slot], slotStyle[slot]]);
  }

  return {
    general,
    identity,
    style,
    slots,
    slot_identity: slotIdentity,
    slot_style: slotStyle,
  };
}

export function buildPromptSemanticText(prompt: string, intent?: Partial<PromptIntent>): string {
  return buildPromptSemanticBundle(prompt, intent).general;
}
