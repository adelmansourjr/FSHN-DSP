#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import vision, { protos } from '@google-cloud/vision';
import {
  acronym,
  escapeRegExp,
  rmDiacritics,
  uniq,
} from './lib/text';
import { deriveStyleSignals } from './lib/style_semantics';

type CategoryMain = 'top' | 'bottom' | 'shoes' | 'mono';
type Gender = 'men' | 'women' | 'unisex';
type Colour =
  | 'black'
  | 'white'
  | 'grey'
  | 'red'
  | 'blue'
  | 'green'
  | 'beige'
  | 'brown'
  | 'pink'
  | 'yellow'
  | 'purple';
type Vibe =
  | 'streetwear'
  | 'edgy'
  | 'minimal'
  | 'y2k'
  | 'techwear'
  | 'sporty'
  | 'preppy'
  | 'vintage'
  | 'chic'
  | 'formal'
  | 'comfy';
type OccasionTag = 'smart_casual' | 'formal' | 'evening' | 'lounge' | 'sleepwear';
type Fit = 'oversized' | 'regular' | 'slim' | 'cropped';
type SportType = string;
type EntityMeta = { text: string; weight: number; type: 'brand' | 'team' | 'sponsor' | 'generic' };
type SportMeta = { sport?: string | null; teams?: string[]; isKit?: boolean };
type ConfidenceBreakdown = {
  category?: number | null;
  sub?: number | null;
  gender?: number | null;
  fit?: number | null;
  vibes?: number | null;
  occasion?: number | null;
  sport?: number | null;
};
type IndexItem = {
  id: string;
  imagePath: string;
  category: CategoryMain;
  sub?: string | null;
  colours: Colour[];
  vibes: Vibe[];
  gender: Gender;
  fit?: Fit | null;
  sportMeta?: SportMeta | null;
  name?: string | null;
  name_normalized?: string | null;
  entities?: string[];
  entityMeta?: EntityMeta[];
  occasion_tags?: OccasionTag[];
  confidence?: ConfidenceBreakdown | null;
  style_markers?: string[];
  formality_score?: number | null;
  streetwear_score?: number | null;
  cleanliness_score?: number | null;
};

const ALLOWED_COLOURS = ['black', 'white', 'grey', 'red', 'blue', 'green', 'beige', 'brown', 'pink', 'yellow', 'purple'] as const;
const ALLOWED_VIBES = ['streetwear', 'edgy', 'minimal', 'y2k', 'techwear', 'sporty', 'preppy', 'vintage', 'chic', 'formal', 'comfy'] as const;
const ALLOWED_OCCASIONS = ['smart_casual', 'formal', 'evening', 'lounge', 'sleepwear'] as const;
const ACCESSORY_SUBS = new Set(['accessory']);
const FORMAL_TOP_SUBS = new Set(['blazer', 'suit jacket', 'tuxedo jacket', 'dress shirt', 'oxford shirt', 'waistcoat']);
const FORMAL_BOTTOM_SUBS = new Set(['tailored trousers', 'dress pants', 'trousers']);
const FORMAL_SHOE_SUBS = new Set(['formal shoes', 'loafers', 'oxford/derby', 'heels', 'pumps', 'stilettos', 'kitten heels', 'slingbacks', 'mary jane']);
const LOUNGE_TOP_SUBS = new Set(['pajama top', 'robe', 'hoodie', 'sweatshirt', 'sweater']);
const LOUNGE_BOTTOM_SUBS = new Set(['pajama pants', 'lounge pants', 'sleep shorts', 'joggers']);
const LOUNGE_SHOE_SUBS = new Set(['slippers', 'sandals/slides']);
const SLEEPWEAR_MONO_SUBS = new Set(['nightgown']);
const TEAM_SUFFIX_TERMS = ['jersey', 'kit', 'club', 'team'];
const PRODUCT_SUFFIX_TERMS = [
  'hoodie',
  'sweatshirt',
  'sweater',
  'cardigan',
  'shirt',
  'tshirt',
  'tee',
  'polo',
  'blazer',
  'jacket',
  'coat',
  'waistcoat',
  'robe',
  'trousers',
  'pants',
  'jeans',
  'shorts',
  'skirt',
  'dress',
  'gown',
  'nightgown',
  'jumpsuit',
  'romper',
  'onepiece',
  'sneakers',
  'shoe',
  'shoes',
  'boots',
  'loafers',
  'heels',
  'pumps',
  'stilettos',
  'slingbacks',
  'slippers',
];
const ENTITY_STOPWORDS = new Set<string>([
  ...ALLOWED_COLOURS,
  ...ALLOWED_VIBES,
  ...ALLOWED_OCCASIONS,
  'fashion',
  'clothing',
  'official',
  'team',
  'jersey',
  'kit',
  'home',
  'away',
  'third',
  'sport',
  'sportswear',
  'athletic',
  'men',
  'man',
  'mens',
  'women',
  'woman',
  'womens',
  'male',
  'female',
  'unisex',
  'top',
  'bottom',
  'shirt',
  'tshirt',
  'tee',
  'polo',
  'hoodie',
  'sweatshirt',
  'sweater',
  'cardigan',
  'waistcoat',
  'blazer',
  'jacket',
  'coat',
  'robe',
  'dress',
  'gown',
  'nightgown',
  'jumpsuit',
  'romper',
  'trousers',
  'pants',
  'jeans',
  'shorts',
  'skirt',
  'shoe',
  'shoes',
  'sneaker',
  'sneakers',
  'boot',
  'boots',
  'loafer',
  'loafers',
  'heel',
  'heels',
  'pumps',
  'stilettos',
  'slingbacks',
  'slippers',
  'lounge',
  'loungewear',
  'sleepwear',
  'nightwear',
  'comfy',
  'cozy',
  'minimal',
  'streetwear',
  'sporty',
  'preppy',
  'vintage',
  'formal',
  'chic',
  'farfetch',
  'official',
  'premium',
  'waterproof',
  'leather',
  'cotton',
  'wool',
  'silk',
  'satin',
  'denim',
  'light',
  'dark',
  'baggy',
  'oversized',
  'relaxed',
  'regular',
  'slim',
  'wide',
  'leg',
  'high',
  'low',
]);
const TRAILING_ENTITY_DESCRIPTORS = new Set<string>([
  'fashion',
  'official',
  'premium',
  'waterproof',
  'leather',
  'cotton',
  'wool',
  'silk',
  'satin',
  'denim',
  'light',
  'dark',
  'baggy',
  'oversized',
  'relaxed',
  'regular',
  'slim',
  'wide',
  'leg',
  'high',
  'low',
]);

