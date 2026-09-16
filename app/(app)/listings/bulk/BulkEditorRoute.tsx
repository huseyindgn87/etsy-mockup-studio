"use client";

import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import BulkEditor from "./BulkEditor";

/**
 * Reads the selection out of `?ids=` and hands it to {@link BulkEditor} as
 * plain numbers — the editor itself takes the ids as a prop, so it can be
 * rendered (and tested) without a router.
 */
export default function BulkEditorRoute() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("ids") ?? "";

  const listingIds = useMemo(() => {
    const seen = new Set<number>();
    for (const part of raw.split(",")) {
      const id = Number.parseInt(part.trim(), 10);
      if (Number.isInteger(id) && id > 0) seen.add(id);
    }
    return [...seen];
  }, [raw]);

  return <BulkEditor listingIds={listingIds} />;
}
