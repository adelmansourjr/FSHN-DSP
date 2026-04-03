import { acronym, escapeRegExp, rmDiacritics, uniq } from './text';

export type CategoryMain = 'top' | 'bottom' | 'shoes' | 'mono';
export type Gender = 'men' | 'women' | 'unisex';
export type Colour =
  | 'black'
  | 'white'
  | 'grey'
  | 'red'
  | 'blue'
  | 'green'
  | 'beige'
  | 'brown'
  | 'pink'
  | 'orange'
  | 'yellow'
  | 'purple';
export type Vibe =
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
export type OccasionTag = 'smart_casual' | 'formal' | 'evening' | 'lounge' | 'sleepwear';
export type Fit = 'oversized' | 'regular' | 'slim' | 'cropped';
export type Sport = string;
export type EntityType = 'brand' | 'team' | 'sponsor' | 'generic';
export type Mode = 'outfit' | 'single';
export type SettingContext = 'office' | 'beach' | 'nightlife' | 'home' | 'travel' | 'resort' | 'campus' | 'formal_event';
export type ActivityContext = 'sleep' | 'lounge' | 'beach' | 'sport' | 'party' | 'dinner' | 'travel' | 'work' | 'study';
export type DaypartContext = 'day' | 'night' | 'bedtime';
export type RequirementMode = 'none' | 'optional' | 'required';
export type PaletteMode = 'unconstrained' | 'monochrome' | 'tonal' | 'colorful' | 'muted';
export type PaletteOverrideStrength = 'none' | 'soft' | 'hard';
export type ColourTemperature = 'warm' | 'cool' | 'neutral';
export type ColourLightness = 'dark' | 'mid' | 'light';
export type ColourChroma = 'neutral' | 'muted' | 'medium' | 'high';
export type RequestedForm =
  | 'top_bottom_shoes'
  | 'top_bottom'
  | 'top_shoes'
  | 'bottom_shoes'
  | 'mono_only'
  | 'mono_and_shoes'
  | 'top_only'
  | 'bottom_only'
  | 'shoes_only';

export interface EntityMeta {
  text: string;
  weight: number;
  type: EntityType;
}

export interface SportMeta {
  sport?: Sport | null;
  teams?: string[];
  isKit?: boolean;
}

export interface ConfidenceBreakdown {
  category?: number | null;
  sub?: number | null;
  gender?: number | null;
  fit?: number | null;
  vibes?: number | null;
  occasion?: number | null;
  sport?: number | null;
}

export interface IndexItem {
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
  identity_entities?: string[];
  repair_confidence?: number | null;
  variant_group_key?: string | null;
  variant_anchor_entities?: string[];
  variant_discriminators?: string[];
}

export interface SlotConstraint {
  preferred_subs: string[];
  required_keywords: string[];
  preferred_entities: string[];
  colour_hints: Colour[];
  fit_hints: Fit[];
  vibe_hints: Vibe[];
  occasion_hints: OccasionTag[];
  excluded_keywords: string[];
  excluded_subs: string[];
  excluded_entities: string[];
  excluded_colours: Colour[];
}

export interface NegativeConstraints {
  excluded_categories: CategoryMain[];
  excluded_keywords: string[];
  excluded_subs: string[];
  excluded_brands: string[];
  excluded_teams: string[];
  non_sport: boolean;
  no_logos: boolean;
}

export interface CanonicalColourProfile {
  hue: number | null;
  neutral: boolean;
  temperature: ColourTemperature;
  lightness: ColourLightness;
  chroma: ColourChroma;
}

export interface PromptIntent {
  outfit_mode: Mode;
  requested_form: RequestedForm;
  required_categories: CategoryMain[];
  optional_categories: CategoryMain[];
  target_gender: Gender | 'any';
  vibe_tags: Vibe[];
  occasion_tags: OccasionTag[];
  colour_hints: Colour[];
  brand_focus: string[];
  team_focus: string[];
  sport_context: Sport;
  fit_preference: Fit | 'mixed' | null;
  specific_items: string[];
  setting_context: SettingContext[];
  activity_context: ActivityContext[];
  daypart_context: DaypartContext[];
  persona_terms: string[];
  palette_mode: PaletteMode;
  global_palette_colours: Colour[];
  slot_palette_locked: Partial<Record<CategoryMain, boolean>>;
  palette_override_strength: PaletteOverrideStrength;
  mono_requirement: RequirementMode;
  shoe_requirement: RequirementMode;
  slot_constraints: Record<CategoryMain, SlotConstraint>;
  negative_constraints: NegativeConstraints;
}