function normalizeForTokens(value: string): string {
  let t = rmDiacritics(String(value || '').toLowerCase().trim());
  t = t.replace(/[-_]/g, ' ');
  t = t.replace(/\bone\s*-\s*piece\b/g, 'onepiece');
  t = t.replace(/\bt\s*shirt\b/g, 'tshirt');
  t = t.replace(/\btee\b/g, 'tshirt');
  t = t.replace(/\btrainers?\b/g, 'sneakers');
  t = t.replace(/\bheels?\b/g, 'heels');
  t = t.replace(/\bpumps?\b/g, 'pumps');
  t = t.replace(/\bstiletto(s)?\b/g, 'stilettos');
  t = t.replace(/\bkitten heel(s)?\b/g, 'kitten heels');
  t = t.replace(/\bslingback(s)?\b/g, 'slingbacks');
  t = t.replace(/\bloafer(s)?\b/g, 'loafers');
  t = t.replace(/\bboxford shoes?\b/g, 'oxford/derby');
  t = t.replace(/\bderby shoes?\b/g, 'oxford/derby');
  t = t.replace(/\bslipper(s)?\b/g, 'slippers');
  t = t.replace(/\bpyjama(s)?\b/g, 'pajama');
  t = t.replace(/\bpajama(s)?\b/g, 'pajama');
  t = t.replace(/\bpyjama top\b/g, 'pajama top');
  t = t.replace(/\bpajama top\b/g, 'pajama top');
  t = t.replace(/\bpyjama pants\b/g, 'pajama pants');
  t = t.replace(/\bpajama pants\b/g, 'pajama pants');
  t = t.replace(/\bnight wear\b/g, 'nightwear');
  t = t.replace(/\blounge wear\b/g, 'loungewear');
  t = t.replace(/\bcosy\b/g, 'cozy');
  t = t.replace(/\btrouser(s)?\b/g, 'trousers');
  t = t.replace(/\bdress pant(s)?\b/g, 'dress pants');
  t = t.replace(/\btailored pant(s)?\b/g, 'tailored trousers');
  t = t.replace(/\bwaist coat\b/g, 'waistcoat');
  return t.replace(/\s+/g, ' ').trim();
}

