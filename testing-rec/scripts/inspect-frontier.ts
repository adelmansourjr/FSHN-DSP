import path from 'node:path';
import { CatalogRepository, PromptParser, EmbeddingService, CandidateRanker as ModernCandidateRanker } from '../../tryon-local/reccomender/recommendation/index.ts';
import { CandidateRanker as OgCandidateRanker } from '../../tryon-local/reccomender/og_recommendation/RecommendationService.ts';

async function main() {
  const repo = new CatalogRepository();
  const parser = new PromptParser();
  const embeddingService = new EmbeddingService();
  const modern = new ModernCandidateRanker();
  const og = new OgCandidateRanker();

  const indexPath = path.resolve('tryon-local/recommender-assets/index.json');
  const embeddingPath = path.resolve('tryon-local/recommender-assets/index.embeddings.json');
  const items = repo.loadIndex(indexPath);
  const corpusStats = repo.buildCorpusStats(items);
  const embeddings = repo.loadEmbeddings(indexPath, embeddingPath, false);
  const project = process.env.RECOMMENDER_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || null;
  const prompts = process.argv.slice(2);

  for (const prompt of prompts) {
    const { intent } = await parser.resolveIntent(
      {
        prompt,
        genderPref: 'men',
        parserMode: 'auto',
        project,
        location: 'global',
        model: 'gemini-2.5-flash',
        debug: false,
      } as any,
      corpusStats,
    );
    const slotProfiles = modern.buildSlotProfiles(intent, items, corpusStats);
    const promptEmbeddings = await embeddingService.resolvePromptEmbeddings(
      {
        prompt,
        embeddingMode: 'hybrid',
        project,
        location: 'global',
        embeddingModel: 'gemini-embedding-001',
        bypassEmbeddingCache: false,
        benchmarkRateLimitMs: 0,
        debug: false,
      } as any,
      intent,
      embeddings,
      corpusStats,
    );
    const dual = og.buildCandidatesDual(items, intent as any, slotProfiles as any, 18, 36, promptEmbeddings as any, embeddings as any, false);
    const out: Record<string, unknown> = {};
    for (const slot of ['top', 'bottom', 'shoes', 'mono'] as const) {
      const symbolicIds = new Set((dual.symbolic[slot] || []).map((entry) => entry.item.id));
      const hybrid = dual.hybrid[slot] || [];
      const hybridOnly = hybrid.filter((entry) => !symbolicIds.has(entry.item.id));
      out[slot] = {
        symbolic: symbolicIds.size,
        hybrid: hybrid.length,
        hybridOnly: hybridOnly.length,
        hybridOnlyTop: hybridOnly.slice(0, 5).map((entry) => ({
          id: entry.item.id,
          sub: entry.item.sub,
          symbolic: Number((entry.symbolic || 0).toFixed(4)),
          semantic: Number((entry.semantic || 0).toFixed(4)),
          score: Number((entry.score || 0).toFixed(4)),
        })),
      };
    }
    console.log(JSON.stringify({
      prompt,
      requestedSlots: intent.requested_slots,
      vibeTags: intent.vibe_tags,
      semanticSubjects: intent.semantic_subjects.map((subject) => ({
        kind: subject.kind,
        label: subject.label,
        slots: subject.slots || [],
      })),
      out,
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
