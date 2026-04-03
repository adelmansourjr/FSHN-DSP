import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type GenderPref = 'any' | 'men' | 'women';
type Surface = 'internal' | 'route';
type ParserMode = 'heuristic' | 'auto';
type EmbeddingMode = 'off' | 'hybrid';

type PromptCase = {
  id: string;
  prompt: string;
  genderPref: GenderPref;
  selectionForm: string;
  rubricId: string;
  metricFamilies: string[];
  tags?: string[];
  progressionGroup?: string;
  progressionStage?: number;
};

type ItemExpectation = {
  requiredFamiliesAny?: string[];
  forbiddenFamilies?: string[];
  requiredTermsAny?: string[];
  forbiddenTerms?: string[];
  preferredColoursAny?: string[];
};

type Rubric = {
  selectionForm: string;
  intent?: {
    requestedForm?: string;
    targetGender?: string;
    vibeTagsAny?: string[];
    occasionTagsAny?: string[];
    sportContext?: string;
    semanticSubjectKindsAny?: string[];
    styleAxesAny?: string[];
  };
  global?: {
    forbiddenTerms?: string[];
  };
  selection?: Partial<Record<'top' | 'bottom' | 'mono' | 'shoes', ItemExpectation>>;
  pools?: Partial<Record<'top' | 'bottom' | 'mono' | 'shoes', { minRelevant?: number }>>;
  negation?: {
    forbiddenTerms?: string[];
  };
  color?: {
    selectionColoursAny?: string[];
    forbiddenColours?: string[];
    slotColours?: Partial<Record<'top' | 'bottom' | 'mono' | 'shoes', string[]>>;
  };
  persona?: {
    requirePersonaIntent?: boolean;
    styleAxesAny?: string[];
    softBrandPriorsAny?: string[];
  };
  deterministic?: {
    minSemanticStability?: number;
  };
  diversity?: {
    minUniqueOutfits?: number;
    slotTargets?: Partial<Record<'top' | 'bottom' | 'mono' | 'shoes', number>>;
  };
};

type BenchmarkConfig = {
  id: string;
  surface: 'internal';
  parserMode: ParserMode;
  embeddingMode: EmbeddingMode;
};

type BenchmarkSuiteConfig = {
  internal: {
    indexPath: string;
    embeddingSidecarPath: string;
    projectEnvKeys: string[];
    location: string;
    model: string;
    embeddingModel: string;
    geminiTimeoutMs: number;
    poolSize: number;
    perRoleLimit: number;
    epsilon: number;
    jitter: number;
    seed: number | null;
    bypassParseCache: boolean;
    bypassEmbeddingCache: boolean;
    debug: boolean;
  };
  route: {
    enabled: boolean;
    url: string | null;
    poolSize: number;
    perRoleLimit: number;
    timeoutMs: number;
  };
  repeats: {
    standard: number;
    determinism: number;
    diversity: number;
  };
  bootstrapIterations: number;
  weights: Record<string, number>;
  configs: BenchmarkConfig[];
};

type NormalizedItem = {
  id: string | null;
  category: 'top' | 'bottom' | 'mono' | 'shoes' | null;
  title: string;
  gender: string | null;
  colours: string[];
  vibes: string[];
  entities: string[];
  styleMarkers: string[];
  occasionTags: string[];
  sub: string;
  formalityScore: number | null;
  streetwearScore: number | null;
  text: string;
  families: string[];
  colourFamilies: string[];
};

type NormalizedIntent = {
  requestedForm: string | null;
  targetGender: string | null;
  vibeTags: string[];
  occasionTags: string[];
  sportContext: string | null;
  semanticSubjectKinds: string[];
  styleAxes: string[];
  softBrandPriors: string[];
  personaRequired: boolean;
};

type NormalizedResponse = {
  selection: Partial<Record<'top' | 'bottom' | 'mono' | 'shoes', NormalizedItem>>;
  pools: Partial<Record<'top' | 'bottom' | 'mono' | 'shoes', NormalizedItem[]>>;
  looksCount: number;
  intent: NormalizedIntent;
  diagnostics: Record<string, any> | null;
  meta: Record<string, any> | null;
};

type RunRecord = {
  runId: string;
  surface: Surface;
  configId: string;
  caseId: string;
  prompt: string;
  genderPref: GenderPref;
  repeatIndex: number;
  success: boolean;
  error: string | null;
  latencyMs: number | null;
  parserMode: string | null;
  embeddingMode: string | null;
  selectionForm: string;
  metrics: Record<string, number | null>;
  selection: Record<string, any> | null;
  pools: Record<string, any[]> | null;
  intent: Record<string, any> | null;
  diagnostics: Record<string, any> | null;
  meta: Record<string, any> | null;
};

type CaseSummary = {
  surface: Surface;
  configId: string;
  caseId: string;
  prompt: string;
  genderPref: GenderPref;
  selectionForm: string;
  metricFamilies: string[];
  tags: string[];
  progressionGroup: string | null;
  progressionStage: number | null;
  runCount: number;
  successCount: number;
  successRate: number;
  meanLatencyMs: number | null;
  metrics: Record<string, number | null>;
  diagnostics: {
    semanticShare: number | null;
    semanticFrontierShare: number | null;
  };
};

type ProgressionSummary = {
  surface: Surface;
  configId: string;
  groupId: string;
  stages: number;
  score: number | null;
};

type SubsetSummary = {
  surface: Surface;
  configId: string;
  subsetId: string;
  caseCount: number;
  overall: number | null;
  selection: number | null;
  semantic: number | null;
  pool_quality: number | null;
  diversity: number | null;
  successRate: number | null;
  meanLatencyMs: number | null;
  semanticShare: number | null;
  semanticFrontierShare: number | null;
};

const SLOT_KEYS = ['top', 'bottom', 'mono', 'shoes'] as const;

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values || []) {
    const text = normalizeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function mean(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => Number.isFinite(value as number));
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeJsonLines(filePath: string, rows: unknown[]) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function csvEscape(value: unknown): string {
  const text = value == null ? '' : String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsv(filePath: string, rows: Record<string, unknown>[]) {
  const keys = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row))),
  );
  const lines = [
    keys.join(','),
    ...rows.map((row) => keys.map((key) => csvEscape(row[key])).join(',')),
  ];
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

