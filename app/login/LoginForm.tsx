"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import PasswordInput from "@/app/components/PasswordInput";
import Turnstile from "@/app/components/Turnstile";
import {
  ACCOUNT_LOCKED,
  EMAIL_VERIFICATION_LOCKED,
  HUMAN_CHECK_FAILED,
  HUMAN_CHECK_REQUIRED,
  INVALID_TWO_FACTOR_CODE,
  IP_RATE_LIMITED,
  TWO_FACTOR_REQUIRED,
  parseSignInCode,
} from "@/lib/auth/two-factor-codes";
import { APP_NAME } from "@/lib/brand";

const INPUT_CLASS =
  "h-10 w-full rounded-lg border border-black/10 bg-white px-3 text-sm text-text outline-none focus:border-primary";
const SUBMIT_CLASS =
  "mt-2 inline-flex h-11 items-center justify-center rounded-full bg-primary px-6 text-sm font-medium text-white transition-colors hover:bg-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50";

type SecondFactor = { code: string } | { recoveryCode: string };

/** "at 3:42 PM (in 3 minutes)" */
function retryTime(until: Date | null): string {
  if (!until) return "later";
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  const clock = until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `at ${clock} (in ${minutes} minute${minutes === 1 ? "" : "s"})`;
}

export const EMAIL_LOCKED_MESSAGE =
  "This account is locked after too many failed sign-in attempts. It can only be unlocked by verifying by email, which isn't available yet — contact support to regain access.";

/**
 * Two steps when the account has 2FA on: email + password first; if the
 * server answers `two_factor_required`, ask for an authenticator code (or a
 * recovery code) and sign in again with both. The server re-checks the
 * password on the second attempt — nothing from step one is trusted.
 */
export default function LoginForm({ turnstileSiteKey }: { turnstileSiteKey: string | null }) {
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
  const [humanCheck, setHumanCheck] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileKey, setTurnstileKey] = useState(0);

  const justRegistered = params.get("registered") === "1";

  async function attempt(secondFactor?: SecondFactor) {
    setSubmitting(true);
    setError(null);

    const sentToken = humanCheck ? turnstileToken : null;
    const res = await signIn("credentials", {
      email,
      password,
      rememberMe,
      ...secondFactor,
      ...(sentToken ? { turnstileToken: sentToken } : {}),
      redirect: false,
    });
    setSubmitting(false);
    if (sentToken) {
      setTurnstileToken(null);
      setTurnstileKey((k) => k + 1);
    }

    const { code: resultCode, until } = parseSignInCode(res?.code);

    if (resultCode === TWO_FACTOR_REQUIRED) {
      setStep("twoFactor");
      setCode("");
      return;
    }
    if (resultCode === INVALID_TWO_FACTOR_CODE) {
      setError(
        recoveryMode
          ? "That recovery code isn't valid or has already been used."
          : "That code didn't work. Enter the current code from your authenticator app.",
      );
      return;
    }
    if (resultCode === ACCOUNT_LOCKED) {
      backToCredentials();
      setHumanCheck(true);
      setError(`Too many failed attempts. Try again ${retryTime(until)}.`);
      return;
    }
    if (resultCode === IP_RATE_LIMITED) {
      backToCredentials();
      setError(`Too many failed sign-in attempts from this network. Try again ${retryTime(until)}.`);
      return;
    }
    if (resultCode === EMAIL_VERIFICATION_LOCKED) {
      backToCredentials();
      setError(EMAIL_LOCKED_MESSAGE);
      return;
    }
    if (resultCode === HUMAN_CHECK_REQUIRED || resultCode === HUMAN_CHECK_FAILED) {
      setHumanCheck(true);
      setError(
        resultCode === HUMAN_CHECK_FAILED
          ? "The human check didn't pass. Complete it again, then retry."
          : "Complete the human check below, then try again.",
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
          Done — sign in below with your email and password.
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

          {humanCheck && turnstileSiteKey && (
            <Turnstile key={turnstileKey} siteKey={turnstileSiteKey} onToken={setTurnstileToken} />
          )}

          <button type="submit" disabled={submitting || (humanCheck && !turnstileToken)} className={SUBMIT_CLASS}>
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

          {humanCheck && turnstileSiteKey && (
            <Turnstile key={turnstileKey} siteKey={turnstileSiteKey} onToken={setTurnstileToken} />
          )}

          <button type="submit" disabled={submitting || (humanCheck && !turnstileToken)} className={SUBMIT_CLASS}>
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
