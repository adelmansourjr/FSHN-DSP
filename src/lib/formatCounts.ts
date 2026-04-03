export function formatCompactCount(value: number | null | undefined): string {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < 1000) return String(n);

  const units = [
    { v: 1_000_000_000, s: 'b' },
    { v: 1_000_000, s: 'm' },
    { v: 1_000, s: 'k' },
  ] as const;

  for (const unit of units) {
    if (n < unit.v) continue;
    const scaled = n / unit.v;
    const shown =
      scaled >= 100
        ? Math.round(scaled).toString()
        : scaled >= 10
          ? scaled.toFixed(0)
          : scaled.toFixed(1).replace(/\.0$/, '');
    return `${shown}${unit.s}`;
  }

  return String(n);
}
