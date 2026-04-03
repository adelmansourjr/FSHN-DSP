// src/tryon/useTryOn.ts
import { useCallback, useRef, useState } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy'; // ← FIX

// your provider (same one used previously)
import tryOnProvider from './providers/googleTryOn';

type Dims = { width: number; height: number };
type Prepared = { uri: string; mime: 'image/jpeg' | 'image/png'; width?: number; height?: number };
export type GenerateArgs = {
  selfieUri: string;
  category: string;
  baseSteps?: number;
  count?: number;
  knownSelfieDims?: Dims | null;
  productUrl?: string;
  garmentImageUri?: string;
};

const CACHE_DIR = `${FileSystem.cacheDirectory}tryon/`;
async function ensureCacheDir() { try { await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true }); } catch {} }
const hash36 = (s: string) => {
  let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
};

async function dataUriToFile(u: string): Promise<string> {
  await ensureCacheDir();
  const m = u.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!m) throw new Error('Bad data URI');
  const mime = m[1].toLowerCase();
  const b64 = m[2];
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  const name = `data_${hash36(u.slice(0, 128))}.${ext}`;
  const dest = `${CACHE_DIR}${name}`;
  const info = await FileSystem.getInfoAsync(dest);
  // ← FIX: use string encoding instead of EncodingType.Base64
  if (!info.exists) await FileSystem.writeAsStringAsync(dest, b64, { encoding: 'base64' });
  return dest;
}

async function toLocalFile(u: string): Promise<string> {
  if (!u) throw new Error('Empty uri');
  if (u.startsWith('file://') || u.startsWith('content://')) return u;
  if (u.startsWith('data:')) return dataUriToFile(u);
  if (/^https?:\/\//i.test(u)) {
    await ensureCacheDir();
    const ext =
      /\.png(?:\?|$)/i.test(u) ? 'png' :
      /\.(jpg|jpeg)(?:\?|$)/i.test(u) ? 'jpg' :
      /\.webp(?:\?|$)/i.test(u) ? 'webp' :
      /\.avif(?:\?|$)/i.test(u) ? 'avif' : 'img';
    const name = `dl_${hash36(u)}.${ext}`;
    const dest = `${CACHE_DIR}${name}`;
    const info = await FileSystem.getInfoAsync(dest);
    if (info.exists) return info.uri;
    const res = await FileSystem.downloadAsync(u, dest);
    return res.uri;
  }
  return u;
}

export default function useTryOn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ outputUri: string } | null>(null);

  const preparedSelfieRef = useRef<Prepared | null>(null);
  const preparedProductRef = useRef<Prepared | null>(null);

  const warm = useCallback(async () => {
    try { await (tryOnProvider as any)?.warm?.(); } catch {}
    try { await (tryOnProvider as any)?.preconnect?.(); } catch {}
  }, []);

  const prepareSelfie = useCallback(async (uri: string, max = 1152, known?: Dims | null) => {
    setError(null);
    try {
      const local = await toLocalFile(uri);
      const desiredFmt = ImageManipulator.SaveFormat.JPEG;
      const compress = 0.9;

      let w = known?.width ?? 0;
      let h = known?.height ?? 0;

      if (!w || !h) {
        const probe = await ImageManipulator.manipulateAsync(local, [], { compress, format: desiredFmt });
        // @ts-ignore probe has width/height
        w = (probe as any).width ?? max;
        // @ts-ignore
        h = (probe as any).height ?? max;
        const scale = Math.min(1, max / Math.max(w, h));
        const ops = scale < 1 ? [{ resize: { width: Math.round(w * scale), height: Math.round(h * scale) } }] : [];
        const out = await ImageManipulator.manipulateAsync(probe.uri, ops, { compress, format: desiredFmt });
        preparedSelfieRef.current = { uri: out.uri, mime: 'image/jpeg', width: w, height: h };
        return;
      }

      const scale = Math.min(1, max / Math.max(w, h));
      const ops = scale < 1 ? [{ resize: { width: Math.round(w * scale), height: Math.round(h * scale) } }] : [];
      const out = await ImageManipulator.manipulateAsync(local, ops, { compress, format: desiredFmt });
      preparedSelfieRef.current = { uri: out.uri, mime: 'image/jpeg', width: w, height: h };
    } catch {
      preparedSelfieRef.current = { uri, mime: 'image/jpeg' };
    }
  }, []);

  const prepareProduct = useCallback(async (uri: string, max = 1024) => {
    setError(null);
    try {
      const local = await toLocalFile(uri);
      const desiredFmt = ImageManipulator.SaveFormat.PNG;
      const compress = 1;
      const out = await ImageManipulator.manipulateAsync(local, [{ resize: { width: max } }], { compress, format: desiredFmt });
      preparedProductRef.current = { uri: out.uri, mime: 'image/png' };
    } catch {
      preparedProductRef.current = { uri, mime: 'image/png' };
    }
  }, []);

  const generate = useCallback(async (args: GenerateArgs) => {
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const selfie = preparedSelfieRef.current ?? { uri: args.selfieUri, mime: 'image/jpeg' };
      const payload: any = {
        selfieUri: selfie.uri,
        personMime: selfie.mime,
        category: args.category,
        baseSteps: args.baseSteps ?? 32,
        count: args.count ?? 1,
      };

      if (args.productUrl) {
        payload.productUrl = args.productUrl;
      } else if (args.garmentImageUri) {
        if (!preparedProductRef.current || preparedProductRef.current.uri.indexOf(args.garmentImageUri) === -1) {
          await prepareProduct(args.garmentImageUri, 1024);
        }
        payload.garmentImageUri = preparedProductRef.current!.uri;
        payload.productMime = preparedProductRef.current!.mime;
      }

      const raw = await (tryOnProvider as any)(payload);
      const r = Array.isArray(raw) ? raw[0] : raw;
      const candidate =
        r?.outputUri ?? r?.outputURL ?? r?.url ?? r?.uri ?? r?.image ?? r?.result ?? (typeof r === 'string' ? r : '');

      if (!candidate || typeof candidate !== 'string') throw new Error('No image returned from try-on provider.');
      setResult({ outputUri: candidate });
    } catch (e: any) {
      setError(String(e?.message || e || 'Try-on failed'));
    } finally {
      setBusy(false);
    }
  }, [prepareProduct]);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return {
    busy,
    error,
    result,
    warm,
    prepareSelfie,
    prepareProduct,
    generate,
    reset,
  };
}
