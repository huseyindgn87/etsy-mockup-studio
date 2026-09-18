/**
 * Cloudflare Turnstile — the human check required on an account's sign-in
 * attempts after its first lock (lib/auth/throttle.ts). Real keys come from
 * TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY; outside production, Cloudflare's
 * always-pass test keys stand in. In production without keys, no check can
 * pass, so a once-locked account can't sign in until they're set.
 */

export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_TEST_SECRET_KEY = "1x0000000000000000000000000000000AA";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function testKeysAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function turnstileSiteKey(): string | null {
  return process.env.TURNSTILE_SITE_KEY?.trim() || (testKeysAllowed() ? TURNSTILE_TEST_SITE_KEY : null);
}

function turnstileSecretKey(): string | null {
  return process.env.TURNSTILE_SECRET_KEY?.trim() || (testKeysAllowed() ? TURNSTILE_TEST_SECRET_KEY : null);
}

export async function verifyTurnstile(
  token: string,
  ip: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const secret = turnstileSecretKey();
  if (!secret) {
    console.error("TURNSTILE_SECRET_KEY is not set — the sign-in human check can't be verified.");
    return false;
  }
  if (!token) return false;

  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== "unknown") body.set("remoteip", ip);
  try {
    const res = await fetchImpl(SITEVERIFY_URL, { method: "POST", body });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: unknown };
    return data.success === true;
  } catch {
    return false;
  }
}
