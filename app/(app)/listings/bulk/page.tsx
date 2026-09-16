import type { Metadata } from "next";
import { Suspense } from "react";
import BulkEditorRoute from "./BulkEditorRoute";

export const metadata: Metadata = { title: "Bulk edit" };

/**
 * `/listings/bulk` — edits the listings selected on the listings table, each
 * one individually, saving every change in a single explicit action.
 *
 * The selection arrives as `?ids=`; the Suspense boundary is what Next
 * requires around the `useSearchParams` that reads it.
 */
export default function BulkEditPage() {
  return (
    <Suspense fallback={<div className="px-6 py-8 text-sm text-zinc-500">Loading…</div>}>
      <BulkEditorRoute />
    </Suspense>
  );
}
