import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type AppStatusTone = 'error' | 'warning' | 'info';

export type AppStatusNotice = {
  id: number;
  tone: AppStatusTone;
  title: string;
  message?: string;
  durationMs?: number;
};

type ReportErrorOptions = {
  key?: string;
  fallbackTitle?: string;
  fallbackMessage?: string;
  connectivityTitle?: string;
  connectivityMessage?: string;
  tone?: AppStatusTone;
  throttleMs?: number;
};

type AppStatusContextValue = {
  notice: AppStatusNotice | null;
  pushNotice: (notice: Omit<AppStatusNotice, 'id'>) => void;
  dismissNotice: () => void;
  reportError: (error: unknown, options?: ReportErrorOptions) => void;
};

const AppStatusContext = createContext<AppStatusContextValue>({
  notice: null,
  pushNotice: () => {},
  dismissNotice: () => {},
  reportError: () => {},
});

const CONNECTIVITY_CODE_KEYS = [
  'unavailable',
  'deadline-exceeded',
  'network-request-failed',
  'failed-precondition',
  'timeout',
  'timed-out',
  'aborted',
  'cancelled',
];

const CONNECTIVITY_MESSAGE_RE =
  /(network|offline|internet|timed?\s*out|timeout|failed to fetch|fetch failed|unable to connect|connection)/i;

const normalizeErrorPayload = (error: unknown) => {
  if (!error) return { code: '', message: '' };
  if (typeof error === 'string') return { code: '', message: error };
  const anyError = error as any;
  const code = String(anyError?.code || '').toLowerCase().trim();
  const message = String(anyError?.message || anyError?.toString?.() || '').trim();
  return { code, message };
};

export const isConnectivityError = (error: unknown) => {
  const { code, message } = normalizeErrorPayload(error);
  if (CONNECTIVITY_CODE_KEYS.some((key) => code.includes(key))) return true;
  return CONNECTIVITY_MESSAGE_RE.test(message);
};

export function AppStatusProvider({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = useState<AppStatusNotice | null>(null);
  const lastEmitRef = useRef<Record<string, number>>({});

  const pushNotice = useCallback((next: Omit<AppStatusNotice, 'id'>) => {
    setNotice({
      id: Date.now() + Math.round(Math.random() * 1000),
      ...next,
    });
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const reportError = useCallback(
    (error: unknown, options?: ReportErrorOptions) => {
      const key = String(options?.key || 'default').trim();
      const throttleMs = Math.max(2000, Number(options?.throttleMs) || 9000);
      const now = Date.now();
      const lastAt = lastEmitRef.current[key] || 0;
      if (now - lastAt < throttleMs) return;
      lastEmitRef.current[key] = now;

      const connectivity = isConnectivityError(error);
      const title = connectivity
        ? options?.connectivityTitle || 'Connection issue'
        : options?.fallbackTitle || 'Something went wrong';
      const message = connectivity
        ? options?.connectivityMessage || 'Please check your internet and try again.'
        : options?.fallbackMessage || normalizeErrorPayload(error).message || 'Please try again.';

      pushNotice({
        tone: options?.tone || (connectivity ? 'warning' : 'error'),
        title,
        message,
        durationMs: 4200,
      });
    },
    [pushNotice]
  );

  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => {
      setNotice((current) => (current?.id === notice.id ? null : current));
    }, notice.durationMs || 4200);
    return () => clearTimeout(timeout);
  }, [notice]);

  const value = useMemo(
    () => ({ notice, pushNotice, dismissNotice, reportError }),
    [dismissNotice, notice, pushNotice, reportError]
  );

  return <AppStatusContext.Provider value={value}>{children}</AppStatusContext.Provider>;
}

export const useAppStatus = () => useContext(AppStatusContext);

export default AppStatusContext;
