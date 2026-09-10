import { ETSY_ENDPOINTS, getEtsyConfig } from "./config";
import type { EtsySession } from "./session";

/** Raw token payload returned by Etsy's token endpoint. */
interface EtsyTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
}

interface EtsyErrorResponse {
  error?: string;
  error_description?: string;
}

/**
 * Build the URL to redirect the user to for consent.
 * `challenge` and `state` come from {@link createPkcePair}/{@link createState}.
 */
export function getAuthorizationUrl(challenge: string, state: string): string {
  const { clientId, redirectUri, scope } = getEtsyConfig();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${ETSY_ENDPOINTS.authorize}?${params.toString()}`;
}

/** The numeric prefix of an Etsy access token is the user id. */
function userIdFromToken(accessToken: string): string {
  return accessToken.split(".")[0] ?? "";
}

function toSession(token: EtsyTokenResponse): EtsySession {
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    // Renew a minute early to avoid racing expiry.
    expiresAt: Date.now() + (token.expires_in - 60) * 1000,
    userId: userIdFromToken(token.access_token),
  };
}

async function postToken(
  body: Record<string, string>,
): Promise<EtsyTokenResponse> {
  const res = await fetch(ETSY_ENDPOINTS.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as EtsyErrorResponse;
      detail = parsed.error_description ?? parsed.error ?? text;
    } catch {
      /* keep raw text */
    }
    throw new Error(`Etsy token request failed (${res.status}): ${detail}`);
  }
  return JSON.parse(text) as EtsyTokenResponse;
}

/** Exchange the authorization `code` from the callback for a token set. */
export async function exchangeCodeForSession(
  code: string,
  verifier: string,
): Promise<EtsySession> {
  const { clientId, redirectUri } = getEtsyConfig();
  const token = await postToken({
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
  });
  return toSession(token);
}

/** Trade a refresh token for a fresh token set. */
export async function refreshSession(
  refreshToken: string,
): Promise<EtsySession> {
  const { clientId } = getEtsyConfig();
  const token = await postToken({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  return toSession(token);
}