function parseArgs(argv: string[]) {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

function loadDotEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function resolveSelectionSlots(form: string): Array<typeof SLOT_KEYS[number]> {
  switch (form) {
    case 'top_bottom_shoes':
      return ['top', 'bottom', 'shoes'];
    case 'top_bottom':
      return ['top', 'bottom'];
    case 'mono_shoes':
      return ['mono', 'shoes'];
    case 'top_shoes':
      return ['top', 'shoes'];
    case 'bottom_shoes':
      return ['bottom', 'shoes'];
    case 'single_top':
      return ['top'];
    case 'single_bottom':
      return ['bottom'];
    case 'single_mono':
      return ['mono'];
    case 'single_shoes':
      return ['shoes'];
    case 'top':
      return ['top'];
    case 'bottom':
      return ['bottom'];
    case 'mono':
      return ['mono'];
    case 'shoes':
      return ['shoes'];
    default:
      return [];
  }
}

function extractColourFamilies(text: string, explicit: string[]): string[] {
  const families = new Set<string>(explicit.map((entry) => normalizeText(entry)));
  const addIf = (name: string, pattern: RegExp) => {
    if (pattern.test(text)) families.add(name);
  };
  addIf('black', /\bblack\b/);
  addIf('white', /\bwhite\b/);
  addIf('gray', /\bgrey\b|\bgray\b|\bcharcoal\b/);
  addIf('brown', /\bbrown\b|\bcocoa\b|\bchocolate\b/);
  addIf('beige', /\bbeige\b|\btan\b|\bkhaki\b|\bsand\b/);
  addIf('cream', /\bcream\b|\bivory\b|\boatmeal\b/);
  addIf('navy', /\bnavy\b/);
  addIf('blue', /\bblue\b/);
  addIf('red', /\bred\b|\bburgundy\b|\bmaroon\b/);
  addIf('green', /\bgreen\b|\bolive\b/);
  addIf('pink', /\bpink\b|\bfuchsia\b/);
  addIf('purple', /\bpurple\b|\blilac\b/);
  addIf('yellow', /\byellow\b|\bgold\b/);
  addIf('orange', /\borange\b|\brust\b/);
  addIf('metallic', /\bsilver\b|\bgold\b|\bmetallic\b/);
  return Array.from(families);
}

function inferFamilies(text: string, category: string | null): string[] {
  const families = new Set<string>();
  const addIf = (name: string, pattern: RegExp) => {
    if (pattern.test(text)) families.add(name);
  };

  addIf('shirt', /\bshirt\b|\boxford\b|\bbutton down\b|\bbutton-down\b|\bblouse\b/);
  addIf('polo', /\bpolo\b/);
  addIf('knitwear', /\bknit\b|\bsweater\b|\bjumper\b|\bcashmere\b|\bpullover\b/);
  addIf('cardigan', /\bcardigan\b/);
  addIf('blazer', /\bblazer\b|\bsport coat\b/);
  addIf('jacket', /\bjacket\b|\bcoat\b|\bouterwear\b|\bovershirt\b/);
  addIf('hoodie', /\bhoodie\b|\bsweatshirt\b/);
  addIf('tee', /\bt shirt\b|\bt-shirt\b|\btshirt\b|\btee\b/);
  addIf('jersey', /\bjersey\b/);
  addIf('active_top', /\btank\b|\bsports bra\b|\btraining top\b|\brunning top\b|\bgym top\b/);

  addIf('dress', /\bdress\b|\bgown\b/);
  addIf('jumpsuit', /\bjumpsuit\b|\bromper\b|\bplaysuit\b/);

  addIf('trousers', /\btrouser\b|\bslack\b|\bwide leg\b|\bwide-leg\b|\bsuit pant\b|\bpants\b/);
  addIf('chinos', /\bchino\b/);
  addIf('jeans', /\bjean\b|\bdenim\b/);
  addIf('shorts', /\bshorts?\b/);
  addIf('skirt', /\bskirt\b/);
  addIf('leggings', /\bleggings?\b/);
  addIf('cargo', /\bcargo\b/);
  addIf('joggers', /\bjogger\b|\bsweatpant\b|\btrack pant\b/);
  addIf('active_bottom', /\bbike short\b|\btraining short\b|\brunning short\b|\bgym short\b|\btrack pant\b/);

  addIf('loafers', /\bloafer\b|\bmoccasin\b/);
  addIf('boat_shoes', /\bboat shoe\b|\bboat shoes\b/);
  addIf('derbies', /\bderby\b/);
  addIf('oxfords', /\boxford\b/);
  addIf('boots', /\bboot\b/);
  addIf('boots_refined', /\bankle boot\b|\bchelsea\b|\bderby boot\b/);
  addIf('timberland', /\btimberland\b|\btimbos?\b|\btimbs?\b/);
  addIf('sneakers', /\bsneaker\b|\btrainer\b|\bjordan\b|\b9060\b|\byeezy bred\b|\bcloudtilt\b/);
  addIf('active_shoes', /\brunning\b|\btraining\b|\bathletic\b|\bgym shoe\b|\btrainer\b/);
  addIf('cleats', /\bcleat\b|\bfootball boot\b|\bsoccer shoe\b/);
  addIf('heels', /\bheel\b|\bstiletto\b|\bslingback\b/);
  addIf('pumps', /\bpump\b/);
  addIf('sandals', /\bsandal\b|\bmule\b/);

  if (category === 'top' && !families.size) families.add('top');
  if (category === 'bottom' && !families.size) families.add('bottom');
  if (category === 'mono' && !families.size) families.add('mono');
  if (category === 'shoes' && !families.size) families.add('shoes');

  if (/\bfootball\b|\bsoccer\b|\bbasketball\b|\bgym\b|\brunning\b/.test(text)) {
    if (category === 'top') families.add('active_top');
    if (category === 'bottom') families.add('active_bottom');
    if (category === 'shoes') families.add('active_shoes');
  }

  return Array.from(families);
}

function normalizeItem(raw: any, fallbackCategory: typeof SLOT_KEYS[number] | null = null): NormalizedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : raw;
  const category = normalizeText(raw.category || meta.category || fallbackCategory || '') as NormalizedItem['category'];
  const title = String(meta.title || meta.name || raw.name || raw.title || '').trim();
  const sub = String(meta.sub || raw.sub || '').trim();
  const colours = uniqueStrings([...(Array.isArray(meta.colours) ? meta.colours : Array.isArray(raw.colours) ? raw.colours : [])]);
  const vibes = uniqueStrings([...(Array.isArray(meta.vibes) ? meta.vibes : Array.isArray(raw.vibes) ? raw.vibes : [])]);
  const entities = uniqueStrings([
    ...(Array.isArray(meta.entities) ? meta.entities : Array.isArray(raw.entities) ? raw.entities : []),
    ...((Array.isArray(meta.entityMeta) ? meta.entityMeta : Array.isArray(raw.entityMeta) ? raw.entityMeta : []).map((entry: any) => entry?.text || '')),
  ]);
  const styleMarkers = uniqueStrings([...(Array.isArray(meta.style_markers) ? meta.style_markers : Array.isArray(raw.style_markers) ? raw.style_markers : [])]);
  const occasionTags = uniqueStrings([...(Array.isArray(meta.occasion_tags) ? meta.occasion_tags : Array.isArray(raw.occasion_tags) ? raw.occasion_tags : [])]);
  const text = normalizeText([
    title,
    sub,
    category || '',
    ...colours,
    ...vibes,
    ...entities,
    ...styleMarkers,
    ...occasionTags,
  ].join(' '));
  return {
    id: raw.id || meta.id || null,
    category: category && SLOT_KEYS.includes(category as any) ? (category as any) : fallbackCategory,
    title,
    gender: meta.gender || raw.gender || null,
    colours,
    vibes,
    entities,
    styleMarkers,
    occasionTags,
    sub,
    formalityScore: Number.isFinite(Number(meta.formality_score ?? raw.formality_score)) ? Number(meta.formality_score ?? raw.formality_score) : null,
    streetwearScore: Number.isFinite(Number(meta.streetwear_score ?? raw.streetwear_score)) ? Number(meta.streetwear_score ?? raw.streetwear_score) : null,
    text,
    families: inferFamilies(text, category || fallbackCategory),
    colourFamilies: extractColourFamilies(text, colours),
  };
}

function normalizeIntent(intent: any): NormalizedIntent {
  const semanticSubjects = Array.isArray(intent?.semantic_subjects) ? intent.semantic_subjects : [];
  const personaProfile = intent?.persona_profile && typeof intent.persona_profile === 'object' ? intent.persona_profile : null;
  return {
    requestedForm: normalizeText(intent?.requested_form || '') || null,
    targetGender: normalizeText(intent?.target_gender || intent?.targetGender || '') || null,
    vibeTags: uniqueStrings(Array.isArray(intent?.vibe_tags) ? intent.vibe_tags : []),
    occasionTags: uniqueStrings(Array.isArray(intent?.occasion_tags) ? intent.occasion_tags : []),
    sportContext: normalizeText(intent?.sport_context || '') || null,
    semanticSubjectKinds: uniqueStrings(semanticSubjects.map((subject: any) => subject?.kind || '')),
    styleAxes: uniqueStrings([
      ...(personaProfile?.style_axes || []),
      ...semanticSubjects.flatMap((subject: any) => Array.isArray(subject?.style_axes) ? subject.style_axes : []),
      ...((intent?.semantic_directives?.style_axes && Array.isArray(intent.semantic_directives.style_axes)) ? intent.semantic_directives.style_axes : []),
    ]),
    softBrandPriors: uniqueStrings([
      ...(personaProfile?.soft_brand_priors || []),
      ...semanticSubjects.flatMap((subject: any) => Array.isArray(subject?.soft_brand_priors) ? subject.soft_brand_priors : []),
    ]),
    personaRequired: !!personaProfile || semanticSubjects.some((subject: any) => normalizeText(subject?.kind || '') === 'persona'),
  };
}

