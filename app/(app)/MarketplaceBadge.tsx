const MARKETPLACES = {
  etsy: { label: "Etsy", dot: "#F56400" },
} as const;

export type Marketplace = keyof typeof MARKETPLACES;

/**
 * Tiny per-marketplace identifier. The app's chrome is marketplace-agnostic —
 * this badge is the one place a marketplace's own brand color is allowed to
 * appear, so future marketplaces (Walmart, Amazon, ...) slot into the map
 * above without touching any shared UI color.
 */
export default function MarketplaceBadge({ marketplace }: { marketplace: Marketplace }) {
  const { label, dot } = MARKETPLACES[marketplace];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-surface-border bg-surface px-2.5 py-1 text-xs font-medium text-text-muted">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dot }} />
      {label}
    </span>
  );
}
