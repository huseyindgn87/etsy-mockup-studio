/**
 * The account's UI theme. Exactly two choices — there is deliberately no
 * "follow the OS" option. Stored per user (`User.theme`) and rendered
 * server-side as `<html data-theme>` (app/layout.tsx). Client-safe: no
 * server imports here.
 */

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "light";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** A stored value that somehow isn't a known theme renders as the default rather than breaking the page. */
export function coerceTheme(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_THEME;
}
