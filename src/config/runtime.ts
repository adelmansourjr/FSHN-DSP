import Constants from 'expo-constants';
import { NativeModules, Platform } from 'react-native';

export function readExpoExtra() {
  return (
    Constants?.expoConfig?.extra ??
    (Constants as any)?.expoGoConfig?.extra ??
    (Constants as any)?.manifest2?.extra?.expoClient?.extra ??
    (Constants as any)?.manifest?.extra ??
    {}
  ) as Record<string, any>;
}

function extractHost(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(normalized).hostname || '';
  } catch {
    const match = normalized.match(/^(?:[^:]+:\/\/)?([^/:?#]+)(?::\d+)?/i);
    return match?.[1] || '';
  }
}

function isLoopbackHost(host: string) {
  const raw = String(host || '').trim().toLowerCase();
  return raw === 'localhost' || raw === '127.0.0.1' || raw === '0.0.0.0';
}

function isUsableLanHost(host: string) {
  const raw = String(host || '').trim().toLowerCase();
  if (!raw || isLoopbackHost(raw)) return false;
  if (raw.endsWith('.local')) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw);
}

function replaceUrlHost(rawUrl: string, host: string) {
  try {
    const parsed = new URL(rawUrl);
    parsed.hostname = host;
    return parsed.toString();
  } catch {
    return rawUrl.replace(/(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)/i, `$1${host}`);
  }
}

function resolveDebugHost() {
  const candidates = [
    (Constants.expoConfig as any)?.hostUri,
    (Constants as any)?.expoGoConfig?.hostUri,
    (Constants as any)?.expoGoConfig?.debuggerHost,
    (Constants as any)?.manifest2?.extra?.expoClient?.hostUri,
    (Constants as any)?.manifest?.debuggerHost,
    (Constants as any)?.manifest?.hostUri,
    (Constants as any)?.linkingUri,
    (Constants as any)?.experienceUrl,
    (NativeModules as any)?.SourceCode?.scriptURL,
  ];

  for (const candidate of candidates) {
    const host = extractHost(candidate);
    if (isUsableLanHost(host)) return host;
  }
  return '';
}

export function resolveDeviceUrl(rawUrl: string) {
  const url = String(rawUrl || '').trim();
  if (!url) return '';

  const currentHost = extractHost(url);
  const host = resolveDebugHost();
  if (isLoopbackHost(currentHost) && isUsableLanHost(host)) {
    return replaceUrlHost(url, host);
  }

  if (Platform.OS === 'android' && isLoopbackHost(currentHost)) {
    return replaceUrlHost(url, '10.0.2.2');
  }

  return url;
}

export function stripTrailingSlash(value: string) {
  return String(value || '').replace(/\/+$/, '');
}

export function resolveEndpointWithFallback(input: {
  explicit?: string;
  base?: string;
  path: string;
  developmentFallbackBase?: string;
}) {
  const explicit = String(input.explicit || '').trim();
  const base = stripTrailingSlash(input.base || '');
  const fallbackBase = stripTrailingSlash(input.developmentFallbackBase || '');

  if (explicit) return stripTrailingSlash(resolveDeviceUrl(explicit));
  if (base) return stripTrailingSlash(resolveDeviceUrl(`${base}${input.path}`));
  if (__DEV__ && fallbackBase) return stripTrailingSlash(resolveDeviceUrl(`${fallbackBase}${input.path}`));
  return '';
}

export function resolveBaseUrlWithFallback(input: {
  base?: string;
  explicit?: string;
  suffix?: RegExp;
  developmentFallbackBase?: string;
}) {
  const base = stripTrailingSlash(input.base || '');
  if (base) return stripTrailingSlash(resolveDeviceUrl(base));

  const explicit = String(input.explicit || '').trim();
  if (explicit) {
    return stripTrailingSlash(resolveDeviceUrl(
      stripTrailingSlash(input.suffix ? explicit.replace(input.suffix, '') : explicit),
    ));
  }

  if (__DEV__ && input.developmentFallbackBase) {
    return stripTrailingSlash(resolveDeviceUrl(stripTrailingSlash(input.developmentFallbackBase)));
  }

  return '';
}