function normalizeText(value: string | null | undefined): string {
  return normalizeForTokens(String(value || ''))
    .replace(/[^a-z0-9\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeTeamText(value: string | null | undefined): boolean {
  const text = normalizeText(value);
  if (!text) return false;
  return /\b(fc|cf|afc|club|united|city|basketball|football|soccer|nba|mlb|nhl|tennis)\b/.test(text);
}

function isGenericEntityTerm(value: string | null | undefined): boolean {
  const text = normalizeText(value);
  if (!text) return true;
  if (/^\d+$/.test(text)) return true;
  const tokens = text.split(' ').filter(Boolean);
  if (!tokens.length) return true;
  if (looksLikeTeamText(text)) return false;
  if (tokens.length === 1) return ENTITY_STOPWORDS.has(tokens[0]);
  return tokens.every((token) => ENTITY_STOPWORDS.has(token) || /^\d+$/.test(token));
}

function looksLikeBrandText(value: string | null | undefined): boolean {
  const text = normalizeText(value);
  if (!text || looksLikeTeamText(text) || isGenericEntityTerm(text)) return false;
  if (/\d/.test(text)) return false;
  const tokens = text.split(' ').filter(Boolean);
  if (!tokens.length || tokens.length > 3) return false;
  if (tokens.some((token) => ENTITY_STOPWORDS.has(token))) return false;
  return true;
}

function extractLeadingCandidate(value: string, suffixTerms: string[]): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  const pattern = new RegExp(`\\b(.+?)\\s+(?:${suffixTerms.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|')})\\b`);
  const match = text.match(pattern);
  if (!match) return null;
  const tokens = normalizeText(match[1]).split(' ').filter(Boolean);
  while (tokens.length && TRAILING_ENTITY_DESCRIPTORS.has(tokens[tokens.length - 1])) tokens.pop();
  const candidate = tokens.slice(-3).join(' ');
  if (!candidate || isGenericEntityTerm(candidate)) return null;
  return candidate;
}

function deriveStructuredEntityEntries(entry: { text: string; score?: number; source?: string }): Array<{ text: string; score?: number; source?: string }> {
  const source = entry.source || 'generic';
  if (!entry.text || !['web', 'best_guess', 'name'].includes(source)) return [];
  const out: Array<{ text: string; score?: number; source?: string }> = [];

  const teamCandidate = extractLeadingCandidate(entry.text, TEAM_SUFFIX_TERMS);
  if (teamCandidate) {
    out.push({ text: teamCandidate, score: Math.max(0.1, (entry.score ?? 1) + 0.05), source: 'team_candidate' });
  }

  const brandCandidate = extractLeadingCandidate(entry.text, PRODUCT_SUFFIX_TERMS);
  if (brandCandidate && brandCandidate !== teamCandidate && !looksLikeTeamText(brandCandidate)) {
    out.push({ text: brandCandidate, score: Math.max(0.1, (entry.score ?? 1) + 0.05), source: 'brand_candidate' });
  }

  return out;
}

function entitySourcePriority(source: string | null | undefined): number {
  switch (source || '') {
    case 'logo':
    case 'brand_candidate':
    case 'team_candidate':
      return 4;
    case 'name':
    case 'web':
    case 'best_guess':
      return 3;
    case 'filename':
      return 2;
    case 'ocr':
      return 1;
    default:
      return 0;
  }
}

function normalizeVibes(values: Array<string | null | undefined>): Vibe[] {
  const out: Vibe[] = [];
  const fallback: Record<string, Vibe[]> = {
    fancy: ['formal', 'chic'],
    dressy: ['formal'],
    elegant: ['formal', 'chic'],
    classy: ['chic', 'formal'],
    tailored: ['formal'],
    cozy: ['comfy'],
    comfy: ['comfy'],
  };
  for (const raw of values || []) {
    const norm = normalizeText(raw);
    if (!norm) continue;
    if ((ALLOWED_VIBES as readonly string[]).includes(norm as Vibe)) out.push(norm as Vibe);
    else out.push(...(fallback[norm] || []));
  }
  return uniq(out);
}

function normalizeOccasionTags(values: Array<string | null | undefined>): OccasionTag[] {
  const out: OccasionTag[] = [];
  const fallback: Record<string, OccasionTag[]> = {
    'date night': ['evening'],
    'wedding guest': ['formal', 'evening'],
    'black tie': ['formal', 'evening'],
    formal: ['formal'],
    evening: ['evening'],
    'smart casual': ['smart_casual'],
    'business casual': ['smart_casual'],
    loungewear: ['lounge'],
    lounge: ['lounge'],
    sleepwear: ['sleepwear'],
    nightwear: ['sleepwear'],
  };
  for (const raw of values || []) {
    const norm = normalizeText(raw);
    if (!norm) continue;
    if ((ALLOWED_OCCASIONS as readonly string[]).includes(norm as OccasionTag)) out.push(norm as OccasionTag);
    else out.push(...(fallback[norm] || []));
  }
  return uniq(out);
}

function toColour(value: string | null | undefined): Colour | null {
  const norm = normalizeText(value);
  if (!norm) return null;
  if ((ALLOWED_COLOURS as readonly string[]).includes(norm as Colour)) return norm as Colour;
  if (/\b(navy|indigo|azure|cobalt|sky)\b/.test(norm)) return 'blue';
  if (/\b(cream|ecru|ivory|off white|offwhite|bone|oat|sand|khaki|camel|tan)\b/.test(norm)) return 'beige';
  if (/\b(maroon|burgundy|crimson|scarlet|wine)\b/.test(norm)) return 'red';
  if (/\b(chartreuse|lime|olive|forest|emerald|sage|mint)\b/.test(norm)) return 'green';
  if (/\b(fuchsia|magenta|rose|blush|salmon|coral)\b/.test(norm)) return 'pink';
  if (/\b(gold|mustard|amber|lemon|sunflower)\b/.test(norm)) return 'yellow';
  if (/\b(violet|lilac|lavender|plum|mauve)\b/.test(norm)) return 'purple';
  if (/\b(charcoal|graphite|slate)\b/.test(norm)) return 'grey';
  if (/\b(chocolate|espresso|coffee|walnut|mahogany|taupe)\b/.test(norm)) return 'brown';
  return null;
}

function canonicalizeSubtype(value: string | null | undefined): string {
  const norm = normalizeText(value);
  if (!norm) return '';
  const mappings: Array<[RegExp, string]> = [
    [/\bsuit\b/g, 'suit'],
    [/\bblazer\b/g, 'blazer'],
    [/\bsuit jacket\b/g, 'suit jacket'],
    [/\btuxedo\b/g, 'tuxedo jacket'],
    [/\bwaistcoat\b/g, 'waistcoat'],
    [/\bdress shirt\b/g, 'dress shirt'],
    [/\boxford shirt\b/g, 'oxford shirt'],
    [/\bcargo trousers?\b/g, 'cargo trousers'],
    [/\bcargo pants\b/g, 'cargo trousers'],
    [/\btailored trousers?\b/g, 'tailored trousers'],
    [/\bdress pants\b/g, 'dress pants'],
    [/\bjeans\b/g, 'jeans'],
    [/\bhoodie\b/g, 'hoodie'],
    [/\bsweatshirt\b/g, 'sweatshirt'],
    [/\bsweater\b/g, 'sweater'],
    [/\bshirt\b/g, 'shirt'],
    [/\bpolo\b/g, 'polo'],
    [/\bboots?\b/g, 'boots'],
    [/\bsneakers?\b/g, 'sneakers'],
    [/\bloafers?\b/g, 'loafers'],
    [/\boxford\/derby\b/g, 'oxford/derby'],
    [/\boxford\b/g, 'oxford/derby'],
    [/\bderby\b/g, 'oxford/derby'],
    [/\bheels\b/g, 'heels'],
    [/\bpumps\b/g, 'pumps'],
    [/\bstilettos\b/g, 'stilettos'],
    [/\bkitten heels\b/g, 'kitten heels'],
    [/\bslingbacks\b/g, 'slingbacks'],
    [/\bslippers\b/g, 'slippers'],
    [/\bcocktail dress\b/g, 'cocktail dress'],
    [/\bevening dress\b/g, 'evening dress'],
    [/\bgown\b/g, 'gown'],
    [/\bdress\b/g, 'dress'],
    [/\bnightgown\b/g, 'nightgown'],
    [/\bpajama top\b/g, 'pajama top'],
    [/\bpajama pants\b/g, 'pajama pants'],
    [/\brobe\b/g, 'robe'],
    [/\blounge pants\b/g, 'lounge pants'],
    [/\bsleep shorts\b/g, 'sleep shorts'],
    [/\baccessory\b/g, 'accessory'],
  ];
  for (const [re, replacement] of mappings) {
    if (re.test(norm)) return replacement;
  }
  return norm;
}

function expandEntityAliases(raw: string): string[] {
  const base = normalizeText(raw);
  if (!base) return [];
  const tokens = base.split(' ').filter(Boolean);
  const acr = acronym(base);
  const out = new Set<string>([base, ...tokens]);
  if (acr.length >= 3) out.add(acr);
  if (tokens.length >= 2) out.add(tokens.join(''));
  return Array.from(out);
}

function inferOccasionFromTextParts(parts: string[]): OccasionTag[] {
  const text = normalizeText(parts.join(' '));
  const out = new Set<OccasionTag>();
  if (!text) return [];
  if (/\b(formal|black tie|tuxedo|suit|blazer|dress shirt|tailored trousers|dress pants|oxford\/derby|loafer|heels|pumps|stilettos|slingbacks|cocktail dress|evening dress|gown)\b/.test(text)) out.add('formal');
  if (/\b(date night|evening|cocktail dress|evening dress|gown|heels|pumps|stilettos)\b/.test(text)) out.add('evening');
  if (/\b(preppy|ivy|collegiate|college|varsity|polo|oxford shirt|smart casual|business casual)\b/.test(text)) out.add('smart_casual');
  if (/\b(loungewear|lounge|robe|slippers|cozy|comfy)\b/.test(text)) out.add('lounge');
  if (/\b(pajama|sleepwear|nightwear|nightgown|sleep shorts|slippers)\b/.test(text)) out.add('sleepwear');
  return Array.from(out);
}

function inferItemOccasionTags(item: Partial<IndexItem>): OccasionTag[] {
  const explicit = normalizeOccasionTags(item.occasion_tags || []);
  if (explicit.length) return explicit;
  return inferOccasionFromTextParts([
    item.sub || '',
    item.name || '',
    item.name_normalized || '',
    ...(item.vibes || []),
    ...((item.entityMeta || []).map((entity) => entity.text)),
  ]);
}

function isFormalSubtype(value: string | null | undefined): boolean {
  const sub = canonicalizeSubtype(value);
  return !!sub && (FORMAL_TOP_SUBS.has(sub) || FORMAL_BOTTOM_SUBS.has(sub) || FORMAL_SHOE_SUBS.has(sub));
}

function isLoungeSubtype(value: string | null | undefined): boolean {
  const sub = canonicalizeSubtype(value);
  return !!sub && (LOUNGE_TOP_SUBS.has(sub) || LOUNGE_BOTTOM_SUBS.has(sub) || LOUNGE_SHOE_SUBS.has(sub));
}

function isSleepwearSubtype(value: string | null | undefined): boolean {
  const sub = canonicalizeSubtype(value);
  return !!sub && (SLEEPWEAR_MONO_SUBS.has(sub) || sub.includes('pajama'));
}

function looksLikeAccessory(value: string | null | undefined): boolean {
  return ACCESSORY_SUBS.has(canonicalizeSubtype(value));
}

function inferSportFromText(value: string | null | undefined): string | null {
  const norm = normalizeText(value);
  if (!norm) return null;
  if (norm.includes('soccer')) return 'football';
  if (/\b(football|basketball|tennis|running|runner|gym|workout|training)\b/.test(norm)) {
    const direct = norm.match(/\b(football|basketball|tennis|running|runner|gym|workout|training)\b/)?.[1] || '';
    if (direct === 'runner') return 'running';
    if (direct === 'workout' || direct === 'training') return 'gym';
    return direct;
  }
  const explicit = norm.match(/\b(cycling|cricket|rugby|golf|hockey|baseball|volleyball|boxing|mma|ski|snowboard|skate|motorsport|f1|ufc|lacrosse|handball|padel|pickleball)\b/);
  if (explicit) return explicit[1];
  const ball = norm.match(/\b([a-z]+ball)\b/);
  if (ball) return ball[1];
  if (/\bsport|sportswear|athletic\b/.test(norm)) return 'sport';
  return null;
}

type AnnotateImageResponse = protos.google.cloud.vision.v1.IAnnotateImageResponse;
type Hit = { cat: CategoryMain; sub: string; w: number };

type FixtureInput = {
  id?: string;
  imagePath?: string;
  name?: string;
  labels?: string[];
  webEntities?: string[];
  bestGuess?: string[];
  logos?: Array<{ text: string; score?: number }>;
  ocr?: string;
  colours?: Colour[];
  expected?: Record<string, any>;
};

type RawSignals = {
  id: string;
  imagePath: string;
  name: string;
  labels: string[];
  webEntities: string[];
  bestGuess: string[];
  logos: Array<{ text: string; score?: number }>;
  ocr: string;
  coloursFromInput?: Colour[];
};

type ClassifiedV2Item = IndexItem & {
  occasion_tags: OccasionTag[];
  confidence: ConfidenceBreakdown;
};

const argv = yargs(hideBin(process.argv))
  .option('images_dir', { type: 'string', describe: 'Directory of images to classify' })
  .option('out', { type: 'string', default: 'index.v2.json' })
  .option('min_colours', { type: 'number', default: 1, describe: 'Guarantee at least this many colours (1-2)' })
  .option('names_json', { type: 'string', describe: 'Optional JSON mapping { "<filename or base>": "Product Name" }' })
  .option('fixtures_json', {
    type: 'string',
    describe: 'Optional deterministic fixture JSON for offline smoke evaluation',
  })
  .parseSync();

const client = new vision.ImageAnnotatorClient();

const CANON: Record<Colour, [number, number, number]> = {
  black: [20, 20, 20],
  white: [235, 235, 235],
  grey: [128, 128, 128],
  red: [200, 30, 30],
  blue: [40, 80, 200],
  green: [40, 160, 80],
  beige: [220, 205, 180],
  brown: [120, 80, 40],
  pink: [230, 150, 190],
  yellow: [230, 210, 40],
  purple: [140, 80, 180],
};

const LEXICON = new Map<string, Hit>([
  ['shirt dress', { cat: 'mono', sub: 'shirt dress', w: 4.5 }],
  ['slip dress', { cat: 'mono', sub: 'slip dress', w: 4.5 }],
  ['wrap dress', { cat: 'mono', sub: 'wrap dress', w: 4 }],
  ['cocktail dress', { cat: 'mono', sub: 'cocktail dress', w: 5 }],
  ['evening dress', { cat: 'mono', sub: 'evening dress', w: 5 }],
  ['gown', { cat: 'mono', sub: 'gown', w: 5 }],
  ['nightgown', { cat: 'mono', sub: 'nightgown', w: 5 }],
  ['dress', { cat: 'mono', sub: 'dress', w: 3.5 }],
  ['jumpsuit', { cat: 'mono', sub: 'jumpsuit', w: 4 }],
  ['romper', { cat: 'mono', sub: 'romper', w: 4 }],
  ['onepiece', { cat: 'mono', sub: 'one-piece', w: 3.5 }],

  ['suit jacket', { cat: 'top', sub: 'suit jacket', w: 5 }],
  ['tuxedo jacket', { cat: 'top', sub: 'tuxedo jacket', w: 5 }],
  ['blazer', { cat: 'top', sub: 'blazer', w: 4 }],
  ['dress shirt', { cat: 'top', sub: 'dress shirt', w: 4 }],
  ['oxford shirt', { cat: 'top', sub: 'oxford shirt', w: 4 }],
  ['jersey', { cat: 'top', sub: 'shirt', w: 3.5 }],
  ['shirt', { cat: 'top', sub: 'shirt', w: 2.5 }],
  ['polo', { cat: 'top', sub: 'polo', w: 3 }],
  ['waistcoat', { cat: 'top', sub: 'waistcoat', w: 4.5 }],
  ['robe', { cat: 'top', sub: 'robe', w: 4.5 }],
  ['pajama top', { cat: 'top', sub: 'pajama top', w: 5 }],
  ['hoodie', { cat: 'top', sub: 'hoodie', w: 3 }],
  ['sweatshirt', { cat: 'top', sub: 'sweatshirt', w: 3 }],
  ['sweater', { cat: 'top', sub: 'sweater', w: 3 }],
  ['cardigan', { cat: 'top', sub: 'cardigan', w: 3 }],
  ['tshirt', { cat: 'top', sub: 't-shirt', w: 3 }],
  ['graphic tee', { cat: 'top', sub: 't-shirt', w: 3 }],

  ['tailored trousers', { cat: 'bottom', sub: 'tailored trousers', w: 5 }],
  ['dress pants', { cat: 'bottom', sub: 'dress pants', w: 5 }],
  ['cargo trousers', { cat: 'bottom', sub: 'cargo trousers', w: 4.5 }],
  ['cargo pants', { cat: 'bottom', sub: 'cargo trousers', w: 4.5 }],
  ['trousers', { cat: 'bottom', sub: 'trousers', w: 3 }],
  ['pants', { cat: 'bottom', sub: 'trousers', w: 3 }],
  ['jeans', { cat: 'bottom', sub: 'jeans', w: 3 }],
  ['cargo', { cat: 'bottom', sub: 'cargo trousers', w: 3 }],
  ['joggers', { cat: 'bottom', sub: 'joggers', w: 3 }],
  ['pajama pants', { cat: 'bottom', sub: 'pajama pants', w: 5 }],
  ['lounge pants', { cat: 'bottom', sub: 'lounge pants', w: 4.5 }],
  ['sleep shorts', { cat: 'bottom', sub: 'sleep shorts', w: 4 }],
  ['shorts', { cat: 'bottom', sub: 'shorts', w: 3 }],
  ['skirt', { cat: 'bottom', sub: 'skirt', w: 2.5 }],

  ['formal shoes', { cat: 'shoes', sub: 'formal shoes', w: 4 }],
  ['loafers', { cat: 'shoes', sub: 'loafers', w: 4 }],
  ['oxford/derby', { cat: 'shoes', sub: 'oxford/derby', w: 4 }],
  ['heels', { cat: 'shoes', sub: 'heels', w: 4 }],
  ['pumps', { cat: 'shoes', sub: 'pumps', w: 4.5 }],
  ['stilettos', { cat: 'shoes', sub: 'stilettos', w: 4.5 }],
  ['kitten heels', { cat: 'shoes', sub: 'kitten heels', w: 4.5 }],
  ['slingbacks', { cat: 'shoes', sub: 'slingbacks', w: 4.5 }],
  ['slippers', { cat: 'shoes', sub: 'slippers', w: 5 }],
  ['boots', { cat: 'shoes', sub: 'boots', w: 3 }],
  ['sneakers', { cat: 'shoes', sub: 'sneakers', w: 3 }],
  ['shoe', { cat: 'shoes', sub: 'shoes', w: 1 }],

  ['bag', { cat: 'top', sub: 'accessory', w: 1 }],
  ['handbag', { cat: 'top', sub: 'accessory', w: 1 }],
  ['cap', { cat: 'top', sub: 'accessory', w: 1 }],
  ['belt', { cat: 'top', sub: 'accessory', w: 1 }],
]);

const LABEL_HINTS: Array<[RegExp, Hit]> = [
  [/\bdress(?!\s+shoe)/i, { cat: 'mono', sub: 'dress', w: 5 }],
  [/\bevening dress/i, { cat: 'mono', sub: 'evening dress', w: 5 }],
  [/\bcocktail dress/i, { cat: 'mono', sub: 'cocktail dress', w: 5 }],
  [/\bnightgown/i, { cat: 'mono', sub: 'nightgown', w: 5 }],
  [/\bgown/i, { cat: 'mono', sub: 'gown', w: 5 }],
  [/\bshoe|footwear|sneaker|boot|loafer|oxford|derby|heel|pump|slipper|sandal|slide/i, { cat: 'shoes', sub: 'shoes', w: 4.5 }],
  [/\btrouser|pant|jean|cargo|jogger|short|skirt/i, { cat: 'bottom', sub: 'bottom', w: 4 }],
  [/\bjersey/i, { cat: 'top', sub: 'shirt', w: 4 }],
  [/\bblazer|jacket|coat|shirt|hoodie|sweatshirt|sweater|cardigan|robe|waistcoat|polo/i, { cat: 'top', sub: 'top', w: 4 }],
];

type CategoryScores = Record<CategoryMain, Record<string, number>>;

function nearestCanon([r, g, b]: [number, number, number]): Colour {
  let best: Colour = 'black';
  let bestD = Infinity;
  for (const [name, value] of Object.entries(CANON) as [Colour, [number, number, number]][]) {
    const d = (value[0] - r) ** 2 + (value[1] - g) ** 2 + (value[2] - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

function loadNamesMap(filePath?: string): Record<string, string> {
  if (!filePath) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
  } catch {}
  return {};
}

function deriveNameFromFilename(fileBase: string): string {
  let name = fileBase.replace(/[_-]+/g, ' ');
  name = name.replace(/\b(img|dsc|photo|picture)[-_]?\d+\b/gi, '').trim();
  return name || fileBase;
}

function buildEntityBag(entries: Array<{ text: string; score?: number; source?: string }>): Array<{ text: string; weight: number; source: string }> {
  const out = new Map<string, number>();
  const sourceMap = new Map<string, string>();
  for (const entry of entries) {
    const base = normalizeText(entry.text);
    if (!base) continue;
    for (const alias of expandEntityAliases(base)) {
      if (!alias || alias.length < 2) continue;
      if (alias.length <= 3 && !/^[a-z]{3}$/.test(alias)) continue;
      if (isGenericEntityTerm(alias) && !['logo', 'brand_candidate', 'team_candidate'].includes(entry.source || '')) continue;
      const weight = entry.score ?? 1;
      out.set(alias, Math.max(out.get(alias) ?? 0, weight));
      if (!sourceMap.has(alias)) sourceMap.set(alias, entry.source || 'generic');
    }
  }
  return Array.from(out.entries()).map(([text, weight]) => ({
    text,
    weight,
    source: sourceMap.get(text) || 'generic',
  }));
}

function tokensFromParts(parts: string[]): string[] {
  const normalized = parts.filter(Boolean).map(normalizeForTokens);
  const split = normalized.flatMap((part) => part.split(/[^a-z0-9/]+/g)).filter(Boolean);
  const bigrams: string[] = [];
  for (const part of normalized) {
    const words = part.split(/[^a-z0-9/]+/g).filter(Boolean);
    for (let i = 0; i < words.length - 1; i++) bigrams.push(`${words[i]} ${words[i + 1]}`);
  }
  return Array.from(new Set([...normalized, ...split, ...bigrams]));
}

function tagEntityType(value: string, source = 'generic'): EntityMeta['type'] {
  const text = normalizeText(value);
  if (source === 'logo') return 'brand';
  if (source === 'brand_candidate') return 'brand';
  if (source === 'team_candidate') return 'team';
  if (source === 'ocr' && /\b(sponsored by|official partner|presented by)\b/.test(text)) return 'sponsor';
  if (looksLikeTeamText(text)) return 'team';
  if (['name', 'web', 'best_guess'].includes(source) && looksLikeBrandText(text)) return 'brand';
  return 'generic';
}

function createScores(): CategoryScores {
  return {
    top: {},
    bottom: {},
    shoes: {},
    mono: {},
  };
}

function bump(scores: CategoryScores, cat: CategoryMain, sub: string, weight: number) {
  scores[cat][sub] = (scores[cat][sub] ?? 0) + weight;
}

function decideCategory(labels: string[], tokens: string[]): {
  category: CategoryMain;
  sub: string;
  confidence: number;
  scores: CategoryScores;
} {
  const scores = createScores();
  const joined = ` ${tokens.join(' ')} `;

  if (/\bdress\s+(shoe|shoes|oxford|derby|loafer|heel|pump|boot|slipper|sandal|slide)\b/i.test(joined)) {
    bump(scores, 'shoes', 'formal shoes', 10);
  }
  if (/\b(pajama|sleepwear|nightwear|nightgown|robe|slippers)\b/i.test(joined)) {
    bump(scores, 'top', 'robe', /\brobe\b/i.test(joined) ? 4 : 0);
    bump(scores, 'bottom', 'pajama pants', /\bpajama pants|sleep shorts\b/i.test(joined) ? 5 : 0);
    bump(scores, 'shoes', 'slippers', /\bslippers\b/i.test(joined) ? 5 : 0);
    bump(scores, 'mono', 'nightgown', /\bnightgown\b/i.test(joined) ? 5 : 0);
  }

  for (const label of labels) {
    for (const [re, hit] of LABEL_HINTS) {
      if (re.test(label)) bump(scores, hit.cat, hit.sub, hit.w);
    }
  }
  for (const token of tokens) {
    const hit = LEXICON.get(token);
    if (hit) bump(scores, hit.cat, hit.sub, hit.w);
  }

  if (/\bsuit\b/.test(joined)) {
    bump(scores, 'top', 'suit jacket', 4);
    bump(scores, 'bottom', 'tailored trousers', 3);
  }
  if (/\bevening dress\b/.test(joined)) {
    bump(scores, 'mono', 'evening dress', 6);
  }
  if (/\bcocktail dress\b/.test(joined)) {
    bump(scores, 'mono', 'cocktail dress', 6);
  }
  if (/\bloafers?\b/.test(joined)) {
    bump(scores, 'shoes', 'loafers', 5);
  }
  if (/\bslingbacks?\b/.test(joined)) {
    bump(scores, 'shoes', 'slingbacks', 5);
  }
  if (/\bpump\b/.test(joined)) {
    bump(scores, 'shoes', 'pumps', 3);
  }
  if (/\bstiletto\b/.test(joined)) {
    bump(scores, 'shoes', 'stilettos', 3);
  }
  if (/\bheel\b/.test(joined)) {
    bump(scores, 'shoes', 'heels', 2);
  }
  if (/\bloafer|oxford|derby|brogue\b/.test(joined)) {
    if (/\bloafer\b/.test(joined)) bump(scores, 'shoes', 'loafers', 3);
    if (/\boxford|derby|brogue\b/.test(joined)) bump(scores, 'shoes', 'oxford/derby', 3);
    bump(scores, 'shoes', 'formal shoes', 1.5);
  }
  if (/\bformal|tailored|tuxedo|black tie\b/.test(joined)) {
    bump(scores, 'top', 'blazer', 1.5);
    bump(scores, 'bottom', 'tailored trousers', 1.5);
    bump(scores, 'shoes', 'formal shoes', 1.2);
  }
  if (/\blounge|comfy|cozy|sleepwear|nightwear\b/.test(joined)) {
    bump(scores, 'top', 'pajama top', 1.8);
    bump(scores, 'bottom', 'lounge pants', 1.8);
    bump(scores, 'shoes', 'slippers', 1.2);
  }
  if (/\baccessory|handbag|bag|cap|belt|scarf\b/.test(joined)) {
    bump(scores, 'top', 'accessory', 2);
  }

  const genericSubs = new Set(['top', 'bottom', 'shoes', 'formal shoes']);
  const ranked = (Object.keys(scores) as CategoryMain[])
    .map((cat) => {
      const entries = Object.entries(scores[cat]).sort((a, b) => b[1] - a[1]);
      const specific = entries.find(([sub]) => !genericSubs.has(sub));
      return {
        cat,
        sub:
          (entries[0] && genericSubs.has(entries[0][0]) && specific?.[0]) ||
          specific?.[0] ||
          entries[0]?.[0] ||
          (cat === 'mono' ? 'dress' : cat),
        score: entries[0]?.[1] || 0,
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const second = ranked[1];

  if (!best || best.score < 1) {
    if (/\b(shoe|sneaker|boot|loafer|heel|pump|slipper|oxford|derby)\b/i.test(joined)) {
      return { category: 'shoes', sub: 'shoes', confidence: 0.55, scores };
    }
    if (/\b(dress|gown|nightgown|romper|jumpsuit)\b/i.test(joined)) {
      return { category: 'mono', sub: 'dress', confidence: 0.6, scores };
    }
    if (/\b(jeans|pants|trousers|skirt|shorts)\b/i.test(joined)) {
      return { category: 'bottom', sub: 'bottom', confidence: 0.55, scores };
    }
    return { category: 'top', sub: 'top', confidence: 0.45, scores };
  }

  const confidence = Math.max(0.4, Math.min(0.99, best.score / (best.score + (second?.score || 1))));
  let sub = canonicalizeSubtype(best.sub) || best.sub;
  if (best.cat === 'shoes') {
    if (/\bslingbacks?\b/.test(joined)) sub = 'slingbacks';
    else if (/\bloafers?\b/.test(joined)) sub = 'loafers';
    else if (/\boxford|derby|brogue\b/.test(joined)) sub = 'oxford/derby';
  }
  if (best.cat === 'mono') {
    if (/\bevening dress\b/.test(joined)) sub = 'evening dress';
    else if (/\bcocktail dress\b/.test(joined)) sub = 'cocktail dress';
    else if (/\bnightgown\b/.test(joined)) sub = 'nightgown';
  }
  return { category: best.cat, sub, confidence, scores };
}

function decideGender(labels: string[], tokens: string[], category: CategoryMain, sub: string): {
  gender: Gender;
  confidence: number;
} {
  const text = ` ${tokens.join(' ')} ${labels.join(' ').toLowerCase()} `;
  let men = 0;
  let women = 0;
  let unisex = 0;

  if (/\bunisex|gender neutral|gender-neutral|all gender\b/.test(text)) unisex += 7;
  if (/\bmen|mens|menswear|for men|male\b/.test(text)) men += 5;
  if (/\bwomen|womens|womenswear|for women|female|ladies\b/.test(text)) women += 5;

  if (category === 'mono') women += 4;
  if (/(cocktail dress|evening dress|gown|nightgown|heels|pumps|stilettos|slingbacks|mary jane)/.test(sub)) women += 4;
  if (/(oxford\/derby|waistcoat|dress shirt|oxford shirt)/.test(sub)) men += 2.5;
  if (category === 'shoes' || /(hoodie|sweatshirt|sweater|jeans|trousers|blazer|shirt|polo|loafers|slippers)/.test(sub)) unisex += 2;

  if (unisex >= Math.max(men, women) + 2) {
    return { gender: 'unisex', confidence: 0.8 };
  }
  if (women >= men + 2) {
    return { gender: 'women', confidence: 0.75 };
  }
  if (men >= women + 2) {
    return { gender: 'men', confidence: 0.7 };
  }
  if (category === 'mono') return { gender: 'women', confidence: 0.55 };
  return { gender: 'unisex', confidence: 0.5 };
}

function inferFit(category: CategoryMain, sub: string, tokens: string[]): {
  fit: Fit | null;
  confidence: number;
} {
  if (category !== 'top' && category !== 'bottom') return { fit: null, confidence: 0 };
  const text = ` ${tokens.join(' ')} `;
  if (/\bcrop|cropped\b/.test(text)) return { fit: 'cropped', confidence: 0.9 };
  if (/\b(oversized|boxy|slouchy|relaxed|loose fit|loose|baggy|wide leg|wide-leg)\b/.test(text)) {
    return { fit: 'oversized', confidence: 0.85 };
  }
  if (/\b(slim fit|slim-fit|slim|skinny|fitted|tailored|tapered)\b/.test(text) || /tailored trousers|dress pants/.test(sub)) {
    return { fit: 'slim', confidence: 0.75 };
  }
  if (/(pajama pants|lounge pants|robe|hoodie|sweatshirt)/.test(sub)) {
    return { fit: 'regular', confidence: 0.55 };
  }
  return { fit: 'regular', confidence: 0.45 };
}

function inferVibes(tokens: string[], category: CategoryMain, colours: Colour[], occasionTags: OccasionTag[], sub: string): {
  vibes: Vibe[];
  confidence: number;
} {
  const text = ` ${tokens.join(' ')} ${sub} `;
  const vibeInputs: string[] = [];

  if (/\b(streetwear|street|urban|skate|graphic|logo|hype|hoodie|cargo)\b/.test(text)) vibeInputs.push('streetwear');
  if (/\b(grunge|goth|punk|rock|biker|distressed|leather)\b/.test(text) || (colours.includes('black') && /boots|leather|jacket/.test(text))) vibeInputs.push('edgy');
  if (/\b(minimal|minimalist|clean|basic|plain|simple|capsule|neutral|essentials)\b/.test(text)) vibeInputs.push('minimal');
  if (/\b(y2k|2000s|early 2000)\b/.test(text)) vibeInputs.push('y2k');
  if (/\b(techwear|gore tex|utility|tactical|shell|nylon)\b/.test(text)) vibeInputs.push('techwear');
  if (/\b(sport|sportswear|athletic|training|running|gym|football|basketball|tennis|jersey)\b/.test(text)) vibeInputs.push('sporty');
  if (/\b(preppy|ivy|collegiate|varsity|prep|argyle|polo|oxford shirt)\b/.test(text)) vibeInputs.push('preppy');
  if (/\b(vintage|retro|heritage|throwback|oldschool)\b/.test(text)) vibeInputs.push('vintage');
  if (/\b(chic|elegant|silk|satin|dressy)\b/.test(text) || occasionTags.includes('evening')) vibeInputs.push('chic');
  if (occasionTags.includes('formal') || isFormalSubtype(sub)) vibeInputs.push('formal');
  if (occasionTags.includes('lounge') || occasionTags.includes('sleepwear') || isLoungeSubtype(sub) || isSleepwearSubtype(sub)) {
    vibeInputs.push('comfy');
  }

  if (category === 'mono' && (occasionTags.includes('formal') || colours.includes('black'))) {
    vibeInputs.push('chic');
  }

  const vibes = normalizeVibes(vibeInputs).slice(0, 3);
  return { vibes, confidence: vibes.length ? 0.75 : 0.35 };
}

function inferSportFromTeams(teams: string[]): string | null {
  const text = normalizeText(teams.join(' '));
  if (!text) return null;
  if (/\b(nba|basketball)\b/.test(text)) return 'basketball';
  if (/\b(nhl|hockey)\b/.test(text)) return 'hockey';
  if (/\b(mlb|baseball)\b/.test(text)) return 'baseball';
  if (/\b(fc|cf|afc|football|soccer)\b/.test(text)) return 'football';
  if (/\btennis\b/.test(text)) return 'tennis';
  return null;
}

function inferSportMeta(category: CategoryMain, sub: string, vibes: Vibe[], tokens: string[], labels: string[], entityMeta: EntityMeta[]): {
  sportMeta: SportMeta | null;
  confidence: number;
} {
  const text = ` ${tokens.join(' ')} ${labels.join(' ')} `;
  const teams = entityMeta.filter((entity) => entity.type === 'team').map((entity) => entity.text);
  const sport = inferSportFromText(text) || inferSportFromTeams(teams);

  const sportyBySub = /(jersey|sports bra|track pants|cleats)/.test(sub);
  const sporty = !!sport || sportyBySub || vibes.includes('sporty');
  if (!sporty) return { sportMeta: null, confidence: 0.4 };

  const isKit = (category === 'top' || category === 'bottom') && teams.length > 0 && /\b(kit|home|away|third|jersey)\b/.test(text);
  return {
    sportMeta: {
      sport: sport || 'sport',
      teams,
      isKit,
    },
    confidence: sport ? 0.8 : 0.6,
  };
}

function inferOccasionTags(tokens: string[], category: CategoryMain, sub: string, vibes: Vibe[]): {
  occasionTags: OccasionTag[];
  confidence: number;
} {
  const tags = new Set<OccasionTag>(inferItemOccasionTags({
    category,
    sub,
    vibes,
    name: tokens.join(' '),
  }));

  if (isFormalSubtype(sub)) tags.add('formal');
  if (/(cocktail dress|evening dress|gown|heels|pumps|stilettos|slingbacks)/.test(sub)) tags.add('evening');
  if (/(polo|oxford shirt|blazer)/.test(sub) || vibes.includes('preppy')) tags.add('smart_casual');
  if (isLoungeSubtype(sub)) tags.add('lounge');
  if (isSleepwearSubtype(sub)) tags.add('sleepwear');

  const occasionTags = normalizeOccasionTags(Array.from(tags));
  return {
    occasionTags,
    confidence: occasionTags.length ? 0.75 : 0.35,
  };
}

function colourSynonymToCanon(word: string): Colour | null {
  return toColour(word);
}

function coloursFromTokens(tokens: string[], limit = 2): Colour[] {
  const out: Colour[] = [];
  for (const token of tokens) {
    const colour = colourSynonymToCanon(token);
    if (colour && !out.includes(colour)) out.push(colour);
    if (out.length >= limit) break;
  }
  return out;
}

async function averageCanonViaSharpCenter(filePath: string): Promise<Colour | null> {
  try {
    const sharp = (await import('sharp')).default;
    const img = sharp(filePath);
    const meta = await img.metadata();
    const width = meta.width || 256;
    const height = meta.height || 256;
    const side = Math.floor(Math.min(width, height) * 0.6);
    const left = Math.floor((width - side) / 2);
    const top = Math.floor((height - side) / 2);
    const { data, info } = await img
      .extract({ left, top, width: side, height: side })
      .resize(64, 64, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < info.width * info.height; i++) {
      r += data[3 * i];
      g += data[3 * i + 1];
      b += data[3 * i + 2];
    }
    const n = info.width * info.height || 1;
    return nearestCanon([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
  } catch {
    return null;
  }
}

async function extractColours(
  filePath: string,
  propRes: AnnotateImageResponse | null,
  tokens: string[],
  minColours: number,
  prefilled: Colour[] = [],
): Promise<Colour[]> {
  const colours: Colour[] = [];
  for (const colour of prefilled) {
    if ((ALLOWED_COLOURS as readonly string[]).includes(colour) && !colours.includes(colour)) {
      colours.push(colour);
    }
  }
  const dominant = (propRes?.imagePropertiesAnnotation?.dominantColors?.colors || []).slice();
  const sorted = dominant.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3);
  for (const color of sorted) {
    const rgb: [number, number, number] = [
      Math.round(color.color?.red ?? 0),
      Math.round(color.color?.green ?? 0),
      Math.round(color.color?.blue ?? 0),
    ];
    const name = nearestCanon(rgb);
    if (!colours.includes(name)) colours.push(name);
    if (colours.length >= 2) break;
  }
  if (colours.length < 2) {
    for (const tokenColour of coloursFromTokens(tokens, 2)) {
      if (!colours.includes(tokenColour)) colours.push(tokenColour);
    }
  }
  if (filePath && colours.length < Math.max(1, Math.min(2, minColours))) {
    const avg = await averageCanonViaSharpCenter(filePath);
    if (avg && !colours.includes(avg)) colours.push(avg);
  }
  if (!colours.length) colours.push('grey');
  return colours.slice(0, 2);
}

async function classifySignals(
  signals: RawSignals,
  minColours: number,
  propRes?: AnnotateImageResponse | null,
): Promise<ClassifiedV2Item> {
  const labelDescs = signals.labels.map((label) => label.toLowerCase()).filter(Boolean);
  const labelsForDecision = labelDescs.slice();
  const rawEntityEntries = [
    ...(signals.logos || []).map((entry) => ({ ...entry, source: 'logo' })),
    ...(signals.webEntities || []).map((text) => ({ text, score: 0.9, source: 'web' })),
    ...(signals.bestGuess || []).map((text) => ({ text, score: 0.8, source: 'best_guess' })),
    { text: signals.name, score: 0.95, source: 'name' },
    { text: path.basename(signals.id, path.extname(signals.id)), score: 0.55, source: 'filename' },
    { text: signals.ocr, score: 0.7, source: 'ocr' },
  ];
  const structuredSourceEntries = rawEntityEntries.filter((entry) =>
    ['web', 'best_guess', 'name'].includes(entry.source || ''),
  );
  const derivedEntityEntries = rawEntityEntries.flatMap((entry) => deriveStructuredEntityEntries(entry));
  const structuredBrandCandidates = uniq(
    structuredSourceEntries
      .map((entry) => extractLeadingCandidate(entry.text || '', PRODUCT_SUFFIX_TERMS))
      .filter((value): value is string => !!value)
      .filter((value) => !looksLikeTeamText(value)),
  );
  const structuredTeamCandidates = uniq(
    structuredSourceEntries
      .map((entry) => extractLeadingCandidate(entry.text || '', TEAM_SUFFIX_TERMS))
      .filter((value): value is string => !!value),
  );
  const entityBag = [
    ...buildEntityBag(rawEntityEntries),
    ...buildEntityBag(derivedEntityEntries),
  ];
  const entityInfo = new Map<string, { weight: number; source: string }>();
  for (const entity of entityBag) {
    const prev = entityInfo.get(entity.text);
    const nextSource = entity.source || 'generic';
    if (
      !prev ||
      entity.weight > prev.weight ||
      (entity.weight === prev.weight && entitySourcePriority(nextSource) > entitySourcePriority(prev.source))
    ) {
      entityInfo.set(entity.text, { weight: entity.weight, source: nextSource });
    }
  }
  for (const entry of derivedEntityEntries) {
    const text = normalizeText(entry.text);
    if (!text || isGenericEntityTerm(text)) continue;
    const prev = entityInfo.get(text);
    const weight = entry.score ?? 1;
    const source = entry.source || 'generic';
    if (
      !prev ||
      weight > prev.weight ||
      (weight === prev.weight && entitySourcePriority(source) > entitySourcePriority(prev.source))
    ) {
      entityInfo.set(text, { weight, source });
    }
  }
  const entities = Array.from(entityInfo.keys());
  const entityMeta: EntityMeta[] = entities.map((text) => ({
    text,
    weight: entityInfo.get(text)?.weight || 1,
    type: tagEntityType(text, entityInfo.get(text)?.source),
  }));
  for (const candidate of structuredBrandCandidates) {
    const existing = entityMeta.find((entity) => entity.text === candidate);
    if (existing) existing.type = 'brand';
    else {
      entityMeta.push({ text: candidate, weight: 0.96, type: 'brand' });
      entities.push(candidate);
    }
  }
  for (const candidate of structuredTeamCandidates) {
    const existing = entityMeta.find((entity) => entity.text === candidate);
    if (existing) existing.type = 'team';
    else {
      entityMeta.push({ text: candidate, weight: 0.96, type: 'team' });
      entities.push(candidate);
    }
  }

  const tokens = tokensFromParts([
    ...labelDescs,
    ...(signals.webEntities || []),
    ...(signals.bestGuess || []),
    signals.name,
    path.basename(signals.id, path.extname(signals.id)),
    signals.ocr,
  ]);

  const categoryResult = decideCategory(labelsForDecision, tokens);
  let sub = canonicalizeSubtype(categoryResult.sub) || categoryResult.sub;
  const tokenText = tokens.join(' ');
  if ((sub === 'shirt' || sub === 'top') && /\bdress shirt\b/.test(tokenText)) sub = 'dress shirt';
  else if ((sub === 'shirt' || sub === 'top') && /\boxford shirt\b/.test(tokenText)) sub = 'oxford shirt';
  else if (sub === 'top' && /\bjersey\b/.test(tokenText)) sub = 'shirt';
  const genderResult = decideGender(labelsForDecision, tokens, categoryResult.category, sub);
  const fitResult = inferFit(categoryResult.category, sub, tokens);
  const colours = await extractColours(
    signals.imagePath && fs.existsSync(signals.imagePath) ? signals.imagePath : '',
    propRes || null,
    tokens,
    minColours,
    signals.coloursFromInput,
  );
  let occasionResult = inferOccasionTags(tokens, categoryResult.category, sub, []);
  let vibeResult = inferVibes(tokens, categoryResult.category, colours, occasionResult.occasionTags, sub);
  occasionResult = inferOccasionTags(tokens, categoryResult.category, sub, vibeResult.vibes);
  vibeResult = inferVibes(tokens, categoryResult.category, colours, occasionResult.occasionTags, sub);
  const sportResult = inferSportMeta(
    categoryResult.category,
    sub,
    vibeResult.vibes,
    tokens,
    labelsForDecision,
    entityMeta,
  );

  if (looksLikeAccessory(sub)) {
    categoryResult.confidence = Math.min(categoryResult.confidence, 0.42);
  }

  if (isFormalSubtype(sub) && !occasionResult.occasionTags.includes('formal')) {
    occasionResult.occasionTags.push('formal');
  }
  if (isSleepwearSubtype(sub) && !occasionResult.occasionTags.includes('sleepwear')) {
    occasionResult.occasionTags.push('sleepwear');
  }
  if (isLoungeSubtype(sub) && !occasionResult.occasionTags.includes('lounge')) {
    occasionResult.occasionTags.push('lounge');
  }

  if (!vibeResult.vibes.length) {
    if (occasionResult.occasionTags.includes('formal')) vibeResult.vibes.push('formal');
    else if (occasionResult.occasionTags.includes('lounge') || occasionResult.occasionTags.includes('sleepwear')) vibeResult.vibes.push('comfy');
  }

  const styleSignals = deriveStyleSignals({
    category: categoryResult.category,
    sub,
    colours,
    vibes: vibeResult.vibes,
    occasion_tags: occasionResult.occasionTags,
    name: signals.name,
    name_normalized: normalizeText(signals.name),
    entities,
    entityMeta,
    sportMeta: sportResult.sportMeta,
  });

  return {
    id: signals.id,
    imagePath: signals.imagePath,
    category: categoryResult.category,
    sub,
    colours,
    vibes: vibeResult.vibes,
    gender: genderResult.gender,
    fit: fitResult.fit,
    sportMeta: sportResult.sportMeta,
    name: signals.name,
    name_normalized: normalizeText(signals.name),
    entities,
    entityMeta,
    occasion_tags: occasionResult.occasionTags,
    style_markers: styleSignals.style_markers,
    formality_score: styleSignals.formality_score,
    streetwear_score: styleSignals.streetwear_score,
    cleanliness_score: styleSignals.cleanliness_score,
    confidence: {
      category: categoryResult.confidence,
      sub: categoryResult.scores[categoryResult.category][sub]
        ? Math.min(0.99, 0.4 + categoryResult.scores[categoryResult.category][sub] / 8)
        : 0.45,
      gender: genderResult.confidence,
      fit: fitResult.confidence,
      vibes: vibeResult.confidence,
      occasion: occasionResult.confidence,
      sport: sportResult.confidence,
    },
  };
}

async function readSignalsFromImage(
  filePath: string,
  resolvedName: string,
): Promise<{ signals: RawSignals; propRes: AnnotateImageResponse | null }> {
  const [labelRes] = await client.labelDetection(filePath);
  const [propRes] = await client.imageProperties(filePath);
  const [webRes] = await client.webDetection(filePath);
  const [logoRes] = await client.logoDetection(filePath);
  const [textRes] = await client.textDetection(filePath);

  return {
    signals: {
      id: path.basename(filePath),
      imagePath: filePath,
      name: resolvedName,
      labels: (labelRes.labelAnnotations || []).map((item) => item.description || '').filter(Boolean),
      webEntities: (webRes.webDetection?.webEntities || []).map((item) => item.description || '').filter(Boolean),
      bestGuess: (webRes.webDetection?.bestGuessLabels || []).map((item) => item.label || '').filter(Boolean),
      logos: (logoRes.logoAnnotations || [])
        .map((item) => ({ text: item.description || '', score: item.score ?? 0 }))
        .filter((item) => item.text),
      ocr: (textRes.textAnnotations?.[0]?.description || '').trim(),
    },
    propRes: { imagePropertiesAnnotation: (propRes as any).imagePropertiesAnnotation } as any,
  };
}

function loadFixtures(filePath: string): FixtureInput[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`fixtures_json must be a JSON array: ${filePath}`);
  }
  return parsed as FixtureInput[];
}

async function main() {
  const outPath = path.resolve(argv.out as string);
  const minColours = Math.max(1, Math.min(2, argv.min_colours as number));
  const namesMap = loadNamesMap(argv.names_json as string | undefined);
  const index: ClassifiedV2Item[] = [];

  if (argv.fixtures_json) {
    const fixtures = loadFixtures(path.resolve(argv.fixtures_json as string));
    for (const fixture of fixtures) {
      const id = fixture.id || fixture.imagePath || fixture.name || `fixture-${index.length + 1}`;
      const signals: RawSignals = {
        id,
        imagePath: fixture.imagePath || id,
        name: fixture.name || deriveNameFromFilename(path.basename(id, path.extname(id))),
        labels: fixture.labels || [],
        webEntities: fixture.webEntities || [],
        bestGuess: fixture.bestGuess || [],
        logos: fixture.logos || [],
        ocr: fixture.ocr || '',
        coloursFromInput: fixture.colours || [],
      };
      const item = await classifySignals(signals, minColours, null);
      index.push(item);
      console.log(
        `Tagged ${id} -> cat=${item.category}/${item.sub || '-'} | gender=${item.gender}` +
          ` | fit=${item.fit || '-'} | occasion=${item.occasion_tags.join(',') || '-'}` +
          ` | vibes=${item.vibes.join(',') || '-'} | conf=${(item.confidence.category || 0).toFixed(2)}`
      );
    }
  } else {
    const dir = argv.images_dir as string | undefined;
    if (!dir) {
      console.error('Either --images_dir or --fixtures_json is required.');
      process.exit(1);
    }
    const absDir = path.resolve(dir);
    if (!fs.existsSync(absDir)) {
      console.error('images_dir not found:', absDir);
      process.exit(1);
    }
    const images = fs.readdirSync(absDir).filter((file) => /\.(jpe?g|png)$/i.test(file));
    for (const file of images) {
      const filePath = path.join(absDir, file);
      const fileBase = path.basename(file, path.extname(file));
      const resolvedName = namesMap[file] || namesMap[fileBase] || deriveNameFromFilename(fileBase);
      const { signals, propRes } = await readSignalsFromImage(filePath, resolvedName);
      const item = await classifySignals(signals, minColours, propRes);
      index.push(item);
      const sportLog = item.sportMeta
        ? `${item.sportMeta.sport}${item.sportMeta.isKit ? ' (kit)' : ''}${item.sportMeta.teams?.length ? ` [${item.sportMeta.teams.join('|')}]` : ''}`
        : '-';
      console.log(
        `Tagged ${file} -> cat=${item.category}/${item.sub || '-'} | gender=${item.gender}` +
          ` | fit=${item.fit || '-'} | sport=${sportLog}` +
          ` | occasion=${item.occasion_tags.join(',') || '-'}` +
          ` | colours=${item.colours.join(',')}` +
          ` | vibes=${item.vibes.join(',') || '-'}`
      );
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(index, null, 2), 'utf8');
  console.log(`\nWrote ${outPath} with ${index.length} items.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
