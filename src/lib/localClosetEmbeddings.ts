import { RECOMMENDER_BASE_URL } from '../config/recommender';
import type { LocalClosetEmbedding, LocalClosetItem } from './localCloset';
import { buildJsonHeaders } from './apiAuth';

type ClosetEmbeddingResponse = {
  ok?: boolean;
  embedding?: {
    model?: string | null;
    slot?: 'top' | 'bottom' | 'mono' | 'shoes' | null;
    vector?: number[];
    text?: string | null;
  } | null;
};

function normalizeClosetCategoryToSlot(value?: string | null): 'top' | 'bottom' | 'mono' | 'shoes' | null {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes('top')) return 'top';
  if (raw.includes('bottom')) return 'bottom';
  if (raw.includes('mono') || raw.includes('dress')) return 'mono';
  if (
    raw.includes('shoe') ||
    raw.includes('footwear') ||
    raw.includes('sneaker') ||
    raw.includes('boot') ||
    raw.includes('heel')
  ) return 'shoes';
  return null;
}

function endpointUrl() {
  const base = String(RECOMMENDER_BASE_URL || '').trim().replace(/\/+$/, '');
  return base ? `${base}/embed-closet-item` : '';
}

export async function embedLocalClosetItem(item: Pick<LocalClosetItem, 'id' | 'category' | 'brand' | 'color' | 'tags'>): Promise<LocalClosetEmbedding | null> {
  const endpoint = endpointUrl();
  const slot = normalizeClosetCategoryToSlot(item.category);
  if (!endpoint || !slot) return null;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: await buildJsonHeaders(),
    body: JSON.stringify({
      item: {
        id: item.id,
        category: slot,
        brand: item.brand || null,
        color: item.color || null,
        tags: Array.isArray(item.tags) ? item.tags : [],
      },
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(extractErrorMessage(text) ?? `Closet embedding request failed (${res.status})`);
  }
  const json = safeJsonParse(text) as ClosetEmbeddingResponse | null;
  const vector = Array.isArray(json?.embedding?.vector)
    ? json!.embedding!.vector!.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  if (!vector.length) return null;
  return {
    model: String(json?.embedding?.model || '').trim() || null,
    updatedAt: Date.now(),
    slot,
    vector,
    text: String(json?.embedding?.text || '').trim() || null,
  };
}

function safeJsonParse(value: string) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractErrorMessage(payload: string) {
  try {
    const parsed = JSON.parse(payload);
    return parsed?.error || parsed?.message || null;
  } catch {
    return null;
  }
}
