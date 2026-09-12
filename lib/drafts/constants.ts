/**
 * Caps and lifetime for saved listing drafts (app/api/drafts, lib/drafts/*,
 * app/mockups/page.tsx). One place so the client's own pre-check and the
 * server's enforcement can't drift apart.
 */

/** A draft can hold at most this many uploaded PSD templates. */
export const MAX_DRAFT_PSDS = 20;

/** A draft untouched (no save) for this many days is swept — see lib/drafts/store.ts's sweepExpiredDrafts. */
export const DRAFT_TTL_DAYS = 30;
