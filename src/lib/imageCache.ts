import { Image as ExpoImage } from 'expo-image';

type WarmCacheOptions = {
  cachePolicy?: 'disk' | 'memory' | 'memory-disk';
  chunkSize?: number;
  force?: boolean;
};

const warmedUris = new Set<string>();
const inFlightUris = new Set<string>();

const toUri = (value: unknown): string => String(value || '').trim();

const shouldCacheUri = (uri: string) => {
  if (!uri) return false;
  if (uri.startsWith('data:')) return false;
  if (uri.startsWith('blob:')) return false;
  return true;
};

const uniqueUris = (values: Array<string | null | undefined>) => {
  const seen = new Set<string>();
  const out: string[] = [];
  values.forEach((value) => {
    const uri = toUri(value);
    if (!shouldCacheUri(uri)) return;
    if (seen.has(uri)) return;
    seen.add(uri);
    out.push(uri);
  });
  return out;
};

const chunk = (values: string[], size: number) => {
  const out: string[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
};

export const getImageCacheStats = () => ({
  warmed: warmedUris.size,
  inFlight: inFlightUris.size,
});

export async function warmImageCache(
  values: Array<string | null | undefined>,
  options: WarmCacheOptions = {}
) {
  const cachePolicy = options.cachePolicy ?? 'memory-disk';
  const chunkSize = Math.max(1, Math.min(40, Math.round(options.chunkSize ?? 16)));
  const unique = uniqueUris(values);
  const pending = unique.filter((uri) =>
    options.force ? !inFlightUris.has(uri) : !warmedUris.has(uri) && !inFlightUris.has(uri)
  );
  if (!pending.length) {
    return { queued: 0, warmed: warmedUris.size };
  }

  pending.forEach((uri) => inFlightUris.add(uri));
  const batches = chunk(pending, chunkSize);
  for (const batch of batches) {
    try {
      const ok = await ExpoImage.prefetch(batch, { cachePolicy });
      if (ok) {
        batch.forEach((uri) => warmedUris.add(uri));
      }
    } catch (error) {
      // Keep failures soft so UI can still render and fallback to normal image loading.
      console.warn('[imageCache] prefetch failed', error);
    } finally {
      batch.forEach((uri) => inFlightUris.delete(uri));
    }
  }

  return { queued: pending.length, warmed: warmedUris.size };
}

