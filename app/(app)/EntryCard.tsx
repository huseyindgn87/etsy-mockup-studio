import ShopButton from "./ShopButton";

interface Props {
  /** Whether the signed-in account already has an Etsy shop connected. */
  etsyConnected: boolean;
}

/**
 * The home screen's glass card. Deliberately carries no account identifiers,
 * no app-name branding (that's the top bar's wordmark), and no Disconnect action — connection
 * status and Disconnect live only on /settings.
 */
export default function EntryCard({ etsyConnected }: Props) {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-text">Welcome back</h1>
        <p className="mt-2 text-sm text-text-muted">
          {etsyConnected
            ? "Pick your shop below to see your listings and get back to making mockups."
            : "Connect your Etsy shop to start making mockups for your listings."}
        </p>
      </div>

      {etsyConnected ? (
        <div className="w-full">
          <ShopButton />
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-html-link-for-pages -- an API route (redirects to Etsy's consent screen), not a page; the rule's matcher mistakes it for one because of the sibling app/api/auth/[...nextauth] catch-all.
        <a
          href="/api/auth/etsy/login"
          className="inline-flex h-11 w-full items-center justify-center rounded-full bg-primary px-6 text-sm font-medium text-white transition-colors hover:bg-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >
          Connect Etsy shop
        </a>
      )}
    </div>
  );
}