function normalizeInternalResponse(response: any): NormalizedResponse {
  const looks = Array.isArray(response?.looks) ? response.looks : [];
  const firstLook = looks[0]?.outfit || looks[0] || {};
  const selection = Object.fromEntries(
    SLOT_KEYS
      .map((slot) => [slot, normalizeItem(firstLook?.[slot], slot)])
      .filter(([, item]) => !!item),
  ) as NormalizedResponse['selection'];
  const pools = Object.fromEntries(
    SLOT_KEYS.map((slot) => [
      slot,
      Array.isArray(response?.slot_pools?.[slot])
        ? response.slot_pools[slot].map((item: any) => normalizeItem(item, slot)).filter(Boolean)
        : [],
    ]),
  ) as NormalizedResponse['pools'];
  return {
    selection,
    pools,
    looksCount: looks.length,
    intent: normalizeIntent(response?.intent || {}),
    diagnostics: response?.diagnostics || null,
    meta: null,
  };
}

function normalizeRouteResponse(response: any): NormalizedResponse {
  const selection = Object.fromEntries(
    SLOT_KEYS
      .map((slot) => [slot, normalizeItem(response?.selection?.[slot], slot)])
      .filter(([, item]) => !!item),
  ) as NormalizedResponse['selection'];
  const pools = Object.fromEntries(
    SLOT_KEYS.map((slot) => {
      const direct = Array.isArray(response?.[slot]) ? response[slot] : [];
      return [slot, direct.map((item: any) => normalizeItem(item, slot)).filter(Boolean)];
    }),
  ) as NormalizedResponse['pools'];
  return {
    selection,
    pools,
    looksCount: Array.isArray(response?.looks) ? response.looks.length : Array.isArray(response?.outfits) ? response.outfits.length : 0,
    intent: normalizeIntent(response?.intent || {}),
    diagnostics: response?.diagnostics || null,
    meta: response?.meta || null,
  };
}

function genderConflictPenalty(item: NormalizedItem | null, targetGender: string | undefined): number {
  if (!item || !targetGender) return 1;
  const itemGender = normalizeText(item.gender || '');
  const target = normalizeText(targetGender);
  if (!itemGender || itemGender === 'unisex' || itemGender === 'any') return 1;
  if (itemGender === target) return 1;
  return 0;
}

function scoreItemExpectation(item: NormalizedItem | null, expectation: ItemExpectation | undefined, targetGender?: string): number | null {
  if (!expectation) return item ? 1 : null;
  if (!item) return 0;
  const families = new Set(item.families);
  const colourFamilies = new Set(item.colourFamilies);
  const text = item.text;
  const checks: number[] = [];
  if (expectation.requiredFamiliesAny?.length) {
    checks.push(expectation.requiredFamiliesAny.some((family) => families.has(normalizeText(family))) ? 1 : 0);
  }
  if (expectation.forbiddenFamilies?.length) {
    checks.push(expectation.forbiddenFamilies.some((family) => families.has(normalizeText(family))) ? 0 : 1);
  }
  if (expectation.requiredTermsAny?.length) {
    checks.push(expectation.requiredTermsAny.some((term) => text.includes(normalizeText(term))) ? 1 : 0);
  }
  if (expectation.forbiddenTerms?.length) {
    checks.push(expectation.forbiddenTerms.some((term) => text.includes(normalizeText(term))) ? 0 : 1);
  }
  if (expectation.preferredColoursAny?.length) {
    checks.push(expectation.preferredColoursAny.some((colour) => colourFamilies.has(normalizeText(colour))) ? 1 : 0.4);
  }
  checks.push(genderConflictPenalty(item, targetGender));
  return mean(checks) ?? 0;
}

function scoreSelectionMetric(selection: NormalizedResponse['selection'], rubric: Rubric): number | null {
  const expectedSlots = resolveSelectionSlots(rubric.selectionForm);
  if (!expectedSlots.length) return null;
  const presentSlots = SLOT_KEYS.filter((slot) => !!selection[slot]);
  const requiredPresent = expectedSlots.filter((slot) => !!selection[slot]).length;
  const unexpected = presentSlots.filter((slot) => !expectedSlots.includes(slot)).length;
  const formScoreBase = expectedSlots.length ? requiredPresent / expectedSlots.length : 1;
  const formScore = clamp01(formScoreBase - unexpected * 0.2);
  const slotScores = expectedSlots.map((slot) => scoreItemExpectation(selection[slot] || null, rubric.selection?.[slot], rubric.intent?.targetGender));
  const slotScore = mean(slotScores) ?? 0;
  return clamp01(formScore * 0.35 + slotScore * 0.65);
}

function scoreIntentMetric(intent: NormalizedIntent, rubric: Rubric): number | null {
  if (!rubric.intent) return null;
  const checks: number[] = [];
  if (rubric.intent.requestedForm) {
    checks.push(intent.requestedForm === normalizeText(rubric.intent.requestedForm) ? 1 : 0);
  }
  if (rubric.intent.targetGender) {
    checks.push(intent.targetGender === normalizeText(rubric.intent.targetGender) ? 1 : 0);
  }
  if (rubric.intent.vibeTagsAny?.length) {
    checks.push(rubric.intent.vibeTagsAny.some((tag) => intent.vibeTags.includes(normalizeText(tag))) ? 1 : 0);
  }
  if (rubric.intent.occasionTagsAny?.length) {
    checks.push(rubric.intent.occasionTagsAny.some((tag) => intent.occasionTags.includes(normalizeText(tag))) ? 1 : 0);
  }
  if (rubric.intent.sportContext) {
    checks.push(intent.sportContext === normalizeText(rubric.intent.sportContext) ? 1 : 0);
  }
  if (rubric.intent.semanticSubjectKindsAny?.length) {
    checks.push(rubric.intent.semanticSubjectKindsAny.some((kind) => intent.semanticSubjectKinds.includes(normalizeText(kind))) ? 1 : 0);
  }
  if (rubric.intent.styleAxesAny?.length) {
    checks.push(rubric.intent.styleAxesAny.some((axis) => intent.styleAxes.includes(normalizeText(axis))) ? 1 : 0);
  }
  return mean(checks) ?? null;
}

function scoreNegationMetric(response: NormalizedResponse, rubric: Rubric): number | null {
  const forbiddenTerms = uniqueStrings([
    ...(rubric.global?.forbiddenTerms || []),
    ...(rubric.negation?.forbiddenTerms || []),
  ]);
  if (!forbiddenTerms.length) return null;
  const terms = forbiddenTerms.map((term) => normalizeText(term));
  const selectionItems = SLOT_KEYS.map((slot) => response.selection[slot]).filter(Boolean) as NormalizedItem[];
  const selectionSafe = selectionItems.every((item) => !terms.some((term) => item.text.includes(term)));
  const poolSafe = SLOT_KEYS.every((slot) => (response.pools[slot] || []).every((item) => !terms.some((term) => item.text.includes(term))));
  return (selectionSafe ? 0.7 : 0) + (poolSafe ? 0.3 : 0);
}

