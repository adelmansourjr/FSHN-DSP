import fs from 'fs';
import path from 'path';
import {
  ALLOWED_COLOURS,
  CategoryMain,
  Colour,
  EntityMeta,
  IndexItem,
  SLOT_ORDER,
  canonicalizeSubtype,
  expandEntityAliases,
  hasWholeWord,
  normalizeOccasionTags,
  normalizeText,
  normalizeVibes,
  toFit,
  uniqueColours,
} from './fashion_taxonomy';
import { uniq } from './text';

export const CATEGORY_PHRASES: Array<{ phrase: string; slot: CategoryMain; subtype?: string; familyOnly?: boolean }> = [
  { phrase: 'tuxedo jacket', slot: 'top', subtype: 'tuxedo jacket' },
  { phrase: 'suit jacket', slot: 'top', subtype: 'suit jacket' },
  { phrase: 'dress shirt', slot: 'top', subtype: 'dress shirt' },
  { phrase: 'oxford shirt', slot: 'top', subtype: 'oxford shirt' },
  { phrase: 'football jersey', slot: 'top', subtype: 'shirt' },
  { phrase: 'soccer jersey', slot: 'top', subtype: 'shirt' },
  { phrase: 'team jersey', slot: 'top', subtype: 'shirt' },
  { phrase: 'puffer jacket', slot: 'top', subtype: 'puffer jacket' },
  { phrase: 'bomber jacket', slot: 'top', subtype: 'bomber jacket' },
  { phrase: 'leather jacket', slot: 'top', subtype: 'leather jacket' },
  { phrase: 'tailored trousers', slot: 'bottom', subtype: 'tailored trousers' },
  { phrase: 'dress pants', slot: 'bottom', subtype: 'dress pants' },
  { phrase: 'pajama pants', slot: 'bottom', subtype: 'pajama pants' },
  { phrase: 'lounge pants', slot: 'bottom', subtype: 'lounge pants' },
  { phrase: 'sleep shorts', slot: 'bottom', subtype: 'sleep shorts' },
  { phrase: 'kitten heels', slot: 'shoes', subtype: 'kitten heels' },
  { phrase: 'kitten heel', slot: 'shoes', subtype: 'kitten heels' },
  { phrase: 'boat shoes', slot: 'shoes', subtype: 'boat shoes' },
  { phrase: 'boat shoe', slot: 'shoes', subtype: 'boat shoes' },
  { phrase: 'oxford derby', slot: 'shoes', subtype: 'oxford/derby' },
  { phrase: 'oxford/derby', slot: 'shoes', subtype: 'oxford/derby' },
  { phrase: 'formal shoes', slot: 'shoes', subtype: 'formal shoes' },
  { phrase: 'formal shoe', slot: 'shoes', subtype: 'formal shoes' },
  { phrase: 'cocktail dress', slot: 'mono', subtype: 'cocktail dress' },
  { phrase: 'evening dress', slot: 'mono', subtype: 'evening dress' },
  { phrase: 'nightgown', slot: 'mono', subtype: 'nightgown' },
  { phrase: 'waistcoat', slot: 'top', subtype: 'waistcoat' },
  { phrase: 'cardigan', slot: 'top', subtype: 'cardigan' },
  { phrase: 'sweater', slot: 'top', subtype: 'sweater' },
  { phrase: 'hoodie', slot: 'top', subtype: 'hoodie' },
  { phrase: 'sweatshirt', slot: 'top', subtype: 'sweatshirt' },
  { phrase: 'blazer', slot: 'top', subtype: 'blazer' },
  { phrase: 'parka', slot: 'top', subtype: 'parka' },
  { phrase: 'jacket', slot: 'top', subtype: 'jacket', familyOnly: true },
  { phrase: 'coat', slot: 'top', subtype: 'coat', familyOnly: true },
  { phrase: 'shirt', slot: 'top', subtype: 'shirt', familyOnly: true },
  { phrase: 'polo', slot: 'top', subtype: 'polo' },
  { phrase: 'jersey', slot: 'top', subtype: 'shirt', familyOnly: true },
  { phrase: 'tee', slot: 'top', subtype: 'tshirt' },
  { phrase: 'tshirt', slot: 'top', subtype: 'tshirt' },
  { phrase: 'jeans', slot: 'bottom', subtype: 'jeans', familyOnly: true },
  { phrase: 'trousers', slot: 'bottom', subtype: 'trousers', familyOnly: true },
  { phrase: 'cargo pants', slot: 'bottom', subtype: 'cargo trousers' },
  { phrase: 'cargo', slot: 'bottom', subtype: 'cargo trousers' },
  { phrase: 'joggers', slot: 'bottom', subtype: 'joggers' },
  { phrase: 'shorts', slot: 'bottom', subtype: 'shorts', familyOnly: true },
  { phrase: 'heels', slot: 'shoes', subtype: 'heels', familyOnly: true },
  { phrase: 'heel', slot: 'shoes', subtype: 'heels', familyOnly: true },
  { phrase: 'pumps', slot: 'shoes', subtype: 'pumps' },
  { phrase: 'pump', slot: 'shoes', subtype: 'pumps' },
  { phrase: 'stilettos', slot: 'shoes', subtype: 'stilettos' },
  { phrase: 'stiletto', slot: 'shoes', subtype: 'stilettos' },
  { phrase: 'slingbacks', slot: 'shoes', subtype: 'slingbacks' },
  { phrase: 'slingback', slot: 'shoes', subtype: 'slingbacks' },
  { phrase: 'loafers', slot: 'shoes', subtype: 'loafers' },
  { phrase: 'loafer', slot: 'shoes', subtype: 'loafers' },
  { phrase: 'boots', slot: 'shoes', subtype: 'boots', familyOnly: true },
  { phrase: 'boot', slot: 'shoes', subtype: 'boots', familyOnly: true },
  { phrase: 'sneakers', slot: 'shoes', subtype: 'sneakers', familyOnly: true },
  { phrase: 'sneaker', slot: 'shoes', subtype: 'sneakers', familyOnly: true },
  { phrase: 'trainers', slot: 'shoes', subtype: 'sneakers', familyOnly: true },
  { phrase: 'slippers', slot: 'shoes', subtype: 'slippers' },
  { phrase: 'slipper', slot: 'shoes', subtype: 'slippers' },
  { phrase: 'sandals', slot: 'shoes', subtype: 'sandals/slides', familyOnly: true },
  { phrase: 'sandal', slot: 'shoes', subtype: 'sandals/slides', familyOnly: true },
  { phrase: 'slides', slot: 'shoes', subtype: 'sandals/slides', familyOnly: true },
  { phrase: 'slide', slot: 'shoes', subtype: 'sandals/slides', familyOnly: true },
  { phrase: 'shoes', slot: 'shoes', familyOnly: true },
  { phrase: 'gown', slot: 'mono', subtype: 'gown', familyOnly: true },
  { phrase: 'dress', slot: 'mono', subtype: 'dress', familyOnly: true },
  { phrase: 'jumpsuit', slot: 'mono', subtype: 'jumpsuit' },
  { phrase: 'romper', slot: 'mono', subtype: 'romper' },
];

