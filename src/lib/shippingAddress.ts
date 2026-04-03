export type ShippingAddress = {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
};

const safeString = (value: unknown) => String(value || '').trim();

export const emptyShippingAddress = (): ShippingAddress => ({
  name: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
});

export const sanitizeShippingAddress = (raw?: Partial<ShippingAddress> | null): ShippingAddress => ({
  name: safeString(raw?.name),
  line1: safeString(raw?.line1),
  line2: safeString(raw?.line2),
  city: safeString(raw?.city),
  region: safeString(raw?.region),
  postalCode: safeString(raw?.postalCode),
  country: safeString(raw?.country),
});

export const shippingAddressesEqual = (
  left?: Partial<ShippingAddress> | null,
  right?: Partial<ShippingAddress> | null
) => {
  const a = sanitizeShippingAddress(left);
  const b = sanitizeShippingAddress(right);
  return (
    a.name === b.name &&
    a.line1 === b.line1 &&
    a.line2 === b.line2 &&
    a.city === b.city &&
    a.region === b.region &&
    a.postalCode === b.postalCode &&
    a.country === b.country
  );
};

export const isShippingAddressComplete = (raw?: Partial<ShippingAddress> | null) => {
  const address = sanitizeShippingAddress(raw);
  return Boolean(
    address.name &&
      address.line1 &&
      address.city &&
      address.postalCode &&
      address.country
  );
};

export const formatShippingAddress = (raw?: Partial<ShippingAddress> | null) => {
  const address = sanitizeShippingAddress(raw);
  const line = [address.line1, address.line2].filter(Boolean).join(', ');
  const locality = [address.city, address.region, address.postalCode].filter(Boolean).join(', ');
  return [line, locality, address.country].filter(Boolean).join(' • ');
};

export const formatShippingAddressMultiline = (raw?: Partial<ShippingAddress> | null) => {
  const address = sanitizeShippingAddress(raw);
  const street = [address.line1, address.line2].filter(Boolean).join('\n');
  const locality = [address.city, address.region, address.postalCode].filter(Boolean).join(', ');
  return [street, locality, address.country].filter(Boolean).join('\n');
};
