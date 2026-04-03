import { EmbeddingSidecar } from '../semantic_embeddings';
import { SemanticAxisProfile, StyleSignals } from '../style_semantics';
import {
  CanonicalColourProfile,
  CategoryMain,
  Colour,
  Fit,
  Gender,
  IndexItem,
  OccasionTag,
  PaletteMode,
  PromptIntent,
  SlotConstraint,
} from '../fashion_taxonomy';
type SemanticSubjectKind = 'persona' | 'style_archetype' | 'brand' | 'team' | 'item_line' | 'theme';
type SemanticSubjectSource = 'gemini' | 'recovered' | 'legacy_persona' | 'none';

export type ParserMode = 'auto' | 'heuristic' | 'gemini';
export type OutputMode = 'text' | 'json' | 'images';
export type EmbeddingMode = 'off' | 'rerank' | 'hybrid';
export type SlotLockMode = 'broad' | 'attribute' | 'family' | 'exact';
export type VariantMode = 'none' | 'open' | 'locked';

export interface LoadedEmbeddings {
  sidecar: EmbeddingSidecar | null;
  sidecarPath: string | null;
  model?: string | null;
  dimensions?: number | null;
  createdAt?: string | null;
  schemaVersion?: number | null;
  taskType?: string | null;
  itemVectors: Map<string, number[]>;
  identityVectors: Map<string, number[]>;
  styleVectors: Map<string, number[]>;
  slotVectors: Record<CategoryMain, Map<string, number[]>>;
  slotIdentityVectors: Record<CategoryMain, Map<string, number[]>>;
  slotStyleVectors: Record<CategoryMain, Map<string, number[]>>;
}

export interface PromptEmbeddingState {
  active: boolean;
  available: boolean;
  source: string;
  reason: string | null;
  cacheHit?: boolean;
  retryCount?: number;
  model?: string | null;
  location?: string | null;
  promptVector: number[];
  identityVector: number[];
  styleVector: number[];
  slotPromptVectors: Partial<Record<CategoryMain, number[]>>;
  slotIdentityVectors: Partial<Record<CategoryMain, number[]>>;
  slotStyleVectors: Partial<Record<CategoryMain, number[]>>;
  semanticAxisProfile?: SemanticAxisProfile | null;
  semanticInformativeness?: number;
}