const CORPUS_GLUE_TOKENS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
  'without',
]);

const IDENTITY_GENERIC_BLACKLIST = new Set([
  ...Array.from(CORPUS_GLUE_TOKENS),
  'category',
  'clothing',
  'fashion',
  'farfetch',
  'item',
  'look',
  'outfit',
  'shoe',
  'shoes',
  'top',
  'bottom',
  'mono',
]);

export interface SemanticCorpusStats {
  item_count: number;
  token_doc_freq: Record<string, number>;
  entity_doc_freq: Record<string, number>;
}

function ensureAbsoluteImagePath(indexPath: string, imagePath: string): string {
  if (!imagePath) return imagePath;
  if (/^(https?:)?\/\//i.test(imagePath) || /^gs:\/\//i.test(imagePath)) return imagePath;
  if (path.isAbsolute(imagePath)) return imagePath;
  return path.resolve(path.dirname(indexPath), imagePath);
}

function normalizedTokenSet(values: string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const norm = normalizeText(value);
    if (!norm) continue;
    for (const token of norm.split(' ').filter(Boolean)) {
      if (!token || CORPUS_GLUE_TOKENS.has(token) || token.length <= 1 || /^\d+$/.test(token)) continue;
      out.add(token);
    }
  }
  return Array.from(out);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rawSubtypeWeight(subtype: string | null | undefined): number {
  const norm = canonicalizeSubtype(subtype);
  if (!norm) return 0;
  return Math.max(0.6, norm.split(' ').filter(Boolean).length * 0.65);
}

function inferredSlotsForSubtype(subtype: string | null | undefined): Set<CategoryMain> {
  const norm = canonicalizeSubtype(subtype);
  const slots = new Set<CategoryMain>();
  if (!norm) return slots;
  for (const phrase of CATEGORY_PHRASES) {
    const phraseSubtype = canonicalizeSubtype(phrase.subtype || phrase.phrase);
    if (phraseSubtype && phraseSubtype === norm) slots.add(phrase.slot);
  }
  return slots;
}

function buildIdentityEntities(
  raw: any,
  nameText: string,
  subtype: string,
  colours: Colour[],
): string[] {
  const typed = uniq(((raw.entityMeta || []) as any[])
    .map((entry) => ({
      text: normalizeText(String(entry?.text || '')),
      type: entry?.type === 'brand' || entry?.type === 'team' || entry?.type === 'sponsor' ? entry.type : 'generic',
    }))
    .filter((entry) => !!entry.text)
    .filter((entry) => entry.type !== 'generic')
    .map((entry) => entry.text));
  const typedAliases = uniq(typed.flatMap((entry) => expandEntityAliases(entry)));
  const generic = uniq(((raw.entityMeta || []) as any[])
    .map((entry) => normalizeText(String(entry?.text || '')))
    .filter(Boolean)
    .filter((entry) => {
      if (IDENTITY_GENERIC_BLACKLIST.has(entry)) return false;
      if (entry.length <= 1 || /^\d+$/.test(entry)) return false;
      if (hasWholeWord(nameText, entry)) return true;
      return typedAliases.some((alias) => hasWholeWord(alias, entry) || hasWholeWord(entry, alias));
    }));
  return uniq([
    ...typedAliases,
    ...generic,
    ...expandEntityAliases(nameText).filter((entry) => entry.length >= 3 && !/^\d+$/.test(entry)),
    ...expandEntityAliases(subtype).filter((entry) => entry.length >= 3),
    ...colours,
  ]).filter((entry) => !IDENTITY_GENERIC_BLACKLIST.has(entry));
}

const VARIANT_DESCRIPTOR_TOKENS = new Set([
  'long',
  'sleeve',
  'sleeved',
  'longsleeve',
  'longsleeved',
  'short',
  'shortsleeve',
  'shortsleeved',
  'sleeveless',
  'cropped',
  'oversized',
  'slim',
  'regular',
  'kangaroo',
  'pocket',
  'cargo',
  'satin',
  'finish',
  'drawstring',
  'technical',
  'washed',
  'distressed',
  'graphic',
  'logo',
  'fw21',
  'fw22',
  'ss23',
  'ss24',
]);

function subtypeTokenSet(subtype: string | null | undefined): Set<string> {
  const tokens = new Set<string>();
  for (const family of subtypeFamilyTokens(subtype)) tokens.add(family);
  for (const token of normalizeText(subtype || '').split(' ').filter(Boolean)) tokens.add(token);
  return tokens;
}

function subtypeFamilyTokens(subtype: string | null | undefined): string[] {
  const norm = canonicalizeSubtype(subtype);
  if (!norm) return [];
  return normalizedTokenSet([norm]);
}

function buildVariantMetadata(
  category: CategoryMain,
  subtype: string | null | undefined,
  colours: Colour[],
  nameText: string,
  identityEntities: string[],
): { variant_group_key: string | null; variant_anchor_entities: string[]; variant_discriminators: string[] } {
  const colourSet = new Set((ALLOWED_COLOURS as readonly string[]).map((entry) => normalizeText(String(entry))));
  for (const colour of colours) colourSet.add(normalizeText(colour));
  const subtypeTokens = subtypeTokenSet(subtype);
  const keySources = [
    nameText,
    ...identityEntities.filter((entry) => normalizeText(entry).includes(' ')),
  ];
  const allTokens = normalizedTokenSet(keySources);
  const discriminatorTokensSource = normalizedTokenSet([
    nameText,
    ...identityEntities,
  ]);
  const anchorTokens = uniq(allTokens.filter((token) => {
    if (!token || IDENTITY_GENERIC_BLACKLIST.has(token)) return false;
    if (colourSet.has(token)) return false;
    if (subtypeTokens.has(token)) return false;
    if (VARIANT_DESCRIPTOR_TOKENS.has(token)) return false;
    if (token.length > 24) return false;
    if (/\d/.test(token)) return false;
    return token.length >= 3 && !/^\d+$/.test(token);
  }));
  const variantGroupKey = anchorTokens.length >= 2 ? `${category}:${anchorTokens.sort().join('|')}` : null;
  const discriminatorTokens = uniq([
    ...colours.map((colour) => normalizeText(colour)),
    ...normalizeText(subtype || '').split(' ').filter(Boolean),
    ...discriminatorTokensSource.filter((token) => !anchorTokens.includes(token) && !IDENTITY_GENERIC_BLACKLIST.has(token)),
  ]).filter(Boolean);
  return {
    variant_group_key: variantGroupKey,
    variant_anchor_entities: anchorTokens,
    variant_discriminators: discriminatorTokens,
  };
}

export function normalizeIndexItem(raw: any, indexPath: string): IndexItem | null {
  const category = raw?.category;
  if (!['top', 'bottom', 'shoes', 'mono'].includes(category)) return null;
  const rawSubtype = raw.sub == null ? null : canonicalizeSubtype(String(raw.sub));
  const textSignals = normalizeText([
    rawSubtype || '',
    raw.name || '',
    raw.name_normalized || '',
    ...((raw.entities || []) as any[]).map((entry) => String(entry || '')),
    ...((raw.entityMeta || []) as any[]).map((entry) => String(entry?.text || '')),
  ].join(' '));
  const slotWeights: Record<CategoryMain, number> = { top: 0, bottom: 0, shoes: 0, mono: 0 };
  const rawCategory = category as CategoryMain;
  slotWeights[rawCategory] += rawSubtype ? 1.25 : 0.9;
  const rawSubtypeSlots = inferredSlotsForSubtype(rawSubtype);
  for (const slot of rawSubtypeSlots) {
    slotWeights[slot] += slot === rawCategory ? 2.4 : 1.65;
  }
  let bestSubtype = canonicalizeSubtype(String(raw.sub || ''));
  let bestSubtypeWeight = bestSubtype ? bestSubtype.split(' ').length * 0.5 : 0;
  for (const phrase of CATEGORY_PHRASES) {
    if (!hasWholeWord(textSignals, phrase.phrase)) continue;
    const weight = Math.max(1, phrase.phrase.split(' ').length * 1.4 + (phrase.familyOnly ? 0.2 : 0.8));
    slotWeights[phrase.slot] += weight;
    if (phrase.subtype && weight > bestSubtypeWeight) {
      bestSubtype = phrase.subtype || bestSubtype;
      bestSubtypeWeight = weight;
    }
  }
  const repairedCategory = Object.entries(slotWeights).sort((a, b) => b[1] - a[1])[0];
  const finalCategory =
    repairedCategory && repairedCategory[1] >= 2.4 && repairedCategory[1] > (slotWeights[category as CategoryMain] + 0.8)
      ? repairedCategory[0] as CategoryMain
      : category as CategoryMain;
  const rawSubtypeSupportsFinal = rawSubtypeSlots.size === 0 || rawSubtypeSlots.has(finalCategory);
  const bestSubtypeSlots = inferredSlotsForSubtype(bestSubtype);
  const bestSubtypeSupportsFinal = bestSubtypeSlots.size === 0 || bestSubtypeSlots.has(finalCategory);
  const repairedSubtype =
    bestSubtype &&
    bestSubtype !== rawSubtype &&
    bestSubtypeSupportsFinal &&
    (
      !rawSubtypeSupportsFinal ||
      bestSubtypeWeight >= Math.max(1.4, rawSubtypeWeight(rawSubtype) + 0.45)
    );
  const finalSubtype = repairedSubtype
    ? bestSubtype
    : (rawSubtypeSupportsFinal ? rawSubtype : (bestSubtypeSupportsFinal ? bestSubtype : rawSubtype));
  const colours = uniqueColours(raw.colours || []);
  const nameText = normalizeText(raw.name_normalized || raw.name || '');
  const identityEntities = buildIdentityEntities(raw, nameText, finalSubtype || '', colours);
  const variantMetadata = buildVariantMetadata(finalCategory, finalSubtype || '', colours, nameText, identityEntities);
  const categoryConfidence = finalCategory === category ? 0.78 : 0.64;
  const subtypeConfidence = finalSubtype && finalSubtype === rawSubtype
    ? 0.82
    : finalSubtype
      ? clamp01(0.52 + Math.min(bestSubtypeWeight, 3.2) * 0.12)
      : 0.35;
  const repairConfidence = clamp01((categoryConfidence + subtypeConfidence) / 2);
  return {
    id: String(raw.id || raw.imagePath || ''),
    imagePath: ensureAbsoluteImagePath(indexPath, String(raw.imagePath || raw.path || raw.file || '')),
    category: finalCategory,
    sub: finalSubtype,
    colours,
    vibes: normalizeVibes(raw.vibes || []),
    gender: raw.gender === 'men' || raw.gender === 'women' || raw.gender === 'unisex' ? raw.gender : 'unisex',
    fit: toFit(raw.fit) || null,
    sportMeta: raw.sportMeta || null,
    name: raw.name == null ? null : String(raw.name),
    name_normalized: raw.name_normalized == null ? nameText : normalizeText(String(raw.name_normalized)),
    entities: Array.isArray(raw.entities) ? raw.entities.map((v: any) => normalizeText(String(v || ''))).filter(Boolean) : [],
    entityMeta: Array.isArray(raw.entityMeta)
      ? raw.entityMeta.map((entry: any) => ({
          text: normalizeText(String(entry?.text || '')),
          weight: Number(entry?.weight || 1),
          type: entry?.type === 'brand' || entry?.type === 'team' || entry?.type === 'sponsor' ? entry.type : 'generic',
        })).filter((entry: EntityMeta) => !!entry.text)
      : [],
    occasion_tags: normalizeOccasionTags(raw.occasion_tags || []),
    confidence: raw.confidence || null,
    style_markers: Array.isArray(raw.style_markers) ? raw.style_markers.map((v: any) => normalizeText(String(v || ''))).filter(Boolean) : undefined,
    formality_score: typeof raw.formality_score === 'number' ? raw.formality_score : null,
    streetwear_score: typeof raw.streetwear_score === 'number' ? raw.streetwear_score : null,
    cleanliness_score: typeof raw.cleanliness_score === 'number' ? raw.cleanliness_score : null,
    identity_entities: identityEntities,
    repair_confidence: repairConfidence,
    variant_group_key: variantMetadata.variant_group_key,
    variant_anchor_entities: variantMetadata.variant_anchor_entities,
    variant_discriminators: variantMetadata.variant_discriminators,
  };
}

export function loadCanonicalIndex(indexPath: string): IndexItem[] {
  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('index must be a JSON array');
  return raw.map((entry) => normalizeIndexItem(entry, indexPath)).filter((entry): entry is IndexItem => !!entry);
}

export function buildSemanticCorpusStats(items: Partial<IndexItem>[]): SemanticCorpusStats {
  const tokenDocFreq = new Map<string, number>();
  const entityDocFreq = new Map<string, number>();

  for (const item of items) {
    const tokenSet = new Set(normalizedTokenSet([
      item.sub || '',
      item.name || '',
      item.name_normalized || '',
      ...((item.colours || []) as Colour[]),
      ...(item.vibes || []),
      ...(item.occasion_tags || []),
      ...((item.style_markers || []) as string[]),
      ...(item.identity_entities || []),
      ...(item.entities || []),
      ...((item.entityMeta || []).map((entry) => entry.text)),
    ]));
    const entitySet = new Set(
      uniq([
        ...(item.identity_entities || []).map((entry) => normalizeText(entry)).filter(Boolean),
        ...(item.entityMeta || []).map((entry) => normalizeText(entry.text)).filter(Boolean),
      ]),
    );
    for (const token of tokenSet) tokenDocFreq.set(token, (tokenDocFreq.get(token) || 0) + 1);
    for (const entity of entitySet) entityDocFreq.set(entity, (entityDocFreq.get(entity) || 0) + 1);
  }

  return {
    item_count: Math.max(items.length, 1),
    token_doc_freq: Object.fromEntries(tokenDocFreq),
    entity_doc_freq: Object.fromEntries(entityDocFreq),
  };
}

export function documentFrequencyRatio(
  stats: SemanticCorpusStats | null | undefined,
  value: string,
  kind: 'token' | 'entity' = 'token',
): number {
  const norm = normalizeText(value);
  if (!stats || !norm || !stats.item_count) return 0;
  const freq = kind === 'entity'
    ? (stats.entity_doc_freq[norm] || 0)
    : (stats.token_doc_freq[norm] || 0);
  return freq / stats.item_count;
}

export function isCorpusNoiseToken(
  value: string,
  stats: SemanticCorpusStats | null | undefined,
  kind: 'token' | 'entity' = 'token',
): boolean {
  const norm = normalizeText(value);
  if (!norm) return true;
  if (CORPUS_GLUE_TOKENS.has(norm) || norm.length <= 1 || /^\d+$/.test(norm)) return true;
  const ratio = documentFrequencyRatio(stats, norm, kind);
  if (!ratio) return false;
  return ratio >= (kind === 'entity' ? 0.18 : 0.28);
}

export function filterCorpusTerms(
  values: Array<string | null | undefined>,
  stats: SemanticCorpusStats | null | undefined,
  kind: 'token' | 'entity' = 'token',
): string[] {
  return uniq((values || [])
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .filter((value) => !isCorpusNoiseToken(value, stats, kind)));
}
