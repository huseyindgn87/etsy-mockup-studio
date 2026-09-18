import { notFound } from "next/navigation";
import { isCurrentUserAdmin } from "@/lib/auth/admin";
import { listTemplates } from "@/lib/mockup/template-store";
import TemplatesAdmin from "./TemplatesAdmin";

export const dynamic = "force-dynamic";

/**
 * Calibration screen for the curated mockup template library. Reads
 * `templates/` (server-side) plus any saved `MockupTemplate` rows, then
 * hands the merged list to the client component for the drag/save loop.
 *
 * `listTemplates` hits the database — caught here so a DB hiccup (or a stale
 * Prisma client after a schema change) renders a readable in-page message
 * instead of an unhandled server exception (this app has no error.tsx).
 */
export default async function AdminTemplatesPage() {
  if (!(await isCurrentUserAdmin())) notFound();

  let templates: Awaited<ReturnType<typeof listTemplates>> = [];
  let loadError: string | null = null;
  try {
    templates = await listTemplates();
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load templates.";
  }
  return <TemplatesAdmin initialTemplates={templates} loadError={loadError} />;
}
