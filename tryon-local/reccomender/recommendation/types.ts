import type { CategoryMain, Gender, PromptIntent } from '../fashion_taxonomy';
import type {
  CandidateScore,
  DebugEmbeddingState,
  DebugGeminiState,
  EmbeddingMode,
  GeminiIntentState,
  HarmonyRelation,
  IndexItem,
  ItemColourProfile,
  LoadedEmbeddings,
  NegativeConstraintSet,
  Outfit,
  OutputMode,
  PaletteEvaluation,
  ParserMode,
  PhraseHit,
  PromptEmbeddingState,
  RequestAnchorEmbedding,
  RecommendationDiagnostics,
  RecommendationRequest,
  RecommendationResponse,
  RequestMemo,
  ResolvedSlotConstraint,
  ScoredOutfit,
  SlotConstraintProfile,
  SlotLockMode,
  VariantMode,
  VariantSupportState,
} from '../og_recommendation/types';

export type {
  CandidateScore,
  DebugEmbeddingState,
  DebugGeminiState,
  EmbeddingMode,
  GeminiIntentState,
  HarmonyRelation,
  IndexItem,
  ItemColourProfile,
  LoadedEmbeddings,
  NegativeConstraintSet,
  Outfit,
  OutputMode,
  PaletteEvaluation,
  ParserMode,
  PhraseHit,
  PromptEmbeddingState,
  RequestAnchorEmbedding,
  RecommendationDiagnostics,
  RecommendationRequest,
  RecommendationResponse,
  RequestMemo,
  ResolvedSlotConstraint,
  ScoredOutfit,
  SlotConstraintProfile,
  SlotLockMode,
  VariantMode,
  VariantSupportState,
};

export type AssemblyMode = 'single_item' | 'partial_outfit' | 'full_outfit';
export type BrandFitMode = 'none' | 'single_brand_presence' | 'full_brand_coverage';
export type SemanticSubjectKind = 'persona' | 'style_archetype' | 'brand' | 'team' | 'item_line' | 'theme';
export type StyleSubjectKind = SemanticSubjectKind | 'none';
export type SubjectScope = 'global' | 'slot' | 'mixed';
export type ParserSource = 'gemini' | 'heuristic' | 'merged' | 'fallback' | 'intent_json';
export type SemanticSubjectSource = 'gemini' | 'recovered' | 'legacy_persona' | 'none';

export interface SemanticSubject {
  kind: SemanticSubjectKind;
  label: string;
  confidence: number;
  scope: SubjectScope;
  slots: CategoryMain[];
  style_axes: string[];
  silhouette_terms: string[];
  palette_terms: string[];
  category_preferences: CategoryMain[];
  soft_brand_priors: string[];
  gender_signal: Gender | 'any' | null;
}

export interface PersonaProfile {
  name: string | null;
  confidence: number;
  style_axes: string[];
  silhouette_terms: string[];
  palette_terms: string[];
  category_preferences: CategoryMain[];
  soft_brand_priors: string[];
  gender_signal: Gender | 'any' | null;
}

export interface SemanticDirectives {
  style_axes: string[];
  silhouette_terms: string[];
  palette_terms: string[];
  category_preferences: CategoryMain[];
}

export interface PromptIntentV2 extends PromptIntent {
  requested_slots: CategoryMain[];
  assembly_mode: AssemblyMode;
  brand_fit_mode: BrandFitMode;
  semantic_subjects: SemanticSubject[];
  style_subjects: StyleSubjectKind[];
  subject_scope: SubjectScope;
  subject_slots: Partial<Record<Exclude<StyleSubjectKind, 'none'>, CategoryMain[]>>;
  persona_profile: PersonaProfile | null;
  semantic_directives: SemanticDirectives;
}

export interface ScoreAttribution {
  mean_symbolic: number;
  mean_semantic: number;
  semantic_share: number;
  semantic_score_share: number;
  semantic_frontier_share: number;
  semantic_candidate_source: Partial<Record<CategoryMain, 'symbolic' | 'semantic_union' | 'mixed'>>;
  slot_semantic_viability?: Partial<Record<CategoryMain, number>>;
  slot_semantic_valid_floor?: Partial<Record<CategoryMain, number>>;
  parser_source: ParserSource;
}

export interface GeminiDiagnosticsV2 extends DebugGeminiState {
  gemini_subject_kinds: SemanticSubjectKind[];
  semantic_subject_source?: SemanticSubjectSource;
  recovered_subject_kinds?: SemanticSubjectKind[];
  recovered_subject_confidence_summary?: {
    count: number;
    mean: number;
    max: number;
  } | null;
}

export interface RecommendationDiagnosticsV2 extends RecommendationDiagnostics {
  gemini: GeminiDiagnosticsV2;
  score_attribution: ScoreAttribution;
}

export interface CandidateFrontierDiagnostics {
  semantic_frontier_share: number;
  semantic_candidate_source: Partial<Record<CategoryMain, 'symbolic' | 'semantic_union' | 'mixed'>>;
  slot_semantic_viability?: Partial<Record<CategoryMain, number>>;
  slot_semantic_valid_floor?: Partial<Record<CategoryMain, number>>;
}

export interface RecommendationResponseV2 extends Omit<RecommendationResponse, 'intent' | 'diagnostics'> {
  intent: PromptIntentV2;
  diagnostics: RecommendationDiagnosticsV2;
  slot_pools?: Partial<Record<CategoryMain, IndexItem[]>>;
}
