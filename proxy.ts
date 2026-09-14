import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { decideRouteAccess } from "@/lib/auth/route-guard";

/**
 * Gates every app route behind the app-account session. Named `proxy.ts`,
 * not `middleware.ts` — this Next.js version deprecated and renamed the
 * convention (see node_modules/next/dist/docs/.../file-conventions/proxy.md).
 * The actual public/private routing decision lives in
 * lib/auth/route-guard.ts, kept separate so it's unit-testable on its own.
 */
export default auth((req) => {
  const decision = decideRouteAccess(req.nextUrl.pathname, !!req.auth);

  switch (decision.action) {
    case "next":
      return NextResponse.next();
    case "unauthorized":
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    case "redirect":
      return NextResponse.redirect(new URL(decision.path, req.nextUrl.origin));
  }
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
