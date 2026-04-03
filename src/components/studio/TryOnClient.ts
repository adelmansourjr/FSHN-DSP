// src/components/studio/TryOnClient.ts
import { TRYON_ENDPOINT } from '../../config/tryon';
import { buildJsonHeaders } from '../../lib/apiAuth';

export type TryOnRequest = {
  personB64: string;
  productB64?: string;
  productUrl?: string;
  sampleCount?: number;
};

export type TryOnResponse = {
  dataUri: string;   // data:image/jpeg;base64,...
  mimeType: string;  // image/jpeg
};

function stripDataUri(s?: string | null) {
  if (!s) return '';
  const m = String(s).match(/^data:\w+\/[\w.+-]+;base64,(.+)$/i);
  return m ? m[1] : s;
}

export async function callTryOn(req: TryOnRequest): Promise<TryOnResponse> {
  const body = {
    personB64: stripDataUri(req.personB64),
    productB64: req.productB64 ? stripDataUri(req.productB64) : undefined,
    productUrl: req.productUrl,
    count: Math.min(Math.max(req.sampleCount ?? 1, 1), 4),
    outputMimeType: 'image/jpeg', // force JPEG out
  };

  const r = await fetch(TRYON_ENDPOINT, {
    method: 'POST',
    headers: await buildJsonHeaders(),
    body: JSON.stringify(body),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json?.error || `HTTP ${r.status}`;
    throw new Error(msg);
    }

  const mime = (json?.mimeType as string) || 'image/jpeg';
  const dataUri = `data:${mime};base64,${json.image_b64}`;
  return { dataUri, mimeType: mime };
}
