/**
 * Etsy's own listing-video requirements (help.etsy.com/hc/en-us/articles/
 * 360053206073-How-to-Add-Listing-Videos, confirmed against the live page):
 * up to 2 videos per listing, most common formats, max 100 MB each, 3-15
 * seconds long, no audio (Etsy strips it on upload). Checked client-side
 * before upload so a bad file never reaches Etsy's API; the server re-checks
 * format/size as a defense-in-depth measure since duration can't be read
 * without decoding the file.
 */

export const MAX_LISTING_VIDEOS = 2;
export const MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024;
export const MIN_VIDEO_DURATION_SECONDS = 3;
export const MAX_VIDEO_DURATION_SECONDS = 15;
export const ACCEPTED_VIDEO_EXTENSIONS = [
  "mp4",
  "mov",
  "flv",
  "aac",
  "avi",
  "3gp",
  "mpeg",
  "mpg",
] as const;

function extensionOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Format + size only — checks that don't require decoding the file. Returns
 * a user-facing error message, or `null` when the file passes.
 */
export function checkVideoFileBasics(file: { name: string; size: number }): string | null {
  const ext = extensionOf(file.name);
  if (!(ACCEPTED_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
    return `Unsupported file type${ext ? ` ".${ext}"` : ""} — Etsy accepts ${ACCEPTED_VIDEO_EXTENSIONS.join(", ").toUpperCase()}.`;
  }
  if (file.size > MAX_VIDEO_SIZE_BYTES) {
    return `Video is ${(file.size / (1024 * 1024)).toFixed(1)} MB — Etsy's limit is ${Math.round(MAX_VIDEO_SIZE_BYTES / (1024 * 1024))} MB.`;
  }
  return null;
}

/**
 * Duration check, given a duration in seconds probed from the file (e.g. via
 * an `HTMLVideoElement`'s `loadedmetadata` event — that probing only works in
 * a browser, so it lives in the UI, not here). A non-finite or non-positive
 * duration means it couldn't be read (an unsupported codec for browser
 * preview, say) — that's not treated as a failure since Etsy is still the
 * final check.
 */
export function checkVideoDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < MIN_VIDEO_DURATION_SECONDS || seconds > MAX_VIDEO_DURATION_SECONDS) {
    return `Video is ${seconds.toFixed(1)}s long — Etsy requires ${MIN_VIDEO_DURATION_SECONDS}-${MAX_VIDEO_DURATION_SECONDS} seconds.`;
  }
  return null;
}
