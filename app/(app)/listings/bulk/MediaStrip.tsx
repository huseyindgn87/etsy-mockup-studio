"use client";

import Link from "next/link";
import type { BulkListingDetail } from "./types";

/**
 * Media > Photos and Media > Videos: each listing's own images (or video)
 * laid out in a horizontal strip beneath its title.
 *
 * Read-only on purpose. Etsy's image and video endpoints upload and delete
 * whole files rather than taking an edit, so there is nothing here a "Sync
 * updates" press could write — replacing a photo is the listing editor's job,
 * and this strip links to it instead of implying an edit it can't make.
 */
export default function MediaStrip({
  listing,
  kind,
}: {
  listing: BulkListingDetail;
  kind: "photos" | "videos";
}) {
  const editorHref = `/mockups?mode=existing&listingId=${listing.listingId}&title=${encodeURIComponent(listing.title)}`;

  if (kind === "videos") {
    return (
      <div>
        {listing.videos.length === 0 ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">No video on this listing.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {listing.videos.map((video) => (
              <li
                key={video.videoId}
                className="w-28 overflow-hidden rounded-lg border border-black/10 dark:border-white/15"
              >
                {video.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={video.thumbnailUrl}
                    alt={`Video on ${listing.title}`}
                    className="h-20 w-full object-cover"
                  />
                ) : (
                  <div className="flex h-20 items-center justify-center bg-zinc-100 text-[10px] text-zinc-400 dark:bg-zinc-800">
                    video
                  </div>
                )}
                <p className="px-1.5 py-1 text-[10px] text-zinc-500">{video.state || "—"}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Videos are uploaded per listing.{" "}
          <Link href={editorHref} className="font-medium text-primary underline underline-offset-2">
            Open in the listing editor
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      {listing.images.length === 0 ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">No photos on this listing.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {listing.images.map((image) => (
            <li
              key={image.imageId}
              className="relative h-20 w-20 overflow-hidden rounded-lg border border-black/10 dark:border-white/15"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={image.altText || `Photo ${image.rank} of ${listing.title}`}
                className="h-full w-full object-cover"
              />
              <span className="absolute left-0 top-0 bg-black/60 px-1 text-[10px] text-white">
                {image.rank}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        Photos are edited per listing.{" "}
        <Link href={editorHref} className="font-medium text-primary underline underline-offset-2">
          Open in the listing editor
        </Link>{" "}
        to add or replace images.
      </p>
    </div>
  );
}
