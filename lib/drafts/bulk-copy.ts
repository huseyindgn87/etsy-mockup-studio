/**
 * "Copy" for selected listings — one saved draft per listing, seeded as a
 * copy of it.
 *
 * Nothing here talks to Etsy. A copy is a new `ListingDraft` row carrying
 * `sourceMode: "copy"` and the listing it came from, exactly like opening the
 * editor at `/mockups?mode=copy&listingId=…` and saving; the editor fills in
 * the content when the draft is opened (see app/api/etsy/listings/[id]/copy-source).
 * The live listing is never read-modified or written (see memory
 * `live-listing-never-auto-modified`).
 *
 * Server-only — pulls in Prisma.
 */

import { prisma } from "@/lib/db/prisma";

export interface CopySource {
  listingId: number;
  title: string;
}

export interface CopiedDraft {
  draftId: string;
  listingId: number;
  title: string;
}

/** Etsy titles can exceed the draft row's own title budget — same slice `PUT /api/drafts/[id]` applies. */
const MAX_DRAFT_TITLE = 200;

/**
 * Create one copy draft per listing, in the order given. Drafts belong to
 * `userId`, so a copy is only ever visible to the account that made it.
 */
export async function createCopyDrafts(
  userId: string,
  sources: CopySource[],
): Promise<CopiedDraft[]> {
  const created: CopiedDraft[] = [];
  for (const source of sources) {
    const title = (source.title || "Untitled listing").slice(0, MAX_DRAFT_TITLE);
    const row = await prisma.listingDraft.create({
      data: {
        userId,
        title,
        formData: {},
        photosData: {},
        sourceMode: "copy",
        // String, not Int — Etsy listing ids are close to Int32's ceiling
        // (see prisma/schema.prisma's `ListingDraft`).
        sourceListingId: String(source.listingId),
      },
      select: { id: true },
    });
    created.push({ draftId: row.id, listingId: source.listingId, title });
  }
  return created;
}