export const SLOT_ORDER: CategoryMain[] = ['top', 'bottom', 'shoes', 'mono'];
export const ALLOWED_COLOURS = ['black', 'white', 'grey', 'red', 'blue', 'green', 'beige', 'brown', 'pink', 'orange', 'yellow', 'purple'] as const;
export const ALLOWED_VIBES = ['streetwear', 'edgy', 'minimal', 'y2k', 'techwear', 'sporty', 'preppy', 'vintage', 'chic', 'formal', 'comfy'] as const;
export const ALLOWED_OCCASIONS = ['smart_casual', 'formal', 'evening', 'lounge', 'sleepwear'] as const;

export const REQUESTED_FORM_TO_CATEGORIES: Record<RequestedForm, { required: CategoryMain[]; optional: CategoryMain[] }> = {
  top_bottom_shoes: { required: ['top', 'bottom', 'shoes'], optional: [] },
  top_bottom: { required: ['top', 'bottom'], optional: [] },
  top_shoes: { required: ['top', 'shoes'], optional: [] },
  bottom_shoes: { required: ['bottom', 'shoes'], optional: [] },
  mono_only: { required: ['mono'], optional: [] },
  mono_and_shoes: { required: ['mono', 'shoes'], optional: [] },
  top_only: { required: ['top'], optional: [] },
  bottom_only: { required: ['bottom'], optional: [] },
  shoes_only: { required: ['shoes'], optional: [] },
};

export const FORMAL_TOP_SUBS = new Set(['blazer', 'suit jacket', 'tuxedo jacket', 'dress shirt', 'oxford shirt', 'waistcoat']);
export const FORMAL_BOTTOM_SUBS = new Set(['tailored trousers', 'dress pants', 'trousers']);
export const FORMAL_SHOE_SUBS = new Set(['formal shoes', 'loafers', 'oxford/derby', 'heels', 'pumps', 'stilettos', 'kitten heels', 'slingbacks', 'mary jane']);
export const SMART_CASUAL_SHOE_SUBS = new Set(['loafers', 'oxford/derby', 'formal shoes', 'boat shoes']);
export const HEEL_FAMILY_SUBS = new Set(['heels', 'pumps', 'stilettos', 'kitten heels', 'slingbacks', 'mary jane']);
export const LOUNGE_TOP_SUBS = new Set(['pajama top', 'robe', 'hoodie', 'sweatshirt', 'sweater']);
export const LOUNGE_BOTTOM_SUBS = new Set(['pajama pants', 'lounge pants', 'sleep shorts', 'joggers']);
export const LOUNGE_SHOE_SUBS = new Set(['slippers', 'sandals/slides']);
export const SLEEPWEAR_MONO_SUBS = new Set(['nightgown']);
export const ACCESSORY_SUBS = new Set(['accessory']);
export const NEUTRAL_COLOURS = new Set<Colour>(['black', 'white', 'grey', 'beige', 'brown']);
export const CANONICAL_COLOUR_PROFILES: Record<Colour, CanonicalColourProfile> = {
  black: { hue: null, neutral: true, temperature: 'neutral', lightness: 'dark', chroma: 'neutral' },
  white: { hue: null, neutral: true, temperature: 'neutral', lightness: 'light', chroma: 'neutral' },
  grey: { hue: null, neutral: true, temperature: 'neutral', lightness: 'mid', chroma: 'neutral' },
  beige: { hue: 42, neutral: true, temperature: 'warm', lightness: 'light', chroma: 'muted' },
  brown: { hue: 28, neutral: true, temperature: 'warm', lightness: 'dark', chroma: 'muted' },
  red: { hue: 0, neutral: false, temperature: 'warm', lightness: 'mid', chroma: 'high' },
  orange: { hue: 30, neutral: false, temperature: 'warm', lightness: 'mid', chroma: 'high' },
  yellow: { hue: 58, neutral: false, temperature: 'warm', lightness: 'light', chroma: 'high' },
  green: { hue: 120, neutral: false, temperature: 'cool', lightness: 'mid', chroma: 'medium' },
  blue: { hue: 220, neutral: false, temperature: 'cool', lightness: 'mid', chroma: 'medium' },
  purple: { hue: 280, neutral: false, temperature: 'cool', lightness: 'mid', chroma: 'medium' },
  pink: { hue: 332, neutral: false, temperature: 'warm', lightness: 'light', chroma: 'medium' },
};

