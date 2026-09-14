import ShopButton from "./ShopButton";

/**
 * The connected-but-not-entered screen's glass card. Deliberately carries no
 * account identifiers — those live behind the header's Connected pill so a
 * seller never sees raw ids here.
 */
export default function EntryCard() {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-text">Welcome back</h1>
        <p className="mt-2 text-sm text-text-muted">
          Pick your shop below to see your listings and get back to making mockups.
        </p>
      </div>

      <div className="w-full">
        <ShopButton />
      </div>

      <form action="/api/auth/etsy/logout" method="post">
        <button
          type="submit"
          className="text-xs text-text-muted underline-offset-2 transition-colors hover:text-text hover:underline"
        >
          Disconnect
        </button>
      </form>
    </div>
  );
}