function scoreColorMetric(response: NormalizedResponse, rubric: Rubric): number | null {
  if (!rubric.color) return null;
  const scores: number[] = [];
  if (rubric.color.selectionColoursAny?.length) {
    const desired = new Set(rubric.color.selectionColoursAny.map((entry) => normalizeText(entry)));
    const selectionColours = new Set(
      SLOT_KEYS.flatMap((slot) => response.selection[slot]?.colourFamilies || []),
    );
    scores.push(Array.from(selectionColours).some((entry) => desired.has(entry)) ? 1 : 0);
  }
  if (rubric.color.forbiddenColours?.length) {
    const forbidden = new Set(rubric.color.forbiddenColours.map((entry) => normalizeText(entry)));
    const selectionColours = new Set(
      SLOT_KEYS.flatMap((slot) => response.selection[slot]?.colourFamilies || []),
    );
    scores.push(Array.from(selectionColours).some((entry) => forbidden.has(entry)) ? 0 : 1);
  }
  if (rubric.color.slotColours) {
    for (const slot of Object.keys(rubric.color.slotColours) as Array<typeof SLOT_KEYS[number]>) {
      const item = response.selection[slot];
      const desired = rubric.color.slotColours[slot];
      if (!desired?.length) continue;
      scores.push(item ? desired.some((entry) => item.colourFamilies.includes(normalizeText(entry))) ? 1 : 0 : 0);
    }
  }
  return mean(scores) ?? null;
}

function scorePersonaMetric(response: NormalizedResponse, rubric: Rubric): number | null {
  if (!rubric.persona) return null;
  const checks: number[] = [];
  if (rubric.persona.requirePersonaIntent) {
    checks.push(response.intent.personaRequired ? 1 : 0);
  }
  if (rubric.persona.styleAxesAny?.length) {
    checks.push(rubric.persona.styleAxesAny.some((axis) => response.intent.styleAxes.includes(normalizeText(axis))) ? 1 : 0);
  }
  if (rubric.persona.softBrandPriorsAny?.length) {
    checks.push(rubric.persona.softBrandPriorsAny.some((brand) => response.intent.softBrandPriors.includes(normalizeText(brand))) ? 1 : 0.4);
  }
  return mean(checks) ?? null;
}

function scorePoolQualityMetric(response: NormalizedResponse, rubric: Rubric): number | null {
  if (!rubric.pools) return null;
  const scores: number[] = [];
  for (const slot of Object.keys(rubric.pools) as Array<typeof SLOT_KEYS[number]>) {
    const expectation = rubric.selection?.[slot];
    const pool = response.pools[slot] || [];
    const itemScores = pool.map((item) => scoreItemExpectation(item, expectation, rubric.intent?.targetGender) ?? 0);
    const relevant = itemScores.filter((score) => score >= 0.7).length;
    const minRelevant = rubric.pools?.[slot]?.minRelevant ?? 1;
    const topK = itemScores.slice(0, Math.min(itemScores.length, Math.max(3, minRelevant)));
    const topKMean = topK.length ? mean(topK) ?? 0 : 0;
    const coverage = clamp01(relevant / Math.max(1, minRelevant));
    scores.push(clamp01(topKMean * 0.65 + coverage * 0.35));
  }
  return mean(scores) ?? null;
}

function buildRunMetrics(response: NormalizedResponse, rubric: Rubric): Record<string, number | null> {
  return {
    selection: scoreSelectionMetric(response.selection, rubric),
    semantic: mean([
      scoreIntentMetric(response.intent, rubric),
      scoreSelectionMetric(response.selection, rubric),
    ]),
    negation: scoreNegationMetric(response, rubric),
    color: scoreColorMetric(response, rubric),
    persona: scorePersonaMetric(response, rubric),
    pool_quality: scorePoolQualityMetric(response, rubric),
    deterministic: null,
    diversity: null,
    progression: null,
    overall: null,
  };
}

function selectionFingerprint(selection: NormalizedResponse['selection']): string {
  return SLOT_KEYS.map((slot) => selection[slot]?.id || '').join('|');
}

function selectionSemanticSignature(selection: NormalizedResponse['selection']): string {
  return SLOT_KEYS.map((slot) => `${slot}:${(selection[slot]?.families || []).sort().join('+')}:${(selection[slot]?.colourFamilies || []).sort().join('+')}`).join('|');
}

function selectionSimilarity(left: NormalizedResponse['selection'], right: NormalizedResponse['selection']): number {
  const slotScores = SLOT_KEYS.map((slot) => {
    const a = left[slot];
    const b = right[slot];
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    return (
      jaccard(a.families, b.families) * 0.6 +
      jaccard(a.colourFamilies, b.colourFamilies) * 0.2 +
      (a.category === b.category ? 0.2 : 0)
    );
  });
  return mean(slotScores) ?? 0;
}

function deriveCaseDeterminism(records: RunRecord[], rubric: Rubric): number | null {
  if (!rubric.deterministic) return null;
  const successful = records.filter((record) => record.success && record.selection);
  if (successful.length < 2) return 0;
  const similarities: number[] = [];
  for (let i = 0; i < successful.length; i += 1) {
    for (let j = i + 1; j < successful.length; j += 1) {
      similarities.push(selectionSimilarity(
        successful[i]!.selection as any,
        successful[j]!.selection as any,
      ));
    }
  }
  const actual = mean(similarities) ?? 0;
  const target = rubric.deterministic.minSemanticStability || 1;
  return clamp01(actual / Math.max(target, 0.0001));
}

function deriveCaseDiversity(records: RunRecord[], rubric: Rubric): number | null {
  if (!rubric.diversity) return null;
  const successful = records.filter((record) => record.success && record.selection);
  if (!successful.length) return 0;
  const uniqueOutfits = new Set(successful.map((record) => selectionFingerprint(record.selection as any))).size;
  const uniquePerSlot = Object.fromEntries(
    SLOT_KEYS.map((slot) => [
      slot,
      new Set(successful.map((record) => ((record.selection as any)?.[slot]?.id || selectionSemanticSignature((record.selection as any) || {}))).filter(Boolean)).size,
    ]),
  ) as Record<typeof SLOT_KEYS[number], number>;
  const outfitTarget = rubric.diversity.minUniqueOutfits || 1;
  const slotTargetScores = SLOT_KEYS
    .filter((slot) => Number.isFinite(rubric.diversity?.slotTargets?.[slot]))
    .map((slot) => clamp01(uniquePerSlot[slot] / Math.max(1, rubric.diversity!.slotTargets![slot]!)));
  return mean([
    clamp01(uniqueOutfits / Math.max(1, outfitTarget)),
    mean(slotTargetScores) ?? 1,
  ]);
}

function computeCaseOverall(metrics: Record<string, number | null>, weights: Record<string, number>): number | null {
  const weighted: Array<[number, number]> = Object.entries(weights)
    .filter(([metric]) => metric !== 'progression')
    .map(([metric, weight]) => [metrics[metric] ?? null, weight] as const)
    .filter(([value]) => Number.isFinite(value as number)) as Array<[number, number]>;
  if (!weighted.length) return null;
  const totalWeight = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  if (!totalWeight) return null;
  return weighted.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;
}