export function normalizeForTokens(value: string): string {
  let t = rmDiacritics(String(value || '').toLowerCase().trim());
  t = t.replace(/[-_]/g, ' ');
  t = t.replace(/\boxford\/derby\b/g, ' oxfordderby ');
  t = t.replace(/\bsandals\/slides\b/g, ' sandalsslides ');
  t = t.replace(/\bflip flops?\b/g, ' sandalsslides ');
  t = t.replace(/\bslides?\b/g, ' sandalsslides ');
  t = t.replace(/\bsandals?\b/g, ' sandalsslides ');
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
  t = t.replace(/\boxford shoes?\b/g, 'oxford/derby');
  t = t.replace(/\bderby shoes?\b/g, 'oxford/derby');
  t = t.replace(/\bboat shoes?\b/g, 'boat shoes');
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
  t = t.replace(/\bdinner date\b/g, 'date night');
  t = t.replace(/\bsmart casual\b/g, 'smart casual');
  t = t.replace(/\bsmart causal\b/g, 'smart casual');
  t = t.replace(/\bbusiness casual\b/g, 'smart casual');
  t = t.replace(/\boxfordderby\b/g, 'oxford/derby');
  t = t.replace(/\bsandalsslides\b/g, 'sandals/slides');
  return t.replace(/\s+/g, ' ').trim();
}

