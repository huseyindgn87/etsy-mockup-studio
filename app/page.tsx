import { getEtsySession } from "@/lib/etsy/auth";

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
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6 font-sans dark:bg-black">
      <main className="w-full max-w-md rounded-2xl border border-black/[.08] bg-white p-8 dark:border-white/[.145] dark:bg-zinc-950">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Etsy Mockup Studio
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Connect your Etsy account to get started.
        </p>

        {etsy_error && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
            {etsy_error}
          </p>
        )}
        {etsy_connected && !etsy_error && (
          <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950/50 dark:text-green-300">
            Connected to Etsy.
          </p>
        )}
        {configError && (
          <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
            {configError}
          </p>
        )}

        <div className="mt-6">
          {session ? (
            <div className="flex flex-col gap-3">
              <div className="text-sm text-zinc-700 dark:text-zinc-300">
                Etsy user id:{" "}
                <span className="font-mono">{session.userId}</span>
                <br />
                Access token expires:{" "}
                <span className="font-mono">
                  {new Date(session.expiresAt).toLocaleTimeString()}
                </span>
              </div>
              <form action="/api/auth/etsy/logout" method="post">
                <button
                  type="submit"
                  className="h-10 rounded-full border border-black/[.08] px-5 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-white/[.06]"
                >
                  Disconnect
                </button>
              </form>
            </div>
          ) : (
            <a
              href="/api/auth/etsy/login"
              className="inline-flex h-10 items-center justify-center rounded-full bg-[#f56400] px-5 text-sm font-medium text-white transition-colors hover:bg-[#d95700]"
            >
              Connect Etsy
            </a>
          )}
        </div>
      </main>
    </div>
  );
}