function aggregateCaseSummary(records: RunRecord[], promptCase: PromptCase, rubric: Rubric, weights: Record<string, number>): CaseSummary {
  const successRecords = records.filter((record) => record.success);
  const first = records[0]!;
  const metrics = {
    selection: mean(successRecords.map((record) => record.metrics.selection)),
    semantic: mean(successRecords.map((record) => record.metrics.semantic)),
    negation: mean(successRecords.map((record) => record.metrics.negation)),
    color: mean(successRecords.map((record) => record.metrics.color)),
    persona: mean(successRecords.map((record) => record.metrics.persona)),
    pool_quality: mean(successRecords.map((record) => record.metrics.pool_quality)),
    deterministic: deriveCaseDeterminism(records, rubric),
    diversity: deriveCaseDiversity(records, rubric),
    progression: null,
    overall: null,
  } as Record<string, number | null>;
  metrics.overall = computeCaseOverall(metrics, weights);
  return {
    surface: first.surface,
    configId: first.configId,
    caseId: promptCase.id,
    prompt: promptCase.prompt,
    genderPref: promptCase.genderPref,
    selectionForm: promptCase.selectionForm,
    metricFamilies: promptCase.metricFamilies,
    tags: Array.isArray(promptCase.tags) ? promptCase.tags : [],
    progressionGroup: promptCase.progressionGroup || null,
    progressionStage: promptCase.progressionStage ?? null,
    runCount: records.length,
    successCount: successRecords.length,
    successRate: records.length ? successRecords.length / records.length : 0,
    meanLatencyMs: mean(successRecords.map((record) => record.latencyMs)),
    metrics,
    diagnostics: {
      semanticShare: mean(
        successRecords.map((record) => {
          const value = record.diagnostics?.score_attribution?.semantic_share;
          return Number.isFinite(Number(value)) ? Number(value) : null;
        }),
      ),
      semanticFrontierShare: mean(
        successRecords.map((record) => {
          const value = record.diagnostics?.score_attribution?.semantic_frontier_share;
          return Number.isFinite(Number(value)) ? Number(value) : null;
        }),
      ),
    },
  };
}

function computeProgressionSummaries(caseSummaries: CaseSummary[]): ProgressionSummary[] {
  const groups = new Map<string, CaseSummary[]>();
  for (const summary of caseSummaries) {
    if (!summary.progressionGroup) continue;
    const key = `${summary.surface}::${summary.configId}::${summary.progressionGroup}`;
    const list = groups.get(key) || [];
    list.push(summary);
    groups.set(key, list);
  }
  const results: ProgressionSummary[] = [];
  for (const [key, summaries] of groups.entries()) {
    const [surface, configId, groupId] = key.split('::');
    const ordered = summaries.slice().sort((a, b) => (a.progressionStage || 0) - (b.progressionStage || 0));
    const stageScores = ordered.map((summary) => summary.metrics.overall).filter((value): value is number => Number.isFinite(value as number));
    if (!stageScores.length) {
      results.push({ surface: surface as Surface, configId, groupId, stages: ordered.length, score: null });
      continue;
    }
    let monotonicHits = 0;
    for (let i = 1; i < stageScores.length; i += 1) {
      if (stageScores[i]! >= stageScores[i - 1]! - 0.02) monotonicHits += 1;
    }
    const monotonicScore = stageScores.length > 1 ? monotonicHits / (stageScores.length - 1) : 1;
    const gainScore = clamp01((stageScores[stageScores.length - 1]! - stageScores[0]!) / 0.35);
    const progressionScore = clamp01(((mean(stageScores) ?? 0) * 0.7) + monotonicScore * 0.2 + gainScore * 0.1);
    results.push({
      surface: surface as Surface,
      configId,
      groupId,
      stages: ordered.length,
      score: progressionScore,
    });
  }
  return results;
}

function metricMeanFromCases(caseSummaries: CaseSummary[], metric: string): number | null {
  return mean(
    caseSummaries
      .filter((summary) => metric === 'overall' || summary.metricFamilies.includes(metric) || summary.metrics[metric] != null)
      .map((summary) => summary.metrics[metric]),
  );
}

function computeConfigMetricRows(caseSummaries: CaseSummary[], progressionSummaries: ProgressionSummary[], weights: Record<string, number>) {
  const groups = new Map<string, CaseSummary[]>();
  for (const summary of caseSummaries) {
    const key = `${summary.surface}::${summary.configId}`;
    const list = groups.get(key) || [];
    list.push(summary);
    groups.set(key, list);
  }

  const progressionByConfig = new Map<string, ProgressionSummary[]>();
  for (const summary of progressionSummaries) {
    const key = `${summary.surface}::${summary.configId}`;
    const list = progressionByConfig.get(key) || [];
    list.push(summary);
    progressionByConfig.set(key, list);
  }

  const metricRows: Record<string, unknown>[] = [];
  const overallRows: Record<string, unknown>[] = [];
  for (const [key, summaries] of groups.entries()) {
    const [surface, configId] = key.split('::');
    const progressionScore = mean((progressionByConfig.get(key) || []).map((entry) => entry.score));
    const metricMeans: Record<string, number | null> = {
      selection: metricMeanFromCases(summaries, 'selection'),
      semantic: metricMeanFromCases(summaries, 'semantic'),
      negation: metricMeanFromCases(summaries, 'negation'),
      color: metricMeanFromCases(summaries, 'color'),
      persona: metricMeanFromCases(summaries, 'persona'),
      pool_quality: metricMeanFromCases(summaries, 'pool_quality'),
      deterministic: metricMeanFromCases(summaries, 'deterministic'),
      diversity: metricMeanFromCases(summaries, 'diversity'),
      progression: progressionScore,
    };
    for (const [metric, value] of Object.entries(metricMeans)) {
      metricRows.push({
        surface,
        configId,
        metric,
        mean: value,
        cases: summaries.filter((summary) => summary.metrics[metric] != null || (metric === 'progression' && summary.progressionGroup)).length,
      });
    }
    const overall = computeCaseOverall(metricMeans, weights);
    overallRows.push({
      surface,
      configId,
      overall,
      successRate: mean(summaries.map((summary) => summary.successRate)),
      meanLatencyMs: mean(summaries.map((summary) => summary.meanLatencyMs)),
      progression: progressionScore,
      semanticShare: mean(summaries.map((summary) => summary.diagnostics.semanticShare)),
      semanticFrontierShare: mean(summaries.map((summary) => summary.diagnostics.semanticFrontierShare)),
    });
  }
  return { metricRows, overallRows };
}

function summarizeSubset(caseSummaries: CaseSummary[], weights: Record<string, number>, subsetId: string): SubsetSummary[] {
  const groups = new Map<string, CaseSummary[]>();
  for (const summary of caseSummaries) {
    const include =
      subsetId === 'all'
        ? true
        : subsetId === 'embedding_sensitive'
          ? summary.tags.includes('embedding_sensitive')
          : summary.tags.includes(subsetId);
    if (!include) continue;
    const key = `${summary.surface}::${summary.configId}`;
    const list = groups.get(key) || [];
    list.push(summary);
    groups.set(key, list);
  }

  const rows: SubsetSummary[] = [];
  for (const [key, summaries] of groups.entries()) {
    const [surface, configId] = key.split('::');
    const metrics: Record<string, number | null> = {
      selection: metricMeanFromCases(summaries, 'selection'),
      semantic: metricMeanFromCases(summaries, 'semantic'),
      negation: metricMeanFromCases(summaries, 'negation'),
      color: metricMeanFromCases(summaries, 'color'),
      persona: metricMeanFromCases(summaries, 'persona'),
      pool_quality: metricMeanFromCases(summaries, 'pool_quality'),
      deterministic: metricMeanFromCases(summaries, 'deterministic'),
      diversity: metricMeanFromCases(summaries, 'diversity'),
      progression: metricMeanFromCases(summaries, 'progression'),
      overall: null,
    };
    metrics.overall = computeCaseOverall(metrics, weights);
    rows.push({
      surface: surface as Surface,
      configId,
      subsetId,
      caseCount: summaries.length,
      overall: metrics.overall,
      selection: metrics.selection,
      semantic: metrics.semantic,
      pool_quality: metrics.pool_quality,
      diversity: metrics.diversity,
      successRate: mean(summaries.map((summary) => summary.successRate)),
      meanLatencyMs: mean(summaries.map((summary) => summary.meanLatencyMs)),
      semanticShare: mean(summaries.map((summary) => summary.diagnostics.semanticShare)),
      semanticFrontierShare: mean(summaries.map((summary) => summary.diagnostics.semanticFrontierShare)),
    });
  }
  return rows;
}

