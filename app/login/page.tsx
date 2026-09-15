"use client";

import Link from "next/link";
import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import PasswordInput from "@/app/components/PasswordInput";
import { INVALID_TWO_FACTOR_CODE, TWO_FACTOR_REQUIRED } from "@/lib/auth/two-factor-codes";
import { APP_NAME } from "@/lib/brand";

const INPUT_CLASS =
  "h-10 w-full rounded-lg border border-black/10 bg-white px-3 text-sm text-text outline-none focus:border-primary";
const SUBMIT_CLASS =
  "mt-2 inline-flex h-11 items-center justify-center rounded-full bg-primary px-6 text-sm font-medium text-white transition-colors hover:bg-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50";

type SecondFactor = { code: string } | { recoveryCode: string };

/**
 * Two steps when the account has 2FA on: email + password first; if the
 * server answers `two_factor_required`, ask for an authenticator code (or a
 * recovery code) and sign in again with both. The server re-checks the
 * password on the second attempt — nothing from step one is trusted.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [step, setStep] = useState<"credentials" | "twoFactor">("credentials");
  const [code, setCode] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const justRegistered = params.get("registered") === "1";

  async function attempt(secondFactor?: SecondFactor) {
    setSubmitting(true);
    setError(null);

    const res = await signIn("credentials", { email, password, rememberMe, ...secondFactor, redirect: false });
    setSubmitting(false);

    if (res?.code === TWO_FACTOR_REQUIRED) {
      setStep("twoFactor");
      setCode("");
      return;
    }
    if (res?.code === INVALID_TWO_FACTOR_CODE) {
      setError(
        recoveryMode
          ? "That recovery code isn't valid or has already been used."
          : "That code didn't work. Enter the current code from your authenticator app.",
      );
      return;
    }
    if (!res || res.error) {
      if (res?.error && res.error !== "CredentialsSignin") {
        setError("Sign-in isn't available right now. Try again later.");
        return;
      }
      setStep("credentials");
      setError("Incorrect email or password.");
      return;
    }

    router.push(params.get("callbackUrl") || "/");
    router.refresh();
  }

  function handleCredentials(e: FormEvent) {
    e.preventDefault();
    attempt();
  }

  function handleSecondFactor(e: FormEvent) {
    e.preventDefault();
    const value = code.trim();
    if (!value) {
      setError(recoveryMode ? "Enter one of your recovery codes." : "Enter the 6-digit code.");
      return;
    }
    attempt(recoveryMode ? { recoveryCode: value } : { code: value.replace(/\s+/g, "") });
  }

  function backToCredentials() {
    setStep("credentials");
    setPassword("");
    setCode("");
    setRecoveryMode(false);
    setError(null);
  }

  return (
    <main className="w-full max-w-md rounded-card border border-surface-border bg-surface p-8 shadow-soft backdrop-blur-md">
      <p className="select-none text-center text-sm font-semibold text-text">{APP_NAME}</p>

      {step === "credentials" ? (
        <div className="mt-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-text">Sign in</h1>
          <p className="mt-2 text-sm text-text-muted">Welcome back — sign in to your account.</p>
        </div>
      ) : (
        <div className="mt-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-text">Two-factor authentication</h1>
          <p className="mt-2 text-sm text-text-muted">
            {recoveryMode
              ? "Enter one of the recovery codes you saved when you turned on two-factor authentication."
              : "Enter the 6-digit code from your authenticator app."}
          </p>
        </div>
      )}

      {justRegistered && step === "credentials" && (
        <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-center text-sm text-green-700">
          Account created — sign in below.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-center text-sm text-red-700">
          {error}
        </p>
      )}

      {step === "credentials" ? (
        <form onSubmit={handleCredentials} className="mt-6 flex flex-col gap-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-text">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`mt-1 ${INPUT_CLASS}`}
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-text">
              Password
            </label>
            <PasswordInput
              id="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={INPUT_CLASS}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-text-muted">
            <input
              id="rememberMe"
              name="rememberMe"
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Keep me signed in
          </label>

          <button type="submit" disabled={submitting} className={SUBMIT_CLASS}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleSecondFactor} noValidate className="mt-6 flex flex-col gap-4">
          <div>
            <label htmlFor="twoFactorCode" className="block text-sm font-medium text-text">
              {recoveryMode ? "Recovery code" : "Authentication code"}
            </label>
            <input
              key={recoveryMode ? "recovery" : "totp"}
              id="twoFactorCode"
              name="twoFactorCode"
              autoFocus
              autoComplete={recoveryMode ? "off" : "one-time-code"}
              inputMode={recoveryMode ? "text" : "numeric"}
              maxLength={recoveryMode ? 11 : 6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={`mt-1 ${INPUT_CLASS} tracking-widest`}
            />
          </div>

          <button type="submit" disabled={submitting} className={SUBMIT_CLASS}>
            {submitting ? "Verifying…" : "Verify"}
          </button>

          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={() => {
                setRecoveryMode((v) => !v);
                setCode("");
                setError(null);
              }}
              className="font-medium text-primary hover:underline"
            >
              {recoveryMode ? "Use your authenticator app instead" : "Use a recovery code instead"}
            </button>
            <button type="button" onClick={backToCredentials} className="text-text-muted hover:text-text">
              Back
            </button>
          </div>
        </form>
      )}

      {step === "credentials" && (
        <p className="mt-6 text-center text-sm text-text-muted">
          Don&apos;t have an account?{" "}
          <Link href="/register" className="font-medium text-primary hover:underline">
            Create one
          </Link>
        </p>
      )}
    </main>
  );
}

export default function LoginPage() {
  return (
    <div className="bg-page-gradient flex min-h-screen flex-col items-center justify-center px-6 font-sans">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
