// src/data/sheetCsv.ts
export type CsvRow = Record<string, string>;

const CSV_CACHE: Record<string, CsvRow[]> = {};

export async function fetchCsv(url: string): Promise<CsvRow[]> {
  if (!url) return [];
  if (CSV_CACHE[url]) return CSV_CACHE[url];
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const text = await res.text();
    const rows = parseCsv(text);
    CSV_CACHE[url] = rows;
    return rows;
  } catch {
    return [];
  }
}

function parseCsv(data: string): CsvRow[] {
  const lines = data.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: CsvRow = {};
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = (cells[i] ?? '').trim();
    }
    return row;
  });
}

export function parseBool(value: any): boolean {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized !== '' && normalized !== 'false' && normalized !== '0' && normalized !== 'no';
  }
  return Boolean(value);
}

export function parseNum(value: any): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