function computeFocusedEmbeddingDeltas(subsetRows: SubsetSummary[]) {
  const subsets = ['all', 'embedding_sensitive'];
  const rows: Record<string, unknown>[] = [];
  for (const subsetId of subsets) {
    const baseline = subsetRows.find((row) => row.surface === 'internal' && row.configId === 'auto_hybrid' && row.subsetId === subsetId);
    const comparator = subsetRows.find((row) => row.surface === 'internal' && row.configId === 'auto_off' && row.subsetId === subsetId);
    if (!baseline || !comparator) continue;
    for (const metric of ['overall', 'selection', 'semantic', 'pool_quality', 'diversity', 'semanticShare', 'semanticFrontierShare'] as const) {
      const left = baseline[metric];
      const right = comparator[metric];
      if (!Number.isFinite(left as number) || !Number.isFinite(right as number)) continue;
      rows.push({
        surface: 'internal',
        subsetId,
        baselineConfig: 'auto_hybrid',
        comparatorConfig: 'auto_off',
        metric,
        meanDelta: Number(left) - Number(right),
      });
    }
  }
  return rows;
}

function bootstrapDelta(
  baselineValues: number[],
  comparatorValues: number[],
  iterations: number,
): { meanDelta: number; ciLow: number; ciHigh: number } | null {
  if (!baselineValues.length || baselineValues.length !== comparatorValues.length) return null;
  const deltas = baselineValues.map((value, index) => value - comparatorValues[index]!);
  const boot: number[] = [];
  for (let iter = 0; iter < iterations; iter += 1) {
    let sum = 0;
    for (let i = 0; i < deltas.length; i += 1) {
      const index = Math.floor(Math.random() * deltas.length);
      sum += deltas[index]!;
    }
    boot.push(sum / deltas.length);
  }
  boot.sort((a, b) => a - b);
  return {
    meanDelta: mean(deltas)!,
    ciLow: percentile(boot, 0.025),
    ciHigh: percentile(boot, 0.975),
  };
}

function computeAblationRows(
  caseSummaries: CaseSummary[],
  progressionSummaries: ProgressionSummary[],
  weights: Record<string, number>,
  bootstrapIterations: number,
) {
  const baselineConfig = 'auto_hybrid';
  const comparators = ['heuristic_off', 'auto_off', 'heuristic_hybrid'];
  const rows: Record<string, unknown>[] = [];
  const internalCases = caseSummaries.filter((summary) => summary.surface === 'internal');
  const internalProgressions = progressionSummaries.filter((summary) => summary.surface === 'internal');

  for (const comparator of comparators) {
    const baselineCaseMap = new Map(
      internalCases.filter((summary) => summary.configId === baselineConfig).map((summary) => [summary.caseId, summary]),
    );
    const comparatorCaseMap = new Map(
      internalCases.filter((summary) => summary.configId === comparator).map((summary) => [summary.caseId, summary]),
    );
    const comparableCaseIds = Array.from(baselineCaseMap.keys()).filter((id) => comparatorCaseMap.has(id));

    for (const metric of ['selection', 'semantic', 'negation', 'color', 'persona', 'pool_quality', 'deterministic', 'diversity']) {
      const baselineValues: number[] = [];
      const comparatorValues: number[] = [];
      for (const id of comparableCaseIds) {
        const left = baselineCaseMap.get(id)?.metrics[metric];
        const right = comparatorCaseMap.get(id)?.metrics[metric];
        if (!Number.isFinite(left as number) || !Number.isFinite(right as number)) continue;
        baselineValues.push(Number(left));
        comparatorValues.push(Number(right));
      }
      const delta = bootstrapDelta(baselineValues, comparatorValues, bootstrapIterations);
      if (!delta) continue;
      rows.push({
        surface: 'internal',
        baselineConfig,
        comparatorConfig: comparator,
        metric,
        meanDelta: delta.meanDelta,
        ciLow: delta.ciLow,
        ciHigh: delta.ciHigh,
        units: baselineValues.length,
      });
    }

    const baselineProgressionMap = new Map(
      internalProgressions.filter((summary) => summary.configId === baselineConfig).map((summary) => [summary.groupId, summary]),
    );
    const comparatorProgressionMap = new Map(
      internalProgressions.filter((summary) => summary.configId === comparator).map((summary) => [summary.groupId, summary]),
    );
    const comparableGroups = Array.from(baselineProgressionMap.keys()).filter((id) => comparatorProgressionMap.has(id));
    const baselineProgressionValues = comparableGroups
      .map((id) => baselineProgressionMap.get(id)?.score)
      .filter((value): value is number => Number.isFinite(value as number));
    const comparatorProgressionValues = comparableGroups
      .map((id) => comparatorProgressionMap.get(id)?.score)
      .filter((value): value is number => Number.isFinite(value as number));
    const progressionDelta = bootstrapDelta(baselineProgressionValues, comparatorProgressionValues, bootstrapIterations);
    if (progressionDelta) {
      rows.push({
        surface: 'internal',
        baselineConfig,
        comparatorConfig: comparator,
        metric: 'progression',
        meanDelta: progressionDelta.meanDelta,
        ciLow: progressionDelta.ciLow,
        ciHigh: progressionDelta.ciHigh,
        units: baselineProgressionValues.length,
      });
    }

    const overallBaselineValues: number[] = [];
    const overallComparatorValues: number[] = [];
    for (const id of comparableCaseIds) {
      const left = baselineCaseMap.get(id)?.metrics.overall;
      const right = comparatorCaseMap.get(id)?.metrics.overall;
      if (!Number.isFinite(left as number) || !Number.isFinite(right as number)) continue;
      overallBaselineValues.push(Number(left));
      overallComparatorValues.push(Number(right));
    }
    const overallDelta = bootstrapDelta(overallBaselineValues, overallComparatorValues, bootstrapIterations);
    if (overallDelta) {
      rows.push({
        surface: 'internal',
        baselineConfig,
        comparatorConfig: comparator,
        metric: 'overall_cases',
        meanDelta: overallDelta.meanDelta,
        ciLow: overallDelta.ciLow,
        ciHigh: overallDelta.ciHigh,
        units: overallBaselineValues.length,
      });
    }

    const overallMetricMeansLeft = rows
      .filter((row) => row.baselineConfig === baselineConfig && row.comparatorConfig === comparator)
      .reduce<Record<string, number>>((acc, row) => {
        if (typeof row.metric === 'string' && typeof row.meanDelta === 'number') acc[row.metric] = Number(row.meanDelta);
        return acc;
      }, {});
    const comparableMetrics = Object.keys(weights).filter((metric) => overallMetricMeansLeft[metric] != null);
    if (comparableMetrics.length) {
      const totalWeight = comparableMetrics.reduce((sum, metric) => sum + (weights[metric] || 0), 0);
      const weightedDelta = comparableMetrics.reduce((sum, metric) => sum + overallMetricMeansLeft[metric]! * (weights[metric] || 0), 0) / Math.max(totalWeight, 0.0001);
      rows.push({
        surface: 'internal',
        baselineConfig,
        comparatorConfig: comparator,
        metric: 'overall_weighted_estimate',
        meanDelta: weightedDelta,
        ciLow: null,
        ciHigh: null,
        units: comparableMetrics.length,
      });
    }
  }
  return rows;
}

