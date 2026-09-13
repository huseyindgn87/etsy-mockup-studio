import { listTemplates } from "@/lib/mockup/template-store";
import TemplatesAdmin from "./TemplatesAdmin";

export const dynamic = "force-dynamic";

/**
 * Calibration screen for the curated mockup template library. Reads
 * `public/templates/` (server-side) plus any saved `MockupTemplate` rows, then
 * hands the merged list to the client component for the drag/save loop.
 */
export default async function AdminTemplatesPage() {
  const templates = await listTemplates();
  return <TemplatesAdmin initialTemplates={templates} />;
}
