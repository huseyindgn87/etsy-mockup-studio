import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";
import { getCurrentUser, type CurrentUser } from "@/lib/account/current-user";
import { countRemainingRecoveryCodes } from "@/lib/auth/second-factor";
import { getTwoFactorKey, TWO_FACTOR_KEY_ENV, TwoFactorKeyError } from "@/lib/auth/two-factor-key";
import { getEtsySession } from "@/lib/etsy/auth";
import { listShopConnections } from "@/lib/etsy/shop-connections";
import LogOutButton from "./LogOutButton";
import SettingsForm, { type EtsyConnectionStatus } from "./SettingsForm";
import type { TwoFactorStatus } from "./TwoFactorCard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Account settings" };

/**
 * The shop name comes from the stored `EtsyShopConnection` row matching the
 * live session — no Etsy API call just to render this page.
 */
async function etsyStatus(userId: string): Promise<EtsyConnectionStatus> {
  try {
    const session = await getEtsySession();
    if (!session) return { connected: false, shopName: null, configError: null };
    const shops = await listShopConnections(userId, session.userId);
    return {
      connected: true,
      shopName: shops.find((s) => s.active)?.shopName ?? null,
      configError: null,
    };
  } catch (err) {
    unstable_rethrow(err);
    return {
      connected: false,
      shopName: null,
      configError: err instanceof Error ? err.message : "Couldn't read the Etsy connection.",
    };
  }
}

async function twoFactorStatus(user: CurrentUser): Promise<TwoFactorStatus> {
  let configError: string | null = null;
  try {
    getTwoFactorKey();
  } catch (err) {
    if (!(err instanceof TwoFactorKeyError)) throw err;
    console.error(`[two-factor] ${err.message}`);
    configError = `Two-factor authentication isn't available yet: the server is missing a valid ${TWO_FACTOR_KEY_ENV}.`;
  }
  return {
    enabled: user.twoFactorEnabled,
    remainingRecoveryCodes: user.twoFactorEnabled ? await countRemainingRecoveryCodes(user.id) : 0,
    configError,
  };
}

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?callbackUrl=${encodeURIComponent("/settings")}`);

  const [etsy, twoFactor] = await Promise.all([etsyStatus(user.id), twoFactorStatus(user)]);

  return (
    <div className="bg-page-gradient min-h-screen font-sans">
      <div className="mx-auto w-full max-w-2xl px-6 pt-8">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text">Account settings</h1>
            <p className="mt-1 text-sm text-text-muted">
              Manage your profile, sign-in details and connected shop.
            </p>
          </div>
          <LogOutButton />
        </header>

        <SettingsForm
          user={{
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            theme: user.theme,
          }}
          etsy={etsy}
          twoFactor={twoFactor}
        />
      </div>
    </div>
  );
}
