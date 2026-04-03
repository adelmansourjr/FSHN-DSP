export type ParcelProfile = 'small_garment' | 'bulky_garment' | 'shoebox';

export const PARCEL_PROFILE_OPTIONS: ParcelProfile[] = [
  'small_garment',
  'bulky_garment',
  'shoebox',
];

const PARCEL_PROFILE_LABELS: Record<ParcelProfile, string> = {
  small_garment: 'Small Garment',
  bulky_garment: 'Bulky Garment',
  shoebox: 'Shoebox',
};

export const normalizeParcelProfile = (value?: string | null): ParcelProfile | null => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'small_garment' || raw === 'small-garment' || raw === 'small garment') {
    return 'small_garment';
  }
  if (raw === 'bulky_garment' || raw === 'bulky-garment' || raw === 'bulky garment') {
    return 'bulky_garment';
  }
  if (raw === 'shoebox' || raw === 'shoe_box' || raw === 'shoe-box' || raw === 'shoe box') {
    return 'shoebox';
  }
  return null;
};

export const formatParcelProfileLabel = (value?: string | null) => {
  const normalized = normalizeParcelProfile(value);
  return normalized ? PARCEL_PROFILE_LABELS[normalized] : '';
};

export const isParcelProfile = (value?: string | null): value is ParcelProfile =>
  Boolean(normalizeParcelProfile(value));

export type ShippingQuoteItem = {
  listingId: string;
  title: string;
  parcelProfile: ParcelProfile;
  amount: number;
  itemAmount?: number;
  unitAmount?: number;
  qty?: number;
  currency: string;
  provider: 'fixed';
  providerMode: 'fixed';
  carrier: string;
  service: string;
  displayLabel: string;
  isFallback: boolean;
  rate?: string | null;
  parcelLabel?: string | null;
};

export type ShippingQuoteResponse = {
  ok: true;
  currency: string;
  subtotalAmount: number;
  shippingAmount: number;
  totalAmount: number;
  items: ShippingQuoteItem[];
};

export type ShippingCoSandboxState = {
  trackingCode: string;
  trackingUrl: string;
  trackingPhase: 'label_created' | 'in_transit' | 'out_for_delivery' | 'delivered';
  trackingPhaseLabel: string;
};