export function normalizeText(value: string | null | undefined): string {
  return normalizeForTokens(String(value || ''))
    .replace(/[^a-z0-9\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasWholeWord(haystack: string, needle: string): boolean {
  return new RegExp(`\\b${escapeRegExp(normalizeText(needle))}\\b`, 'i').test(normalizeText(haystack));
}

export function toColour(value: string | null | undefined): Colour | null {
  const norm = normalizeText(value);
  if (!norm) return null;
  if ((ALLOWED_COLOURS as readonly string[]).includes(norm as Colour)) return norm as Colour;
  if (/\b(navy|indigo|azure|cobalt|sky)\b/.test(norm)) return 'blue';
  if (/\b(cream|ecru|ivory|off white|offwhite|bone|oat|sand|khaki|camel|tan)\b/.test(norm)) return 'beige';
  if (/\b(maroon|burgundy|crimson|scarlet|wine)\b/.test(norm)) return 'red';
  if (/\b(chartreuse|lime|olive|forest|emerald|sage|mint)\b/.test(norm)) return 'green';
  if (/\b(fuchsia|magenta|rose|blush|salmon|coral)\b/.test(norm)) return 'pink';
  if (/\b(orange|tangerine|apricot|burnt orange|rust)\b/.test(norm)) return 'orange';
  if (/\b(gold|mustard|amber|lemon|sunflower)\b/.test(norm)) return 'yellow';
  if (/\b(violet|lilac|lavender|plum|mauve)\b/.test(norm)) return 'purple';
  if (/\b(charcoal|graphite|slate)\b/.test(norm)) return 'grey';
  if (/\b(chocolate|espresso|coffee|walnut|mahogany|taupe)\b/.test(norm)) return 'brown';
  return null;
}

export function normalizeVibes(values: Array<string | null | undefined>): Vibe[] {
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

export function normalizeOccasionTags(values: Array<string | null | undefined>): OccasionTag[] {
  const out: OccasionTag[] = [];
  const fallback: Record<string, OccasionTag[]> = {
    'date night': ['evening'],
    'dinner date': ['evening'],
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

export function toFit(value: string | null | undefined): Fit | null {
  const norm = normalizeText(value);
  return ['oversized', 'regular', 'slim', 'cropped'].includes(norm) ? (norm as Fit) : null;
}

export function toSport(value: string | null | undefined): Sport | null {
  const norm = normalizeText(value);
  if (!norm) return null;
  if (norm === 'soccer') return 'football';
  if (norm === 'workout' || norm === 'training') return 'gym';
  if (/^[a-z0-9]+(?:\/[a-z0-9]+)?$/.test(norm)) return norm;
  return null;
}

export function inferSportFromText(value: string | null | undefined): Sport | null {
  const norm = normalizeText(value);
  if (!norm) return null;
  const direct = toSport(norm);
  if (direct && !['sport', 'sportswear', 'athletic'].includes(direct)) return direct;
  const explicit = norm.match(/\b(cycling|cricket|rugby|golf|hockey|baseball|volleyball|boxing|mma|ski|snowboard|skate|motorsport|f1|ufc|lacrosse|handball|padel|pickleball)\b/);
  if (explicit) return explicit[1];
  const ball = norm.match(/\b([a-z]+ball)\b/);
  if (ball) return ball[1];
  if (/\bsport|sportswear|athletic\b/.test(norm)) return 'sport';
  return null;
}

export function toCategory(value: string | null | undefined): CategoryMain | null {
  const norm = normalizeText(value);
  return ['top', 'bottom', 'shoes', 'mono'].includes(norm) ? (norm as CategoryMain) : null;
}

export function categoriesForForm(form: RequestedForm): { required: CategoryMain[]; optional: CategoryMain[] } {
  return REQUESTED_FORM_TO_CATEGORIES[form];
}

export function deriveRequestedForm(requiredCategories: CategoryMain[], optionalCategories: CategoryMain[] = []): RequestedForm {
  const required = uniq(requiredCategories).sort().join('|');
  const optional = uniq(optionalCategories);
  if (required === 'bottom|shoes') return 'bottom_shoes';
  if (required === 'bottom') return 'bottom_only';
  if (required === 'mono') return optional.includes('shoes') ? 'mono_and_shoes' : 'mono_only';
  if (required === 'mono|shoes') return 'mono_and_shoes';
  if (required === 'shoes') return 'shoes_only';
  if (required === 'top') return 'top_only';
  if (required === 'bottom|top') return optional.includes('shoes') ? 'top_bottom_shoes' : 'top_bottom';
  if (required === 'bottom|shoes|top') return 'top_bottom_shoes';
  if (required === 'shoes|top') return 'top_shoes';
  return 'top_bottom_shoes';
}

export function emptySlotConstraint(): SlotConstraint {
  return {
    preferred_subs: [],
    required_keywords: [],
    preferred_entities: [],
    colour_hints: [],
    fit_hints: [],
    vibe_hints: [],
    occasion_hints: [],
    excluded_keywords: [],
    excluded_subs: [],
    excluded_entities: [],
    excluded_colours: [],
  };
}

export function emptyPromptIntent(): PromptIntent {
  return {
    outfit_mode: 'outfit',
    requested_form: 'top_bottom_shoes',
    required_categories: ['top', 'bottom', 'shoes'],
    optional_categories: [],
    target_gender: 'any',
    vibe_tags: [],
    occasion_tags: [],
    colour_hints: [],
    brand_focus: [],
    team_focus: [],
    sport_context: 'none',
    fit_preference: null,
    specific_items: [],
    setting_context: [],
    activity_context: [],
    daypart_context: [],
    persona_terms: [],
    palette_mode: 'unconstrained',
    global_palette_colours: [],
    slot_palette_locked: {},
    palette_override_strength: 'none',
    mono_requirement: 'none',
    shoe_requirement: 'required',
    slot_constraints: {
      top: emptySlotConstraint(),
      bottom: emptySlotConstraint(),
      shoes: emptySlotConstraint(),
      mono: emptySlotConstraint(),
    },
    negative_constraints: {
      excluded_categories: [],
      excluded_keywords: [],
      excluded_subs: [],
      excluded_brands: [],
      excluded_teams: [],
      non_sport: false,
      no_logos: false,
    },
  };
}

export function canonicalizeSubtype(value: string | null | undefined): string {
  const norm = normalizeText(value);
  if (!norm) return '';
  const mappings: Array<[RegExp, string]> = [
    [/\bsuit\b/g, 'suit'],
    [/\bblazer\b/g, 'blazer'],
    [/\bpuffer\b/g, 'puffer jacket'],
    [/\bparka\b/g, 'parka'],
    [/\bleather jacket\b/g, 'leather jacket'],
    [/\bbomber\b/g, 'bomber jacket'],
    [/\bcardigan\b/g, 'cardigan'],
    [/\bcoat\b/g, 'coat'],
    [/\bjacket\b/g, 'jacket'],
    [/\bsuit jacket\b/g, 'suit jacket'],
    [/\btuxedo\b/g, 'tuxedo jacket'],
    [/\bwaistcoat\b/g, 'waistcoat'],
    [/\bdress shirt\b/g, 'dress shirt'],
    [/\boxford shirt\b/g, 'oxford shirt'],
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
    [/\bboat shoes?\b/g, 'boat shoes'],
    [/\bheels\b/g, 'heels'],
    [/\bpumps\b/g, 'pumps'],
    [/\bstilettos\b/g, 'stilettos'],
    [/\bkitten heels\b/g, 'kitten heels'],
    [/\bslingbacks\b/g, 'slingbacks'],
    [/\bflip flops?\b/g, 'sandals/slides'],
    [/\bslides?\b/g, 'sandals/slides'],
    [/\bsandals?\b/g, 'sandals/slides'],
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

export function subtypeFamily(value: string | null | undefined): string[] {
  const sub = canonicalizeSubtype(value);
  if (!sub) return [];
  const out = new Set<string>([sub]);
  if (FORMAL_TOP_SUBS.has(sub) || FORMAL_BOTTOM_SUBS.has(sub) || FORMAL_SHOE_SUBS.has(sub)) out.add('formalwear');
  if (HEEL_FAMILY_SUBS.has(sub)) out.add('heel_family');
  if (LOUNGE_TOP_SUBS.has(sub) || LOUNGE_BOTTOM_SUBS.has(sub) || LOUNGE_SHOE_SUBS.has(sub)) out.add('loungewear');
  if (SLEEPWEAR_MONO_SUBS.has(sub) || sub.includes('pajama')) out.add('sleepwear');
  if (SMART_CASUAL_SHOE_SUBS.has(sub)) out.add('smart_casual_shoe');
  if (sub === 'sandals/slides' || sub === 'slippers') out.add('open_casual_shoe');
  if (sub.includes('jeans')) out.add('denim');
  if (sub.includes('shirt')) out.add('shirt_family');
  if (sub.includes('sneaker')) out.add('sneaker_family');
  if (sub.includes('boot')) out.add('boot_family');
  if (
    sub === 'jacket' ||
    sub === 'puffer jacket' ||
    sub === 'leather jacket' ||
    sub === 'parka' ||
    sub === 'bomber jacket' ||
    sub === 'coat'
  ) {
    out.add('outerwear_family');
  }
  if (
    sub === 'hoodie' ||
    sub === 'sweater' ||
    sub === 'cardigan' ||
    sub === 'blazer' ||
    sub === 'suit jacket' ||
    sub === 'tuxedo jacket' ||
    sub === 'waistcoat' ||
    sub === 'robe' ||
    sub === 'knit/sweat'
  ) {
    out.add('top_layer');
  }
  if (sub === 'hoodie' || sub === 'sweater' || sub === 'cardigan' || sub === 'knit/sweat') {
    out.add('soft_top_layer');
  }
  return Array.from(out);
}

export function expandEntityAliases(raw: string): string[] {
  const base = normalizeText(raw);
  if (!base) return [];
  const tokens = base.split(' ').filter(Boolean);
  const acr = acronym(base);
  const out = new Set<string>([base, ...tokens]);
  if (acr.length >= 3) out.add(acr);
  if (tokens.length >= 2) out.add(tokens.join(''));
  return Array.from(out);
}

export function joinedAliasText(values: string[]): string {
  const out = new Set<string>();
  for (const value of values) {
    for (const alias of expandEntityAliases(value)) out.add(alias);
  }
  return Array.from(out).join(' ');
}

export function inferOccasionFromTextParts(parts: string[]): OccasionTag[] {
  const text = normalizeText(parts.join(' '));
  const out = new Set<OccasionTag>();
  if (!text) return [];
  if (/\b(formal|black tie|tuxedo|suit|blazer|dress shirt|tailored trousers|dress pants|oxford\/derby|loafer|heels|pumps|stilettos|slingbacks|cocktail dress|evening dress|gown)\b/.test(text)) out.add('formal');
  if (/\b(date night|evening|cocktail dress|evening dress|gown|heels|pumps|stilettos)\b/.test(text)) out.add('evening');
  if (/\b(preppy|ivy|collegiate|college|varsity|polo|oxford shirt|smart casual|business casual|boat shoes?)\b/.test(text)) out.add('smart_casual');
  if (/\b(loungewear|lounge|robe|slippers|cozy|comfy)\b/.test(text)) out.add('lounge');
  if (/\b(pajama|sleepwear|nightwear|nightgown|sleep shorts)\b/.test(text)) out.add('sleepwear');
  return Array.from(out);
}

export function inferItemOccasionTags(item: Partial<IndexItem>): OccasionTag[] {
  const explicit = normalizeOccasionTags(item.occasion_tags || []);
  if (explicit.length) return explicit;
  return inferOccasionFromTextParts([
    item.sub || '',
    item.name || '',
    item.name_normalized || '',
    ...(item.identity_entities || []),
    ...(item.vibes || []),
    ...((item.entityMeta || [])
      .filter((entity) => entity.type === 'brand' || entity.type === 'team' || entity.type === 'sponsor')
      .map((entity) => entity.text)),
  ]);
}

export function isFormalSubtype(value: string | null | undefined): boolean {
  const sub = canonicalizeSubtype(value);
  return !!sub && (FORMAL_TOP_SUBS.has(sub) || FORMAL_BOTTOM_SUBS.has(sub) || FORMAL_SHOE_SUBS.has(sub));
}

export function isHeelFamilySubtype(value: string | null | undefined): boolean {
  return HEEL_FAMILY_SUBS.has(canonicalizeSubtype(value));
}

export function isLoungeSubtype(value: string | null | undefined): boolean {
  const sub = canonicalizeSubtype(value);
  return !!sub && (LOUNGE_TOP_SUBS.has(sub) || LOUNGE_BOTTOM_SUBS.has(sub) || LOUNGE_SHOE_SUBS.has(sub));
}

export function isSmartCasualShoeSubtype(value: string | null | undefined): boolean {
  return SMART_CASUAL_SHOE_SUBS.has(canonicalizeSubtype(value));
}

export function isOpenCasualShoeSubtype(value: string | null | undefined): boolean {
  const sub = canonicalizeSubtype(value);
  return sub === 'sandals/slides' || sub === 'slippers';
}

export function isAthleticShoeSubtype(value: string | null | undefined): boolean {
  return canonicalizeSubtype(value) === 'sneakers';
}

export function isSleepwearSubtype(value: string | null | undefined): boolean {
  const sub = canonicalizeSubtype(value);
  return !!sub && (SLEEPWEAR_MONO_SUBS.has(sub) || sub.includes('pajama'));
}

export function looksLikeAccessory(value: string | null | undefined): boolean {
  return ACCESSORY_SUBS.has(canonicalizeSubtype(value));
}

export function normalizeKeywordList(values: Array<string | null | undefined>): string[] {
  return uniq((values || []).map((value) => normalizeText(value)).filter(Boolean));
}

export function normalizeContextList<T extends string>(values: Array<string | null | undefined>, allowed: readonly T[]): T[] {
  const allowedSet = new Set<string>(allowed);
  return uniq((values || [])
    .map((value) => normalizeText(value))
    .filter((value): value is T => !!value && allowedSet.has(value)));
}

export function uniqueColours(values: Array<string | Colour | null | undefined>): Colour[] {
  return uniq((values || []).map((value) => toColour(String(value || ''))).filter((value): value is Colour => !!value));
}

export function uniqueFits(values: Array<string | Fit | null | undefined>): Fit[] {
  return uniq((values || []).map((value) => toFit(String(value || ''))).filter((value): value is Fit => !!value));
}

export function colourProfile(value: Colour | null | undefined): CanonicalColourProfile | null {
  if (!value) return null;
  return CANONICAL_COLOUR_PROFILES[value] || null;
}

export function isNeutralColour(value: Colour | null | undefined): boolean {
  return !!value && NEUTRAL_COLOURS.has(value);
}