export interface RequestAnchorEmbedding {
  id: string;
  slot?: CategoryMain | null;
  vector: number[];
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

export interface GeminiIntentState {
  active: boolean;
  reason: string | null;
  intent: PromptIntent | null;
  source?: string | null;
  cacheHit?: boolean;
  retryCount?: number;
  model?: string | null;
  location?: string | null;
  semanticSubjectSource?: SemanticSubjectSource;
  recoveredSubjectKinds?: SemanticSubjectKind[];
  recoveredSubjectConfidenceSummary?: {
    count: number;
    mean: number;
    max: number;
  } | null;
}

export interface DebugEmbeddingState {
  active: boolean;
  mode: EmbeddingMode;
  sidecar_path: string | null;
  reason: string | null;
  source?: string | null;
  cache_hit?: boolean;
  retry_count?: number;
  model?: string | null;
  location?: string | null;
  sidecar_model?: string | null;
  sidecar_schema_version?: number | null;
  sidecar_created_at?: string | null;
}

export interface DebugGeminiState {
  active: boolean;
  reason: string | null;
  source?: string | null;
  cache_hit?: boolean;
  retry_count?: number;
  model?: string | null;
  location?: string | null;
}

export interface PhraseHit {
  phrase: string;
  slot: CategoryMain;
  subtype: string | null;
  familyOnly: boolean;
  start: number;
  end: number;
}

export interface ResolvedSlotConstraint extends SlotConstraint {
  anchor_keywords: string[];
  anchor_entities: string[];
  anchor_colours: Colour[];
  exact_item_phrases: string[];
}

export interface VariantSupportState {
  mode: VariantMode;
  groupHints: string[];
  disambiguatorStrength: number;
}

export interface SlotConstraintProfile extends ResolvedSlotConstraint {
  specificity: number;
  lockMode: SlotLockMode;
  diversityExempt: boolean;
  variantMode: VariantMode;
  variantGroupHints: string[];
  disambiguatorStrength: number;
}

export interface CandidateScore {
  item: IndexItem;
  score: number;
  symbolic: number;
  outfitSymbolic: number;
  semantic: number;
  stage: number;
  specificity: number;
  family: string;
  brandKey: string;
  colourFamily: string;
  variantGroupKey: string;
  variantBoosted: boolean;
  negativeViolated: boolean;
  constraintCleanliness?: number;
  semanticAdmission?: number;
  roleFit?: number;
  anchorPreservation?: number;
  familyFit?: number;
  hybridOwnership?: 'rerank' | 'baseline_promotion' | 'semantic_only';
  hybridSemanticOnly?: boolean;
  rerankReferenceScore?: number;
  rerankReferenceAdmission?: number;
  rerankReferenceRoleFit?: number;
  rerankReferenceFamilyFit?: number;
  rerankSuperiority?: number;
}

export interface Outfit {
  top?: IndexItem;
  bottom?: IndexItem;
  shoes?: IndexItem;
  mono?: IndexItem;
}

export interface ScoredOutfit {
  outfit: Outfit;
  score: number;
  symbolic: number;
  semantic: number;
  vector: number[];
  maxStage: number;
  stageSum: number;
  signature?: string;
  coreSignature?: string;
  paletteSignature?: string;
  slotMetadata?: Partial<Record<CategoryMain, {
    id: string;
    family: string;
    brand: string;
    colourFamily: string;
  }>>;
}

export interface RequestMemo {
  itemText: Map<string, string>;
  itemIdentityText: Map<string, string>;
  itemColourText: Map<string, string>;
  paletteColours: Map<string, Colour[]>;
  keywordHit: Map<string, boolean>;
  entityHit: Map<string, boolean>;
  colourHit: Map<string, boolean>;
  subtypeMatch: Map<string, boolean>;
  itemOccasions: Map<string, OccasionTag[]>;
  itemSignals: Map<string, StyleSignals>;
  itemFamily: Map<string, string>;
  itemBrand: Map<string, string>;
  itemColourFamily: Map<string, string>;
  itemColourProfile: Map<string, ItemColourProfile>;
  globalNegative: Map<string, boolean>;
  genderCompat: Map<string, boolean>;
  slotNegative: Map<string, boolean>;
  exactnessTier: Map<string, number>;
  anchorPreservation: Map<string, number>;
  symbolicScore: Map<string, number>;
  semanticScore: Map<string, number>;
  slotConstraintKeys: WeakMap<object, string>;
  vectorNorms: WeakMap<object, number>;
  slotItems: Partial<Record<CategoryMain, IndexItem[]>>;
  slotGlobalEligible: Partial<Record<CategoryMain, IndexItem[]>>;
  slotGenderEligible: Map<string, IndexItem[]>;
  preparedSlotCandidates: Map<string, unknown>;
  pairwiseBase: Map<string, number>;
}

export interface ItemColourProfile {
  primary: Colour | null;
  accents: Colour[];
  neutrals: Colour[];
  chromatic: Colour[];
  families: Colour[];
  warmCount: number;
  coolCount: number;
  neutralCount: number;
  canonical: Array<{ colour: Colour; profile: CanonicalColourProfile }>;
}

export type HarmonyRelation = 'same' | 'tonal' | 'analogous' | 'complementary' | 'neutral_bridge' | 'clash' | 'unrelated';

export interface PaletteEvaluation {
  score: number;
  signature: string;
  chromaticFamilies: Colour[];
  neutralFamilies: Colour[];
  mode: PaletteMode;
}

export type NegativeConstraintSet = PromptIntent['negative_constraints'];

export interface RecommendationRequest {
  indexPath: string;
  prompt: string;
  genderPref: Gender | 'any';
  anchorEmbeddings?: RequestAnchorEmbedding[];
  parserMode: ParserMode;
  outputMode: OutputMode;
  embeddingMode: EmbeddingMode;
  embeddingSidecarPath: string | null;
  project: string | null;
  location: string;
  model: string;
  embeddingModel: string;
  geminiTimeoutMs?: number | null;
  bypassParseCache?: boolean;
  bypassEmbeddingCache?: boolean;
  requireLiveParse?: boolean;
  benchmarkRateLimitMs?: number | null;
  poolSize: number;
  perRoleLimit: number;
  epsilon: number;
  jitter: number;
  seed: number | null;
  intentOnly: boolean;
  intentJsonInPath: string | null;
  debug: boolean;
}

export interface RecommendationDiagnostics {
  gemini: DebugGeminiState;
  embeddings: DebugEmbeddingState;
}

export interface RecommendationResponse {
  intent: PromptIntent;
  looks: ScoredOutfit[];
  diagnostics: RecommendationDiagnostics;
}
