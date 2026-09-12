/**
 * Etsy's per-listing image rules. The per-listing cap and alt-text length
 * aren't part of the Open API v3 OpenAPI spec (`uploadListingImage` only
 * documents the request/response shape) — the cap is confirmed on Etsy's own
 * Help Center (raised from 10 to 20 in August 2025); `alt_text`'s 500-char
 * limit *is* confirmed directly in the API spec (the `uploadListingImage`
 * request param and the `ListingImage` schema both document it).
 *
 * Dependency-free so both server code (`lib/etsy/listing-images.ts`,
 * `app/api/mockups/render/route.ts`) and client UI (`app/mockups/page.tsx`)
 * can import it without pulling in server-only modules.
 */

export const MAX_LISTING_IMAGES = 20;
export const MAX_ALT_TEXT_LENGTH = 500;

export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif"] as const;

function extensionOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Format + size check for a user-uploaded photo, before it's added to the
 * grid. Returns a user-facing error message, or `null` when the file passes.
 */
export function checkImageFileBasics(file: { name: string; size: number }): string | null {
  const ext = extensionOf(file.name);
  if (!(ACCEPTED_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    return `Unsupported file type${ext ? ` ".${ext}"` : ""} — Etsy accepts ${ACCEPTED_IMAGE_EXTENSIONS.join(", ").toUpperCase()}.`;
  }
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    return `Image is ${(file.size / (1024 * 1024)).toFixed(1)} MB — Etsy's limit is ${Math.round(MAX_IMAGE_SIZE_BYTES / (1024 * 1024))} MB.`;
  }
  return null;
}
