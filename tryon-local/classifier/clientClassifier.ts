import { catalogItems, type CategoryMain, type SportMeta } from '../../data/catalog';
import { serializeListingColors } from '../../lib/listingEditor';

type EntityMeta = {
  text: string;
  weight: number;
  type: 'brand' | 'team' | 'sponsor' | 'generic';
};

type CatalogItem = (typeof catalogItems)[number] & {
  entityMeta?: EntityMeta[];
  sportMeta?: SportMeta | null;
};

type AutoFillResult = {
  category?: string;
  brand?: string;
  color?: string;
  gender?: 'men' | 'women' | 'unisex';
  tags: string[];
  source: 'catalog';
};

const CATEGORY_MAP: Record<CategoryMain, string> = {
  top: 'Top',
  bottom: 'Bottom',
  shoes: 'Shoes',
  mono: 'Dress',
};

const BRAND_RE =
  /\b(nike|adidas|puma|balenciaga|timberland|zara|gucci|prada|dior|lv|north face|patagonia|reebok|new balance|h&m|uniqlo)\b/i;

function toTitleCase(value: string) {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function fileBaseFromUri(uri: string) {
  const clean = uri.split('?')[0];
  return clean.split('/').pop() || clean;
}

function matchCatalogByFilename(filename: string): CatalogItem | null {
  const target = filename.toLowerCase();
  return (
    (catalogItems as CatalogItem[]).find((item) => {
      const id = String(item.id || '').toLowerCase();
      const imagePath = String(item.imagePath || '').toLowerCase();
      return id === target || imagePath === target || imagePath.endsWith(`/${target}`);
    }) || null
  );
}

function inferBrand(item: CatalogItem): string | null {
  const meta = item.entityMeta || [];
  const picked = meta
    .filter((m) => m.type === 'brand')
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))[0];
  if (picked?.text) return toTitleCase(picked.text);

  const entities = item.entities || [];
  const match = entities.find((e) => BRAND_RE.test(e));
  return match ? toTitleCase(match) : null;
}

function uniqStrings(list: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const val = String(raw || '').trim();
    if (!val) continue;
    const key = val.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(val);
  }
  return out;
}

export function classifyUploadPhoto(uri: string): AutoFillResult | null {
  const base = fileBaseFromUri(uri);
  const item = matchCatalogByFilename(base);
  if (!item) return null;

  const category = CATEGORY_MAP[item.category];
  const colors = (item.colours || []).map((c) => String(c));
  const vibes = (item.vibes || []).map((v) => String(v));
  const brand = inferBrand(item);
  const sport = item.sportMeta?.sport && item.sportMeta.sport !== 'none' ? item.sportMeta.sport : null;

  let tags = uniqStrings([
    ...colors,
    ...vibes,
    ...(brand ? [brand] : []),
    ...(item.sub ? [String(item.sub)] : []),
    ...(sport ? [String(sport)] : []),
  ]);

  if (!tags.length && category) {
    tags = uniqStrings([category.toLowerCase()]);
  }

  tags = tags.slice(0, 40);

  return {
    category,
    brand: brand || undefined,
    color: serializeListingColors(colors),
    gender: item.gender,
    tags,
    source: 'catalog',
  };
}
