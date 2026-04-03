import path from 'path';
import { SLOT_ORDER, normalizeText } from '../fashion_taxonomy';
import { setRequestPairwiseCorpusVersion } from '../og_recommendation/RecommendationService';
import { CatalogRepository } from './CatalogRepository';
import { CandidateRanker } from './CandidateRanker';
import { EmbeddingService } from './EmbeddingService';
import { OutfitAssembler } from './OutfitAssembler';
import { PromptParser } from './PromptParser';
import {
  CandidateFrontierDiagnostics,
  RecommendationRequest,
  RecommendationResponseV2,
  ScoredOutfit,
} from './types';
import { ParserSource, PromptIntentV2 } from './types';

const TIMING_LOGS_ENABLED = (process.env.RECOMMENDER_TIMING_LOGS || '0') === '1';

function pairwiseCorpusVersion(indexPath: string, itemIds: string[], sidecarMeta: { model?: string | null; schemaVersion?: number | null; createdAt?: string | null }) {
  const sample = itemIds.slice(0, 8).concat(itemIds.slice(-8));
  return [
    path.basename(indexPath),
    sidecarMeta.model || 'unknown',
    Number.isFinite(sidecarMeta.schemaVersion as number) ? Number(sidecarMeta.schemaVersion) : 'na',
    sidecarMeta.createdAt || 'na',
    itemIds.length,
    sample.join(','),
  ].join('|');
}

