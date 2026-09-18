import { Suspense } from "react";
import { turnstileSiteKey } from "@/lib/auth/turnstile";
import LoginForm from "./LoginForm";

// The Turnstile site key is read per request, not baked in at build time.
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <div className="bg-page-gradient flex min-h-screen flex-col items-center justify-center px-6 font-sans">
      <Suspense fallback={null}>
        <LoginForm turnstileSiteKey={turnstileSiteKey()} />
      </Suspense>
    </div>
  );
}