async function runInternalCase(
  service: any,
  suiteConfig: BenchmarkSuiteConfig,
  config: BenchmarkConfig,
  promptCase: PromptCase,
) {
  const request = {
    indexPath: path.resolve(REPO_ROOT, suiteConfig.internal.indexPath),
    prompt: promptCase.prompt,
    genderPref: promptCase.genderPref,
    parserMode: config.parserMode,
    outputMode: 'json',
    embeddingMode: config.embeddingMode,
    embeddingSidecarPath: path.resolve(REPO_ROOT, suiteConfig.internal.embeddingSidecarPath),
    project: resolveProjectFromEnv(suiteConfig.internal.projectEnvKeys),
    location: process.env.RECOMMENDER_LOCATION || suiteConfig.internal.location,
    model: process.env.RECOMMENDER_MODEL || suiteConfig.internal.model,
    embeddingModel: process.env.RECOMMENDER_EMBEDDING_MODEL || suiteConfig.internal.embeddingModel,
    geminiTimeoutMs: suiteConfig.internal.geminiTimeoutMs,
    bypassParseCache: suiteConfig.internal.bypassParseCache,
    bypassEmbeddingCache: suiteConfig.internal.bypassEmbeddingCache,
    requireLiveParse: false,
    benchmarkRateLimitMs: 0,
    poolSize: suiteConfig.internal.poolSize,
    perRoleLimit: suiteConfig.internal.perRoleLimit,
    epsilon: suiteConfig.internal.epsilon,
    jitter: suiteConfig.internal.jitter,
    seed: suiteConfig.internal.seed,
    intentOnly: false,
    intentJsonInPath: null,
    debug: suiteConfig.internal.debug,
  };
  const startedAt = Date.now();
  const response = await service.recommend(request);
  return {
    normalized: normalizeInternalResponse(response),
    latencyMs: Date.now() - startedAt,
    parserMode: config.parserMode,
    embeddingMode: config.embeddingMode,
  };
}

async function runRouteCase(
  routeUrl: string,
  suiteConfig: BenchmarkSuiteConfig,
  promptCase: PromptCase,
) {
  const startedAt = Date.now();
  const res = await fetch(routeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      prompt: promptCase.prompt,
      gender_pref: promptCase.genderPref,
      pool_size: suiteConfig.route.poolSize,
      per_role_limit: suiteConfig.route.perRoleLimit,
    }),
    signal: AbortSignal.timeout(suiteConfig.route.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`route_${res.status}:${text.slice(0, 280)}`);
  }
  const json = JSON.parse(text);
  return {
    normalized: normalizeRouteResponse(json),
    latencyMs: Date.now() - startedAt,
    parserMode: json?.meta?.parserMode || null,
    embeddingMode: json?.meta?.embeddingMode || null,
  };
}

function serializeSelection(selection: NormalizedResponse['selection']) {
  return Object.fromEntries(
    SLOT_KEYS.map((slot) => [
      slot,
      selection[slot]
        ? {
            id: selection[slot]!.id,
            title: selection[slot]!.title,
            category: selection[slot]!.category,
            gender: selection[slot]!.gender,
            families: selection[slot]!.families,
            colours: selection[slot]!.colourFamilies,
          }
        : null,
    ]).filter(([, item]) => item),
  );
}

function serializePools(pools: NormalizedResponse['pools']) {
  return Object.fromEntries(
    SLOT_KEYS.map((slot) => [
      slot,
      (pools[slot] || []).map((item) => ({
        id: item.id,
        title: item.title,
        families: item.families,
        colours: item.colourFamilies,
        gender: item.gender,
      })),
    ]),
  );
}

