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
      <main className="entry-card w-full max-w-md rounded-card border border-surface-border bg-surface p-8 shadow-soft backdrop-blur-md">
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

        {session ? (
          <EntryCard />
        ) : (
          <div className="flex flex-col items-center gap-6 text-center">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-text">
                Etsy Mockup Studio
              </h1>
              <p className="mt-2 text-sm text-text-muted">
                Connect your Etsy account to start making mockups for your listings.
              </p>
            </div>

            <a
              href="/api/auth/etsy/login"
              className="inline-flex h-11 items-center justify-center rounded-full bg-primary px-6 text-sm font-medium text-white transition-colors hover:bg-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            >
              Connect Etsy
            </a>
          </div>
        )}
      </main>
    </div>
  );
}
