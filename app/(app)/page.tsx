import { getEtsySession } from "@/lib/etsy/auth";
import EntryCard from "./EntryCard";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  etsy_connected?: string;
  etsy_error?: string;
}>;

export default async function Home({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { etsy_connected, etsy_error } = await searchParams;

  let session = null;
  let configError: string | null = null;
  try {
    session = await getEtsySession();
  } catch (err) {
    configError = err instanceof Error ? err.message : "Configuration error.";
  }

  return (
    <div className="bg-page-gradient flex min-h-screen flex-col items-center justify-center px-6 font-sans">
      {/* Glass card, deliberately still — no `entry-card` hover sheen here. */}
      <main className="w-full max-w-md rounded-card border border-surface-border bg-surface p-8 shadow-soft backdrop-blur-md">
        {etsy_error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{etsy_error}</p>
        )}
        {etsy_connected && !etsy_error && (
          <p className="mb-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
            Connected to Etsy.
          </p>
        )}
        {configError && (
          <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {configError}
          </p>
        )}

        <EntryCard etsyConnected={!!session} />
      </main>
    </div>
  );
}
