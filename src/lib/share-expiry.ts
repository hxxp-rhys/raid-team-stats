/**
 * Share-link expiry choices, shared by every "create share link" UI so the
 * options + default stay in one place. `days = null` means the link NEVER
 * expires (the default). The numeric values map to the share-token `ttlDays`
 * and to the server clamp in `createShareToken` / `dashboard.createShareLink`.
 */
export type ShareExpiryOption = { label: string; days: number | null };

// Order matters — this is the radio display order. "Never" is the default
// selection (DEFAULT_SHARE_EXPIRY_DAYS) even though it renders last.
export const SHARE_EXPIRY_OPTIONS: ShareExpiryOption[] = [
  { label: "1 month", days: 30 },
  { label: "3 months", days: 90 },
  { label: "6 months", days: 180 },
  { label: "9 months", days: 270 },
  { label: "1 year", days: 365 },
  { label: "Never", days: null },
];

/** The default selection: the link never expires. */
export const DEFAULT_SHARE_EXPIRY_DAYS: number | null = null;

/** Human label for a chosen ttlDays (null = never). */
export function shareExpiryLabel(days: number | null): string {
  return SHARE_EXPIRY_OPTIONS.find((o) => o.days === days)?.label ?? "Never";
}