function resolveProjectFromEnv(keys: string[]): string | null {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return null;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnvFile(path.resolve(REPO_ROOT, 'tryon-local/.env'));

  const configPath = path.resolve(REPO_ROOT, String(args.config || 'testing-rec/config/default.json'));
  const promptsPath = path.resolve(REPO_ROOT, String(args.prompts || 'testing-rec/prompts/core.json'));
  const rubricsPath = path.resolve(REPO_ROOT, String(args.rubrics || 'testing-rec/rubrics/core.json'));
  const outputStem = String(args['output-stem'] || new Date().toISOString().replace(/[:.]/g, '-'));
  const requestedSurface = String(args.surface || 'both');
  const smoke = !!args.smoke;
  const routeUrlOverride = typeof args['route-url'] === 'string' ? String(args['route-url']) : null;
  const configFilter = typeof args.configs === 'string'
    ? new Set(String(args.configs).split(',').map((entry) => entry.trim()).filter(Boolean))
    : null;
  const caseFilter = typeof args.cases === 'string'
    ? new Set(String(args.cases).split(',').map((entry) => entry.trim()).filter(Boolean))
    : null;

  const suiteConfig = loadJson<BenchmarkSuiteConfig>(configPath);
  let promptCases = loadJson<PromptCase[]>(promptsPath);
  const rubrics = loadJson<Record<string, Rubric>>(rubricsPath);

  if (caseFilter) promptCases = promptCases.filter((entry) => caseFilter.has(entry.id));
  if (smoke) promptCases = promptCases.slice(0, 5);

  const rawDir = path.resolve(REPO_ROOT, 'testing-rec/results/raw');
  const summaryDir = path.resolve(REPO_ROOT, 'testing-rec/results/summary');
  ensureDir(rawDir);
  ensureDir(summaryDir);

  const runRecords: RunRecord[] = [];
  const selectedSurfaces: Surface[] = requestedSurface === 'internal'
    ? ['internal']
    : requestedSurface === 'route'
      ? ['route']
      : ['internal', 'route'];

  let internalService: any = null;
  if (selectedSurfaces.includes('internal')) {
    const { RecommendationService } = await import('../../tryon-local/reccomender/recommendation/index.ts');
    internalService = new RecommendationService();
  }

  if (selectedSurfaces.includes('internal')) {
    const internalConfigs = suiteConfig.configs.filter((entry) => !configFilter || configFilter.has(entry.id));
    for (const config of internalConfigs) {
      for (const promptCase of promptCases) {
        const rubric = rubrics[promptCase.rubricId];
        if (!rubric) throw new Error(`Missing rubric ${promptCase.rubricId}`);
        const repeatCount = Math.max(
          suiteConfig.repeats.standard,
          promptCase.metricFamilies.includes('deterministic') ? suiteConfig.repeats.determinism : 0,
          promptCase.metricFamilies.includes('diversity') ? suiteConfig.repeats.diversity : 0,
        );
        for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
          const runId = `${outputStem}::internal::${config.id}::${promptCase.id}::${repeatIndex}`;
          try {
            const result = await runInternalCase(internalService, suiteConfig, config, promptCase);
            const metrics = buildRunMetrics(result.normalized, rubric);
            runRecords.push({
              runId,
              surface: 'internal',
              configId: config.id,
              caseId: promptCase.id,
              prompt: promptCase.prompt,
              genderPref: promptCase.genderPref,
              repeatIndex,
              success: true,
              error: null,
              latencyMs: result.latencyMs,
              parserMode: result.parserMode,
              embeddingMode: result.embeddingMode,
              selectionForm: promptCase.selectionForm,
              metrics,
              selection: result.normalized.selection as any,
              pools: result.normalized.pools as any,
              intent: result.normalized.intent as any,
              diagnostics: result.normalized.diagnostics,
              meta: result.normalized.meta,
            });
          } catch (error: any) {
            runRecords.push({
              runId,
              surface: 'internal',
              configId: config.id,
              caseId: promptCase.id,
              prompt: promptCase.prompt,
              genderPref: promptCase.genderPref,
              repeatIndex,
              success: false,
              error: String(error?.message || error),
              latencyMs: null,
              parserMode: config.parserMode,
              embeddingMode: config.embeddingMode,
              selectionForm: promptCase.selectionForm,
              metrics: {
                selection: null,
                semantic: null,
                negation: null,
                color: null,
                persona: null,
                pool_quality: null,
                deterministic: null,
                diversity: null,
                progression: null,
                overall: null,
              },
              selection: null,
              pools: null,
              intent: null,
              diagnostics: null,
              meta: null,
            });
          }
        }
      }
    }
  }

  const routeUrl = routeUrlOverride || suiteConfig.route.url;
  if (selectedSurfaces.includes('route')) {
    if (!routeUrl) {
      console.warn('[benchmark] route surface requested but no route URL provided; skipping route surface.');
    } else {
      for (const promptCase of promptCases) {
        const rubric = rubrics[promptCase.rubricId];
        const repeatCount = Math.max(
          suiteConfig.repeats.standard,
          promptCase.metricFamilies.includes('deterministic') ? suiteConfig.repeats.determinism : 0,
          promptCase.metricFamilies.includes('diversity') ? suiteConfig.repeats.diversity : 0,
        );
        for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
          const runId = `${outputStem}::route::route_default::${promptCase.id}::${repeatIndex}`;
          try {
            const result = await runRouteCase(routeUrl, suiteConfig, promptCase);
            const metrics = buildRunMetrics(result.normalized, rubric);
            runRecords.push({
              runId,
              surface: 'route',
              configId: 'route_default',
              caseId: promptCase.id,
              prompt: promptCase.prompt,
              genderPref: promptCase.genderPref,
              repeatIndex,
              success: true,
              error: null,
              latencyMs: result.latencyMs,
              parserMode: result.parserMode,
              embeddingMode: result.embeddingMode,
              selectionForm: promptCase.selectionForm,
              metrics,
              selection: result.normalized.selection as any,
              pools: result.normalized.pools as any,
              intent: result.normalized.intent as any,
              diagnostics: result.normalized.diagnostics,
              meta: result.normalized.meta,
            });
          } catch (error: any) {
            runRecords.push({
              runId,
              surface: 'route',
              configId: 'route_default',
              caseId: promptCase.id,
              prompt: promptCase.prompt,
              genderPref: promptCase.genderPref,
              repeatIndex,
              success: false,
              error: String(error?.message || error),
              latencyMs: null,
              parserMode: null,
              embeddingMode: null,
              selectionForm: promptCase.selectionForm,
              metrics: {
                selection: null,
                semantic: null,
                negation: null,
                color: null,
                persona: null,
                pool_quality: null,
                deterministic: null,
                diversity: null,
                progression: null,
                overall: null,
              },
              selection: null,
              pools: null,
              intent: null,
              diagnostics: null,
              meta: null,
            });
          }
        }
      }
    }
  }

  const caseSummaries: CaseSummary[] = [];
  const groupedRuns = new Map<string, RunRecord[]>();
  for (const record of runRecords) {
    const key = `${record.surface}::${record.configId}::${record.caseId}`;
    const list = groupedRuns.get(key) || [];
    list.push(record);
    groupedRuns.set(key, list);
  }
  for (const promptCase of promptCases) {
    for (const surface of ['internal', 'route'] as Surface[]) {
      const configIds = Array.from(new Set(runRecords.filter((record) => record.surface === surface).map((record) => record.configId)));
      for (const configId of configIds) {
        const key = `${surface}::${configId}::${promptCase.id}`;
        const records = groupedRuns.get(key);
        if (!records?.length) continue;
        caseSummaries.push(aggregateCaseSummary(records, promptCase, rubrics[promptCase.rubricId]!, suiteConfig.weights));
      }
    }
  }

  const progressionSummaries = computeProgressionSummaries(caseSummaries);
  const { metricRows, overallRows } = computeConfigMetricRows(caseSummaries, progressionSummaries, suiteConfig.weights);
  const ablationRows = computeAblationRows(caseSummaries, progressionSummaries, suiteConfig.weights, suiteConfig.bootstrapIterations);
  const subsetRows = [
    ...summarizeSubset(caseSummaries, suiteConfig.weights, 'all'),
    ...summarizeSubset(caseSummaries, suiteConfig.weights, 'embedding_sensitive'),
  ];
  const focusedEmbeddingRows = computeFocusedEmbeddingDeltas(subsetRows);

  const rawPath = path.resolve(rawDir, `${outputStem}.jsonl`);
  const caseSummaryJson = path.resolve(summaryDir, `${outputStem}.case-summary.json`);
  const caseSummaryCsv = path.resolve(summaryDir, `${outputStem}.case-summary.csv`);
  const progressionJson = path.resolve(summaryDir, `${outputStem}.progression-summary.json`);
  const progressionCsv = path.resolve(summaryDir, `${outputStem}.progression-summary.csv`);
  const metricJson = path.resolve(summaryDir, `${outputStem}.metric-summary.json`);
  const metricCsv = path.resolve(summaryDir, `${outputStem}.metric-summary.csv`);
  const overallJson = path.resolve(summaryDir, `${outputStem}.overall-summary.json`);
  const overallCsv = path.resolve(summaryDir, `${outputStem}.overall-summary.csv`);
  const deltaJson = path.resolve(summaryDir, `${outputStem}.ablation-deltas.json`);
  const deltaCsv = path.resolve(summaryDir, `${outputStem}.ablation-deltas.csv`);
  const subsetJson = path.resolve(summaryDir, `${outputStem}.subset-summary.json`);
  const subsetCsv = path.resolve(summaryDir, `${outputStem}.subset-summary.csv`);
  const embeddingImpactJson = path.resolve(summaryDir, `${outputStem}.embedding-impact.json`);
  const embeddingImpactCsv = path.resolve(summaryDir, `${outputStem}.embedding-impact.csv`);

  writeJsonLines(rawPath, runRecords);
  writeJson(caseSummaryJson, caseSummaries);
  writeCsv(caseSummaryCsv, caseSummaries.map((summary) => ({
    surface: summary.surface,
    configId: summary.configId,
    caseId: summary.caseId,
    prompt: summary.prompt,
    genderPref: summary.genderPref,
    selectionForm: summary.selectionForm,
    tags: summary.tags.join('|'),
    runCount: summary.runCount,
    successCount: summary.successCount,
    successRate: summary.successRate,
    meanLatencyMs: summary.meanLatencyMs,
    selection: summary.metrics.selection,
    semantic: summary.metrics.semantic,
    negation: summary.metrics.negation,
    color: summary.metrics.color,
    persona: summary.metrics.persona,
    pool_quality: summary.metrics.pool_quality,
    deterministic: summary.metrics.deterministic,
    diversity: summary.metrics.diversity,
    overall: summary.metrics.overall,
    semanticShare: summary.diagnostics.semanticShare,
    semanticFrontierShare: summary.diagnostics.semanticFrontierShare,
  })));
  writeJson(progressionJson, progressionSummaries);
  writeCsv(progressionCsv, progressionSummaries as any);
  writeJson(metricJson, metricRows);
  writeCsv(metricCsv, metricRows);
  writeJson(overallJson, overallRows);
  writeCsv(overallCsv, overallRows);
  writeJson(deltaJson, ablationRows);
  writeCsv(deltaCsv, ablationRows);
  writeJson(subsetJson, subsetRows);
  writeCsv(subsetCsv, subsetRows as any);
  writeJson(embeddingImpactJson, focusedEmbeddingRows);
  writeCsv(embeddingImpactCsv, focusedEmbeddingRows);

  console.log('[benchmark] complete', JSON.stringify({
    raw: rawPath,
    caseSummary: caseSummaryJson,
    progressionSummary: progressionJson,
    metricSummary: metricJson,
    overallSummary: overallJson,
    ablationDeltas: deltaJson,
    subsetSummary: subsetJson,
    embeddingImpact: embeddingImpactJson,
    records: runRecords.length,
    caseSummaries: caseSummaries.length,
    progressionGroups: progressionSummaries.length,
  }));
}

void main().catch((error) => {
  console.error('[benchmark] failed', error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
