export type JsonResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/** A JSON request to one of /api/account/*, with the server's `error` message surfaced on failure. */
export async function sendJson(url: string, method: "PATCH" | "POST", body: unknown): Promise<JsonResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: typeof json.error === "string" ? json.error : `Request failed (${res.status}).`,
      };
    }
    return { ok: true, body: json };
  } catch {
    return { ok: false, error: "Network error — try again." };
  }
}
