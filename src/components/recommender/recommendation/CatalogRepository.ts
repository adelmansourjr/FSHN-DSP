import fs from 'fs';
import path from 'path';
import { buildSemanticCorpusStats, loadCanonicalIndex, SemanticCorpusStats } from '../canonical_index';
import { CategoryMain, IndexItem, SLOT_ORDER } from '../fashion_taxonomy';
import {
  EmbeddingSidecar,
  resolveEmbeddingSidecarPath,
} from '../semantic_embeddings';
import { CatalogRepository as BaseCatalogRepository } from '../og_recommendation/RecommendationService';
import { LoadedEmbeddings } from './types';

export class CatalogRepository {
  private readonly baseRepository = new BaseCatalogRepository();

  public prepareRequest(seed: number | null): void {
    this.baseRepository.prepareRequest(seed);
  }

  public ensureCredentials(debug: boolean): void {
    this.baseRepository.ensureCredentials(debug);
  }

  public resolveProject(override?: string | null): string | null {
    return this.baseRepository.resolveProject(override);
  }

  public loadIndex(indexPath: string): IndexItem[] {
    return loadCanonicalIndex(indexPath);
  }

  public buildCorpusStats(items: IndexItem[]): SemanticCorpusStats {
    return buildSemanticCorpusStats(items);
  }

  public loadEmbeddings(indexPath: string, override: string | null, debug: boolean): LoadedEmbeddings {
    const sidecarPath = resolveEmbeddingSidecarPath(indexPath, override || undefined);
    if (!fs.existsSync(sidecarPath)) {
      if (debug) console.error('[DEBUG]', 'embedding_v2 sidecar missing', sidecarPath);
      return {
        sidecar: null,
        sidecarPath,
        model: null,
        dimensions: null,
        createdAt: null,
        schemaVersion: null,
        taskType: null,
        itemVectors: new Map(),
        identityVectors: new Map(),
        styleVectors: new Map(),
        slotVectors: { top: new Map(), bottom: new Map(), shoes: new Map(), mono: new Map() },
        slotIdentityVectors: { top: new Map(), bottom: new Map(), shoes: new Map(), mono: new Map() },
        slotStyleVectors: { top: new Map(), bottom: new Map(), shoes: new Map(), mono: new Map() },
      };
    }

    const sidecar = JSON.parse(fs.readFileSync(path.resolve(sidecarPath), 'utf8')) as EmbeddingSidecar;
    const itemVectors = new Map<string, number[]>();
    const identityVectors = new Map<string, number[]>();
    const styleVectors = new Map<string, number[]>();
    const slotVectors: Record<CategoryMain, Map<string, number[]>> = {
      top: new Map(),
      bottom: new Map(),
      shoes: new Map(),
      mono: new Map(),
    };
    const slotIdentityVectors: Record<CategoryMain, Map<string, number[]>> = {
      top: new Map(),
      bottom: new Map(),
      shoes: new Map(),
      mono: new Map(),
    };
    const slotStyleVectors: Record<CategoryMain, Map<string, number[]>> = {
      top: new Map(),
      bottom: new Map(),
      shoes: new Map(),
      mono: new Map(),
    };

    for (const entry of Object.values(sidecar.items || {})) {
      if (entry.vector?.length) itemVectors.set(entry.id, entry.vector);
      if (entry.identity_vector?.length) identityVectors.set(entry.id, entry.identity_vector);
      if (entry.style_vector?.length) styleVectors.set(entry.id, entry.style_vector);
      for (const slot of SLOT_ORDER) {
        const slotVector = entry.slot_vectors?.[slot];
        const slotIdentityVector = entry.slot_identity_vectors?.[slot];
        const slotStyleVector = entry.slot_style_vectors?.[slot];
        if (slotVector?.length) slotVectors[slot].set(entry.id, slotVector);
        if (slotIdentityVector?.length) slotIdentityVectors[slot].set(entry.id, slotIdentityVector);
        if (slotStyleVector?.length) slotStyleVectors[slot].set(entry.id, slotStyleVector);
      }
    }

    return {
      sidecar,
      sidecarPath,
      model: sidecar.model || null,
      dimensions: Number.isFinite(sidecar.dimensions as number) ? Number(sidecar.dimensions) : null,
      createdAt: sidecar.created_at || null,
      schemaVersion: Number.isFinite(sidecar.schema_version as number) ? Number(sidecar.schema_version) : null,
      taskType: sidecar.task_type || null,
      itemVectors,
      identityVectors,
      styleVectors,
      slotVectors,
      slotIdentityVectors,
      slotStyleVectors,
    };
  }
}