function broadSlotPoolIntent(intent: PromptIntentV2): boolean {
  const requested = intent.requested_slots.length ? intent.requested_slots : SLOT_ORDER;
  if (intent.assembly_mode !== 'full_outfit') return false;
  if (requested.length < 3) return false;
  if (intent.brand_focus.length || intent.team_focus.length || intent.specific_items.length) return false;
  return !!(intent.vibe_tags.length || intent.occasion_tags.length || intent.semantic_subjects.length);
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

function slotCompatibilityText(item: any): string {
  return normalizeText(
    [
      item?.category || '',
      item?.name || '',
      item?.name_normalized || '',
      item?.sub || '',
      ...(Array.isArray(item?.entities) ? item.entities : []),
      ...(Array.isArray(item?.identity_entities) ? item.identity_entities : []),
      ...(Array.isArray(item?.entityMeta) ? item.entityMeta.map((entry: any) => entry?.text || '') : []),
      ...(Array.isArray(item?.style_markers) ? item.style_markers : []),
      ...(Array.isArray(item?.occasion_tags) ? item.occasion_tags : []),
    ].join(' '),
  );
}

function candidateSlotCompatible(item: any, slot: string): boolean {
  if (!item || !slot) return false;
  const category = normalizeText(item?.category || '');
  const text = slotCompatibilityText(item);
  if (!text && !category) return false;

  if (slot === 'top') {
    if (/\b(shoe|shoes|sneaker|sneakers|trainer|trainers|boot|boots|loafer|loafers|heel|heels|oxford|oxfords|derby|derbies|sandal|sandals|mule|mules|slipper|slippers|cleat|cleats|pant|pants|trouser|trousers|jean|jeans|legging|leggings|shorts|short|skirt|skirts|dress|gown|jumpsuit|romper)\b/.test(text)) return false;
    if (category === slot) return true;
    return /\b(shirt|tee|t-shirt|tshirt|top|hoodie|sweater|jumper|cardigan|jacket|coat|blazer|polo|vest|waistcoat|outerwear|overshirt)\b/.test(text)
      || text.includes('shirt')
      || text.includes('hoodie')
      || text.includes('jacket')
      || text.includes('polo')
      || text.includes('jersey');
  }

  if (slot === 'bottom') {
    if (/\b(shoe|shoes|sneaker|sneakers|trainer|trainers|boot|boots|loafer|loafers|heel|heels|oxford|oxfords|derby|derbies|sandal|sandals|mule|mules|slipper|slippers|cleat|cleats|shirt|tee|t-shirt|tshirt|hoodie|sweater|cardigan|jacket|coat|blazer|polo|dress|gown|jumpsuit|romper)\b/.test(text)) return false;
    if (category === slot) return true;
    return /\b(pant|pants|trouser|trousers|jean|jeans|legging|leggings|shorts|short|jogger|joggers|cargo|cargos|skirt|skirts|slacks|chino|chinos)\b/.test(text)
      || text.includes('shorts')
      || text.includes('pants')
      || text.includes('trousers')
      || text.includes('jeans')
      || text.includes('jogger')
      || text.includes('cargo');
  }

  if (slot === 'shoes') {
    if (/\b(dress|gown|jumpsuit|romper|shirt|tee|t-shirt|tshirt|hoodie|jacket|coat|blazer|trouser|trousers|jean|jeans|shorts|short|skirt|skirts)\b/.test(text)) return false;
    if (category === slot) return true;
    return /\b(shoe|shoes|sneaker|sneakers|trainer|trainers|boot|boots|loafer|loafers|heel|heels|oxford|oxfords|derby|derbies|sandal|sandals|mule|mules|slipper|slippers|cleat|cleats)\b/.test(text)
      || text.includes('sneaker')
      || text.includes('boot')
      || text.includes('shoe')
      || text.includes('cleat')
      || text.includes('jordan');
  }

  if (slot === 'mono') {
    if (/\b(shoe|shoes|sneaker|sneakers|trainer|trainers|boot|boots|loafer|loafers|shirt|tee|t-shirt|tshirt|hoodie|jacket|coat|blazer|trouser|trousers|jean|jeans|shorts|short|skirt|skirts)\b/.test(text)) return false;
    if (category === slot) return true;
    return /\b(dress|gown|jumpsuit|romper|playsuit|one piece|one-piece)\b/.test(text);
  }

  return false;
}

export class RecommendationService {
  public constructor(
    private readonly promptParser: PromptParser = new PromptParser(),
    private readonly catalogRepository: CatalogRepository = new CatalogRepository(),
    private readonly embeddingService: EmbeddingService = new EmbeddingService(),
    private readonly candidateRanker: CandidateRanker = new CandidateRanker(),
    private readonly outfitAssembler: OutfitAssembler = new OutfitAssembler(),
  ) {}

  private scoreAttribution(looks: ScoredOutfit[], parserSource: ParserSource, frontierDiagnostics: CandidateFrontierDiagnostics) {
    const scoped = looks.slice(0, Math.min(looks.length, 5));
    const meanSymbolic = scoped.length
      ? scoped.reduce((sum, look) => sum + look.symbolic, 0) / scoped.length
      : 0;
    const meanSemantic = scoped.length
      ? scoped.reduce((sum, look) => sum + look.semantic, 0) / scoped.length
      : 0;
    const denominator = Math.abs(meanSymbolic) + Math.abs(meanSemantic);
    return {
      mean_symbolic: Number(meanSymbolic.toFixed(6)),
      mean_semantic: Number(meanSemantic.toFixed(6)),
      semantic_share: Number((denominator > 0 ? meanSemantic / denominator : 0).toFixed(6)),
      semantic_score_share: Number((denominator > 0 ? meanSemantic / denominator : 0).toFixed(6)),
      semantic_frontier_share: frontierDiagnostics.semantic_frontier_share,
      semantic_candidate_source: frontierDiagnostics.semantic_candidate_source,
      slot_semantic_viability: frontierDiagnostics.slot_semantic_viability,
      slot_semantic_valid_floor: frontierDiagnostics.slot_semantic_valid_floor,
      parser_source: parserSource,
    };
  }

  private candidatePreviews(candidatesBySlot: Record<string, Array<{ item: any; score: number; symbolic: number; semantic: number }>>) {
    return Object.fromEntries(
      Object.entries(candidatesBySlot).map(([slot, list]) => [
        slot,
        (Array.isArray(list) ? list : []).slice(0, 6).map((entry) => ({
          id: entry.item?.id || null,
          title: entry.item?.name || null,
          gender: entry.item?.gender || null,
          source: entry.item?.source || null,
          listing_id: entry.item?.listing_id || null,
          score: Number(Number(entry.score || 0).toFixed(4)),
          symbolic: Number(Number(entry.symbolic || 0).toFixed(4)),
          semantic: Number(Number(entry.semantic || 0).toFixed(4)),
          brand: Array.isArray(entry.item?.entityMeta)
            ? entry.item.entityMeta.find((meta: any) => meta?.type === 'brand')?.text || null
            : null,
          sub: entry.item?.sub || null,
        })),
      ]),
    );
  }

  private slotPools(
    candidatesBySlot: Record<string, Array<{ item: any; score: number; symbolic: number; semantic: number }>>,
    request: RecommendationRequest,
    intent: PromptIntentV2,
  ) {
    return Object.fromEntries(
      Object.entries(candidatesBySlot).map(([slot, list]) => {
        let limit = broadSlotPoolIntent(intent)
          ? Math.max(request.poolSize * 2, request.perRoleLimit + 6, 24)
          : Math.max(request.poolSize, 12);
        if (slot === 'top' && oldMoneyMensIntent(intent)) {
          limit = Math.max(limit, request.perRoleLimit + 12, 32);
        }
        const seen = new Set<string>();
        const items = (Array.isArray(list) ? list : [])
          .map((entry) => entry?.item || null)
          .filter(Boolean)
          .filter((item) => candidateSlotCompatible(item, slot))
          .filter((item) => {
            const key = String(item.id || item.imagePath || '').trim();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, limit);
        return [slot, items];
      }),
    );
  }

  private sanitizeCandidatesBySlot(
    candidatesBySlot: Record<string, Array<{ item: any; score: number; symbolic: number; semantic: number }>>,
  ) {
    return Object.fromEntries(
      Object.entries(candidatesBySlot).map(([slot, list]) => {
        const raw = Array.isArray(list) ? list : [];
        const sanitized = raw.filter((entry) => candidateSlotCompatible(entry?.item, slot));
        return [slot, sanitized.length ? sanitized : raw];
      }),
    ) as Record<string, Array<{ item: any; score: number; symbolic: number; semantic: number }>>;
  }

  private logTiming(request: RecommendationRequest, payload: Record<string, any>) {
    if (!TIMING_LOGS_ENABLED && !request.debug) return;
    console.log('[recommender][timing]', JSON.stringify(payload));
  }

  public async recommend(request: RecommendationRequest): Promise<RecommendationResponseV2> {
    const startedAt = Date.now();
    const timings: Record<string, number> = {};
    let checkpoint = startedAt;
    const mark = (label: string) => {
      const now = Date.now();
      timings[label] = now - checkpoint;
      checkpoint = now;
    };

    this.catalogRepository.prepareRequest(request.seed);
    this.catalogRepository.ensureCredentials(request.debug);

    const catalogStartedAt = Date.now();
    const indexPath = path.resolve(request.indexPath);
    const items = this.catalogRepository.loadIndex(indexPath);
    const corpusStats = this.catalogRepository.buildCorpusStats(items);
    const resolvedProject = this.catalogRepository.resolveProject(request.project);
    timings.catalog_ms = Date.now() - catalogStartedAt;

    let parseMs = 0;
    let loadEmbeddingsMs = 0;
    let itemPrepMs = 0;
    const parseStartedAt = Date.now();
    const parsePromise = this.promptParser.resolveIntent(
      { ...request, indexPath, project: resolvedProject },
      corpusStats,
    ).then((value) => {
      parseMs = Date.now() - parseStartedAt;
      return value;
    });
    const itemPrepStartedAt = Date.now();
    const itemPrepPromise = Promise.resolve().then(() => {
      this.candidateRanker.precomputeItems(items);
      itemPrepMs = Date.now() - itemPrepStartedAt;
    });
    const embeddingsStartedAt = Date.now();
    const embeddingsPromise = request.intentOnly
      ? Promise.resolve(null)
      : Promise.resolve(
          this.catalogRepository.loadEmbeddings(indexPath, request.embeddingSidecarPath, request.debug),
        ).then((value) => {
          loadEmbeddingsMs = Date.now() - embeddingsStartedAt;
          return value;
        });

    const [{ intent, geminiState, parserSource }, loadedEmbeddings] = await Promise.all([
      parsePromise,
      embeddingsPromise,
      itemPrepPromise,
    ]);
    timings.parse_ms = parseMs;
    timings.load_embeddings_ms = loadEmbeddingsMs;
    timings.item_precompute_ms = itemPrepMs;
    timings.parallel_setup_ms = Date.now() - Math.min(parseStartedAt, itemPrepStartedAt, embeddingsStartedAt);
    checkpoint = Date.now();
    this.logTiming(request, {
      stage: 'after_parse',
      prompt_length: String(request.prompt || '').length,
      parser_source: parserSource,
      gemini_cache_hit: !!geminiState.cacheHit,
      gemini_source: geminiState.source || null,
      gemini_reason: geminiState.reason || null,
      timings,
    });
    const slotProfiles = this.candidateRanker.buildSlotProfiles(intent, items, corpusStats);
    mark('slot_profiles_ms');

    if (request.intentOnly) {
      return {
        intent,
        looks: [],
        diagnostics: {
          gemini: {
            active: geminiState.active,
            reason: geminiState.reason,
            source: geminiState.source || null,
            cache_hit: !!geminiState.cacheHit,
            retry_count: Number(geminiState.retryCount || 0),
            model: geminiState.model || request.model,
            location: geminiState.location || request.location,
            gemini_subject_kinds: Array.from(new Set(intent.semantic_subjects.map((subject) => subject.kind))),
            semantic_subject_source: geminiState.semanticSubjectSource || 'none',
            recovered_subject_kinds: geminiState.recoveredSubjectKinds || [],
            recovered_subject_confidence_summary: geminiState.recoveredSubjectConfidenceSummary || null,
          },
          embeddings: {
            active: false,
            mode: request.embeddingMode,
            sidecar_path: null,
            reason: 'intent_only',
            source: 'intent_only',
            cache_hit: false,
            retry_count: 0,
            model: request.embeddingModel,
            location: request.location,
            sidecar_model: null,
            sidecar_schema_version: null,
            sidecar_created_at: null,
          },
          score_attribution: this.scoreAttribution([], parserSource, { semantic_frontier_share: 0, semantic_candidate_source: {}, slot_semantic_viability: {}, slot_semantic_valid_floor: {} }),
        },
      };
    }

    setRequestPairwiseCorpusVersion(pairwiseCorpusVersion(
      indexPath,
      items.map((item) => item.id).sort(),
      {
        model: loadedEmbeddings?.model,
        schemaVersion: loadedEmbeddings?.schemaVersion,
        createdAt: loadedEmbeddings?.createdAt,
      },
    ));
    const promptEmbeddings = await this.embeddingService.resolvePromptEmbeddings(
      { ...request, indexPath, project: resolvedProject },
      intent,
      loadedEmbeddings!,
      corpusStats,
    );
    mark('prompt_embedding_ms');
    this.logTiming(request, {
      stage: 'after_prompt_embeddings',
      prompt_length: String(request.prompt || '').length,
      parser_source: parserSource,
      gemini_cache_hit: !!geminiState.cacheHit,
      embedding_cache_hit: !!promptEmbeddings.cacheHit,
      embedding_source: promptEmbeddings.source || null,
      embedding_reason: promptEmbeddings.reason || null,
      timings,
    });
    const rawCandidatesBySlot = this.candidateRanker.buildCandidates(
      items,
      intent,
      slotProfiles,
      request.perRoleLimit,
      promptEmbeddings,
      loadedEmbeddings!,
      request.embeddingMode,
      request.debug,
    );
    const candidatesBySlot = this.sanitizeCandidatesBySlot(rawCandidatesBySlot);
    mark('build_candidates_ms');
    this.logTiming(request, {
      stage: 'after_build_candidates',
      prompt_length: String(request.prompt || '').length,
      parser_source: parserSource,
      gemini_cache_hit: !!geminiState.cacheHit,
      embedding_cache_hit: !!promptEmbeddings.cacheHit,
      timings,
      candidate_counts: Object.fromEntries(
        Object.entries(candidatesBySlot).map(([slot, list]) => [slot, Array.isArray(list) ? list.length : 0]),
      ),
    });
    const frontierDiagnostics = this.candidateRanker.getFrontierDiagnostics();
    const scoringEmbeddings = this.embeddingService.synthesizePromptEmbeddingsFromCandidates(
      promptEmbeddings,
      candidatesBySlot,
      slotProfiles,
      loadedEmbeddings!,
    );
    mark('synthesize_prompt_embeddings_ms');
    const scoreLookup = this.candidateRanker.buildScoreLookup(candidatesBySlot);
    await this.outfitAssembler.warmPairwiseCompatibilityCache(candidatesBySlot);
    mark('score_lookup_ms');

    const outfits = this.outfitAssembler.assembleOutfits(
      candidatesBySlot,
      intent,
      scoreLookup,
      slotProfiles,
      request.poolSize,
    );
    mark('assemble_ms');
    this.logTiming(request, {
      stage: 'after_assemble',
      prompt_length: String(request.prompt || '').length,
      parser_source: parserSource,
      gemini_cache_hit: !!geminiState.cacheHit,
      embedding_cache_hit: !!promptEmbeddings.cacheHit,
      timings,
      outfit_count: outfits.length,
    });
    if (!outfits.length) throw new Error('No outfits/items could be constructed.');

    const looks = this.outfitAssembler.scoreAndDiversify(
      outfits,
      intent,
      slotProfiles,
      scoreLookup,
      scoringEmbeddings,
      loadedEmbeddings!,
      request.embeddingMode,
      request.poolSize,
      request.jitter,
      request.epsilon,
      frontierDiagnostics,
      request.debug,
    );
    mark('score_and_diversify_ms');
    if (!looks.length) throw new Error('No outfits/items could be constructed.');

    this.logTiming(request, {
      stage: 'complete',
      prompt_length: String(request.prompt || '').length,
      parser_source: parserSource,
      gemini_cache_hit: !!geminiState.cacheHit,
      embedding_cache_hit: !!scoringEmbeddings.cacheHit,
      looks: looks.length,
      total_ms: Date.now() - startedAt,
      timings,
    });

    return {
      intent,
      looks,
      slot_pools: this.slotPools(candidatesBySlot as any, request, intent),
      diagnostics: {
        gemini: {
          active: geminiState.active,
          reason: geminiState.reason,
          source: geminiState.source || null,
          cache_hit: !!geminiState.cacheHit,
          retry_count: Number(geminiState.retryCount || 0),
          model: geminiState.model || request.model,
          location: geminiState.location || request.location,
          gemini_subject_kinds: Array.from(new Set(intent.semantic_subjects.map((subject) => subject.kind))),
          semantic_subject_source: geminiState.semanticSubjectSource || 'none',
          recovered_subject_kinds: geminiState.recoveredSubjectKinds || [],
          recovered_subject_confidence_summary: geminiState.recoveredSubjectConfidenceSummary || null,
        },
        embeddings: {
          active: scoringEmbeddings.active,
          mode: request.embeddingMode,
          sidecar_path: loadedEmbeddings!.sidecarPath,
          reason: scoringEmbeddings.reason,
          source: scoringEmbeddings.source || null,
          cache_hit: !!scoringEmbeddings.cacheHit,
          retry_count: Number(scoringEmbeddings.retryCount || 0),
          model: scoringEmbeddings.model || loadedEmbeddings!.model || request.embeddingModel,
          location: scoringEmbeddings.location || request.location,
          sidecar_model: loadedEmbeddings!.model,
          sidecar_schema_version: loadedEmbeddings!.schemaVersion,
          sidecar_created_at: loadedEmbeddings!.createdAt,
        },
        candidate_counts: Object.fromEntries(
          Object.entries(candidatesBySlot).map(([slot, list]) => [slot, Array.isArray(list) ? list.length : 0]),
        ),
        candidate_previews: this.candidatePreviews(candidatesBySlot as any),
        score_attribution: this.scoreAttribution(looks, parserSource, frontierDiagnostics),
      },
    };
  }
}
