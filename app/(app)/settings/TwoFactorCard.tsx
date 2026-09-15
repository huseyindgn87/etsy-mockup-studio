"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import PasswordInput from "@/app/components/PasswordInput";
import { RECOVERY_CODE_COUNT } from "@/lib/auth/two-factor-codes";
import { sendJson } from "./send-json";

export interface TwoFactorStatus {
  enabled: boolean;
  remainingRecoveryCodes: number;
  /** Set when the server has no usable TWO_FACTOR_ENCRYPTION_KEY. */
  configError: string | null;
}

const INPUT_CLASS =
  "h-10 w-full rounded-lg border border-black/10 bg-white px-3 text-sm text-text outline-none focus:border-primary dark:border-white/15 dark:bg-zinc-950";
const PRIMARY_BUTTON =
  "inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50";
const SECONDARY_BUTTON =
  "inline-flex h-9 items-center rounded-full border border-black/10 px-4 text-sm font-medium text-text transition-colors hover:bg-black/[.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:border-white/15 dark:hover:bg-white/[.06]";

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
      {error}
    </p>
  );
}

/**
 * /settings' two-factor card. Acts immediately (not via the page's Save):
 * enable = start setup (QR + key) → confirm a 6-digit code → show the
 * recovery codes once; disable = re-enter the account password.
 */
export default function TwoFactorCard({ status }: { status: TwoFactorStatus }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(status.enabled);
  const [remaining, setRemaining] = useState(status.remainingRecoveryCodes);
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function startSetup() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await sendJson("/api/account/two-factor/setup", "POST", {});
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setSetup({ secret: String(r.body.secret), qrDataUrl: String(r.body.qrDataUrl) });
    setCode("");
  }

  async function confirmSetup(e: FormEvent) {
    e.preventDefault();
    const value = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(value)) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await sendJson("/api/account/two-factor/enable", "POST", { code: value });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const codes = r.body.recoveryCodes as string[];
    setRecoveryCodes(codes);
    setRemaining(codes.length);
    setEnabled(true);
    setSetup(null);
    setCode("");
  }

  async function disable(e: FormEvent) {
    e.preventDefault();
    if (!password) {
      setError("Enter your password to disable two-factor authentication.");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await sendJson("/api/account/two-factor/disable", "POST", { password });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setEnabled(false);
    setPassword("");
    setNotice("Two-factor authentication is off.");
    router.refresh();
  }

  function finishRecoveryCodes() {
    setRecoveryCodes(null);
    router.refresh();
  }

  const configBanner = status.configError && (
    <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
      {status.configError}
    </p>
  );

  if (recoveryCodes) {
    return (
      <div>
        <p className="text-sm font-medium text-green-700 dark:text-green-400">
          Two-factor authentication is on.
        </p>
        <p className="mt-2 text-sm text-text">
          Save these recovery codes somewhere safe. Each one signs you in once if you lose access to
          your authenticator app. They won&apos;t be shown again.
        </p>
        <ul
          aria-label="Recovery codes"
          className="mt-3 grid grid-cols-2 gap-2 rounded-xl border border-black/10 bg-white p-4 font-mono text-sm text-text dark:border-white/15 dark:bg-zinc-950"
        >
          {recoveryCodes.map((c) => (
            <li key={c} className="select-all">
              {c}
            </li>
          ))}
        </ul>
        <button type="button" onClick={finishRecoveryCodes} className={`mt-4 ${PRIMARY_BUTTON}`}>
          I&apos;ve saved these codes
        </button>
      </div>
    );
  }

  if (setup) {
    return (
      <form onSubmit={confirmSetup} noValidate>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-text">
          <li>Scan this QR code with Google Authenticator, Authy, or another authenticator app.</li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>
        {/* eslint-disable-next-line @next/next/no-img-element -- a server-generated data: URL; next/image adds nothing here */}
        <img
          src={setup.qrDataUrl}
          alt="QR code for your authenticator app"
          width={192}
          height={192}
          className="mt-4 rounded-lg bg-white p-2"
        />
        <p className="mt-3 text-xs text-text-muted">
          Can&apos;t scan it? Enter this key manually:{" "}
          <code className="select-all break-all font-mono text-text">{setup.secret}</code>
        </p>
        <div className="mt-4 max-w-xs">
          <label htmlFor="twoFactorCode" className="block text-sm font-medium text-text">
            6-digit code
          </label>
          <input
            id="twoFactorCode"
            name="twoFactorCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={`mt-1 ${INPUT_CLASS} tracking-widest`}
          />
        </div>
        <ErrorLine error={error} />
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
            {busy ? "Verifying…" : "Verify and enable"}
          </button>
          <button
            type="button"
            onClick={() => {
              setSetup(null);
              setError(null);
            }}
            className={SECONDARY_BUTTON}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  if (enabled) {
    return (
      <form onSubmit={disable} noValidate>
        {configBanner}
        <p className="text-sm">
          <span className="text-text-muted">Status: </span>
          <span className="font-medium text-green-700 dark:text-green-400">Enabled</span>
        </p>
        <p className="mt-1 text-sm text-text-muted">
          {remaining} of {RECOVERY_CODE_COUNT} recovery codes left.
        </p>
        <div className="mt-4 max-w-sm">
          <label htmlFor="twoFactorDisablePassword" className="block text-sm font-medium text-text">
            Password
          </label>
          <PasswordInput
            id="twoFactorDisablePassword"
            name="twoFactorDisablePassword"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={INPUT_CLASS}
          />
          <p className="mt-1 text-xs text-text-muted">Required to turn two-factor authentication off.</p>
        </div>
        <ErrorLine error={error} />
        <button
          type="submit"
          disabled={busy}
          className="mt-4 inline-flex h-9 items-center rounded-full border border-red-200 px-4 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/50"
        >
          {busy ? "Disabling…" : "Disable two-factor authentication"}
        </button>
      </form>
    );
  }

  return (
    <div>
      {configBanner}
      <p className="text-sm text-text-muted">
        Add a second step to sign-in: a 6-digit code from an authenticator app such as Google
        Authenticator or Authy.
      </p>
      {notice && (
        <p role="status" className="mt-3 text-sm text-text-muted">
          {notice}
        </p>
      )}
      <ErrorLine error={error} />
      {!status.configError && (
        <button type="button" onClick={startSetup} disabled={busy} className={`mt-4 ${PRIMARY_BUTTON}`}>
          {busy ? "Starting…" : "Enable two-factor authentication"}
        </button>
      )}
    </div>
  );
}
