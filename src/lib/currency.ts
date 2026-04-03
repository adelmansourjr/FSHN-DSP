export const GBP_SYMBOL = '£';

const NUMERIC_PATTERN = /^\d+(?:\.\d+)?$/;

export function toGBPPriceLabel(value?: string | number | null): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const normalized = Math.max(0, value);
    if (Number.isInteger(normalized)) return `${GBP_SYMBOL}${normalized}`;
    return `${GBP_SYMBOL}${normalized.toFixed(2)}`;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  if (NUMERIC_PATTERN.test(raw)) {
    return `${GBP_SYMBOL}${raw}`;
  }

  const prefixed = raw.match(/^[£$]\s*(.+)$/);
  if (prefixed?.[1]) {
    return `${GBP_SYMBOL}${prefixed[1]}`;
  }

  return raw;
}

