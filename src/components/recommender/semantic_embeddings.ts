import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import type { CategoryMain } from './fashion_taxonomy';

export interface EmbeddingSidecarEntry {
  id: string;
  text: string;
  vector: number[];
  identity_text?: string;
  identity_vector?: number[];
  style_text?: string;
  style_vector?: number[];
  slot_texts?: Partial<Record<CategoryMain, string>>;
  slot_vectors?: Partial<Record<CategoryMain, number[]>>;
  slot_identity_texts?: Partial<Record<CategoryMain, string>>;
  slot_identity_vectors?: Partial<Record<CategoryMain, number[]>>;
  slot_style_texts?: Partial<Record<CategoryMain, string>>;
  slot_style_vectors?: Partial<Record<CategoryMain, number[]>>;
}

export interface EmbeddingSidecar {
  model: string;
  dimensions: number | null;
  created_at: string;
  task_type: string;
  schema_version?: number;
  items: Record<string, EmbeddingSidecarEntry>;
}

export interface PersistedVectorCacheEntry {
  vector: number[];
  source: 'live';
  created_at: string;
}

interface PersistedVectorCacheFile {
  entries: Record<string, PersistedVectorCacheEntry>;
}

export function resolveEmbeddingSidecarPath(indexPath: string, override?: string | null): string {
  if (override && override.trim()) return path.resolve(override.trim());
  const resolved = path.resolve(indexPath);
  if (resolved.endsWith('.json')) return resolved.replace(/\.json$/i, '.embeddings.json');
  return `${resolved}.embeddings.json`;
}

export function resolvePromptEmbeddingCachePath(workspaceRoot: string = process.cwd()): string {
  const hash = crypto.createHash('sha1').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `testing-fhsn-prompt-embedding-cache-${hash}.json`);
}

export function resolveGeminiParseCachePath(workspaceRoot: string = process.cwd()): string {
  const hash = crypto.createHash('sha1').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `testing-fhsn-gemini-parse-cache-${hash}.json`);
}

export function loadPersistedVectorCache(cachePath: string): Record<string, PersistedVectorCacheEntry> {
  try {
    if (!fs.existsSync(cachePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as PersistedVectorCacheFile;
    return parsed?.entries || {};
  } catch {
    return {};
  }
}

export function persistVectorCache(cachePath: string, entries: Record<string, PersistedVectorCacheEntry>) {
  try {
    fs.writeFileSync(cachePath, JSON.stringify({ entries }, null, 2));
  } catch {
    // ignore cache write failures
  }
}

export function createGoogleGenAIClient(project: string, location: string): GoogleGenAI {
  return new GoogleGenAI({
    vertexai: true,
    project,
    location,
  });
}

export async function embedTexts(
  ai: GoogleGenAI,
  model: string,
  texts: string[],
  taskType: string,
  outputDimensionality?: number,
): Promise<number[][]> {
  if (!texts.length) return [];
  const response = await ai.models.embedContent({
    model,
    contents: texts,
    config: {
      taskType,
      outputDimensionality,
      autoTruncate: true,
    },
  });
  return (response.embeddings || []).map((entry) => entry.values || []);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  if (aNorm <= 0 || bNorm <= 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

export function weightedAverageVectors(vectors: Array<{ vector: number[]; weight: number }>): number[] {
  const first = vectors.find((entry) => entry.vector.length > 0);
  if (!first) return [];
  const out = new Array(first.vector.length).fill(0);
  let total = 0;
  for (const entry of vectors) {
    if (!entry.vector.length || entry.vector.length !== out.length || entry.weight <= 0) continue;
    total += entry.weight;
    for (let i = 0; i < out.length; i++) out[i] += entry.vector[i] * entry.weight;
  }
  if (total <= 0) return [];
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}
