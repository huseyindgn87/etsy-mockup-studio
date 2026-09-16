/**
 * Which link clicks the unsaved-changes guard holds back. Only a plain
 * left-click that would navigate this tab to another page of this app is
 * held; new-tab/window clicks, downloads, other sites and same-page hash
 * links pass straight through (leaving the site in this tab is caught by
 * `beforeunload` instead).
 */

export interface LinkClick {
  /** The anchor's resolved (absolute) `href`. */
  href: string;
  target: string;
  download: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** `window.location.href` at the time of the click. */
  currentHref: string;
}

/** The in-app path the click would navigate to, or `null` when it isn't held. */
export function interceptedDestination(click: LinkClick): string | null {
  if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (click.download) return null;
  if (click.target && click.target !== "_self") return null;

  let to: URL;
  let from: URL;
  try {
    from = new URL(click.currentHref);
    to = new URL(click.href, from);
  } catch {
    return null;
  }
  if (to.origin !== from.origin) return null;
  if (to.pathname === from.pathname && to.search === from.search) return null;
  return `${to.pathname}${to.search}${to.hash}`;
}

export function unsavedChangesMessage(count: number): string {
  return count === 1
    ? "1 listing has unsaved changes. Leave and discard them?"
    : `${count} listings have unsaved changes. Leave and discard them?`;
}
