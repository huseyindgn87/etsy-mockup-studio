import { describe, expect, test } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/etsy/logout/route";

function req(fields?: Record<string, string>) {
  const init: { method: string; body?: FormData } = { method: "POST" };
  if (fields) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    init.body = form;
  }
  return new NextRequest("http://localhost/api/auth/etsy/logout", init);
}

describe("POST /api/auth/etsy/logout", () => {
  test("clears the Etsy session cookie and redirects home by default", async () => {
    const res = await POST(req());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/");
    expect(res.headers.get("set-cookie")).toMatch(/etsy_session=;/);
  });

  test("returns to /settings when asked", async () => {
    const res = await POST(req({ returnTo: "/settings" }));
    expect(res.headers.get("location")).toBe("http://localhost/settings");
  });

  test("ignores a returnTo outside the allowlist (no open redirect)", async () => {
    for (const returnTo of ["https://evil.example", "//evil.example", "/listings"]) {
      const res = await POST(req({ returnTo }));
      expect(res.headers.get("location")).toBe("http://localhost/");
    }
  });
});
