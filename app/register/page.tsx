"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  isValidEmail,
  isValidPassword,
  MIN_PASSWORD_LENGTH,
  REGISTRATION_ERROR_MESSAGES,
} from "@/lib/auth/validate";
import SiteFooter from "@/app/components/SiteFooter";
import PasswordInput from "@/app/components/PasswordInput";
import { APP_NAME } from "@/lib/brand";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function clientError(): string | null {
    if (!isValidEmail(email)) return "Enter a valid email address.";
    if (!isValidPassword(password)) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (password !== confirmPassword) return "Passwords don't match.";
    if (!acceptTerms) return REGISTRATION_ERROR_MESSAGES.terms_not_accepted;
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const clientErr = clientError();
    if (clientErr) {
      setError(clientErr);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, confirmPassword, acceptTerms }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === "string" ? body.error : "Could not create the account.");
        setSubmitting(false);
        return;
      }
      router.push("/login?registered=1");
    } catch {
      setError("Could not create the account. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-page-gradient flex min-h-screen flex-col font-sans">
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10">
        <main className="w-full max-w-md rounded-card border border-surface-border bg-surface p-8 shadow-soft backdrop-blur-md">
          <p className="select-none text-center text-sm font-semibold text-text">{APP_NAME}</p>

          <div className="mt-6 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-text">Create your account</h1>
            <p className="mt-2 text-sm text-text-muted">
              You&apos;ll connect your Etsy shop after signing in.
            </p>
          </div>

          {error && (
            <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-center text-sm text-red-700">
              {error}
            </p>
          )}

          <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
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
                className="mt-1 h-10 w-full rounded-lg border border-black/10 bg-white px-3 text-sm text-text outline-none focus:border-primary"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-text">
                Password
              </label>
              <PasswordInput
                id="password"
                name="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-10 w-full rounded-lg border border-black/10 bg-white px-3 text-sm text-text outline-none focus:border-primary"
              />
              <p className="mt-1 text-xs text-text-muted">At least {MIN_PASSWORD_LENGTH} characters.</p>
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-text">
                Confirm password
              </label>
              <PasswordInput
                id="confirmPassword"
                name="confirmPassword"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="h-10 w-full rounded-lg border border-black/10 bg-white px-3 text-sm text-text outline-none focus:border-primary"
              />
            </div>

            <label className="flex items-start gap-2 text-sm text-text">
              <input
                type="checkbox"
                name="acceptTerms"
                required
                checked={acceptTerms}
                onChange={(e) => setAcceptTerms(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span>
                I agree to the{" "}
                <Link href="/terms" target="_blank" className="font-medium text-primary hover:underline">
                  Terms
                </Link>{" "}
                and{" "}
                <Link href="/privacy" target="_blank" className="font-medium text-primary hover:underline">
                  Privacy Policy
                </Link>
              </span>
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="mt-2 inline-flex h-11 items-center justify-center rounded-full bg-primary px-6 text-sm font-medium text-white transition-colors hover:bg-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50"
            >
              {submitting ? "Creating account…" : "Create account"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-text-muted">
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
