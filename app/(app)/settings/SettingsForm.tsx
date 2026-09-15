"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import PasswordInput from "@/app/components/PasswordInput";
import { THEMES, type Theme } from "@/lib/account/theme";
import {
  isValidEmail,
  isValidPassword,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
} from "@/lib/auth/validate";
import LogOutButton from "./LogOutButton";
import { sendJson } from "./send-json";
import TwoFactorCard, { type TwoFactorStatus } from "./TwoFactorCard";

export interface SettingsUser {
  email: string;
  firstName: string | null;
  lastName: string | null;
  theme: Theme;
}

export interface EtsyConnectionStatus {
  connected: boolean;
  /** The active shop's stored name; null when not connected or not recorded. */
  shopName: string | null;
  /** Set when Etsy isn't configured on the server (missing env vars). */
  configError: string | null;
}

interface Props {
  user: SettingsUser;
  etsy: EtsyConnectionStatus;
  twoFactor: TwoFactorStatus;
}

type Section = "appearance" | "contact" | "email" | "password";
interface Notice {
  kind: "error" | "success" | "info";
  text: string;
}

const FORM_ID = "account-settings-form";
const THEME_LABELS: Record<Theme, string> = { light: "Light", dark: "Dark" };
const INPUT_CLASS =
  "h-10 w-full rounded-lg border border-black/10 bg-white px-3 text-sm text-text outline-none focus:border-primary dark:border-white/15 dark:bg-zinc-950";
const LABEL_CLASS = "block text-sm font-medium text-text";

function SettingsCard({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-card border border-surface-border bg-surface p-6 shadow-soft backdrop-blur-md"
    >
      <h2 id={id} className="text-base font-semibold text-text">
        {title}
      </h2>
      {description && <p className="mt-1 text-sm text-text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function NoticeLine({ notice }: { notice: Notice | null | undefined }) {
  if (!notice) return null;
  const tone =
    notice.kind === "error"
      ? "text-red-700 dark:text-red-400"
      : notice.kind === "success"
        ? "text-green-700 dark:text-green-400"
        : "text-text-muted";
  return (
    <p role={notice.kind === "error" ? "alert" : "status"} className={`mt-3 text-sm ${tone}`}>
      {notice.text}
    </p>
  );
}

/**
 * /settings' editable cards. Appearance, contact, email and password are
 * saved together by the sticky footer's Save button — each only when it has
 * actually changed, via its own endpoint, with per-card results. The Etsy
 * connection and two-factor cards act immediately (their own forms, outside
 * this one).
 */
export default function SettingsForm({ user, etsy, twoFactor }: Props) {
  const router = useRouter();

  const [saved, setSaved] = useState<SettingsUser>(user);
  const [theme, setTheme] = useState<Theme>(user.theme);
  const [firstName, setFirstName] = useState(user.firstName ?? "");
  const [lastName, setLastName] = useState(user.lastName ?? "");
  const [email, setEmail] = useState(user.email);
  const [emailPassword, setEmailPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");

  const [notices, setNotices] = useState<Partial<Record<Section, Notice>>>({});
  const [footer, setFooter] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);

  const themeDirty = theme !== saved.theme;
  const namesDirty =
    firstName.trim() !== (saved.firstName ?? "") || lastName.trim() !== (saved.lastName ?? "");
  const emailDirty = normalizeEmail(email) !== saved.email;
  const passwordDirty = !!(currentPassword || newPassword || confirmNewPassword);

  async function saveProfile(next: Partial<Record<Section, Notice>>): Promise<Partial<SettingsUser>> {
    const r = await sendJson("/api/account/profile", "PATCH", { firstName, lastName, theme });
    if (!r.ok) {
      if (themeDirty) next.appearance = { kind: "error", text: r.error };
      if (namesDirty) next.contact = { kind: "error", text: r.error };
      return {};
    }
    if (themeDirty) {
      // Immediate feedback; the router.refresh() after saving re-renders the
      // root layout's server-side data-theme with the same value.
      document.documentElement.dataset.theme = theme;
      next.appearance = { kind: "success", text: `${THEME_LABELS[theme]} theme saved.` };
    }
    if (namesDirty) next.contact = { kind: "success", text: "Name saved." };
    return { theme, firstName: firstName.trim() || null, lastName: lastName.trim() || null };
  }

  async function saveEmail(next: Partial<Record<Section, Notice>>): Promise<Partial<SettingsUser>> {
    if (!isValidEmail(normalizeEmail(email))) {
      next.email = { kind: "error", text: "Enter a valid email address." };
      return {};
    }
    if (!emailPassword) {
      next.email = { kind: "error", text: "Enter your current password to change your email." };
      return {};
    }
    const r = await sendJson("/api/account/email", "POST", {
      newEmail: email,
      currentPassword: emailPassword,
    });
    if (!r.ok) {
      next.email = { kind: "error", text: r.error };
      return {};
    }
    const updated = String(r.body.email);
    setEmail(updated);
    setEmailPassword("");
    next.email = { kind: "success", text: "Email updated." };
    return { email: updated };
  }

  async function savePassword(next: Partial<Record<Section, Notice>>): Promise<void> {
    let error: string | null = null;
    if (!currentPassword) error = "Enter your current password.";
    else if (!isValidPassword(newPassword))
      error = `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    else if (newPassword !== confirmNewPassword) error = "New passwords don't match.";
    if (error) {
      next.password = { kind: "error", text: error };
      return;
    }

    const r = await sendJson("/api/account/password", "POST", {
      currentPassword,
      newPassword,
      confirmPassword: confirmNewPassword,
    });
    if (!r.ok) {
      next.password = { kind: "error", text: r.error };
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmNewPassword("");
    next.password = { kind: "success", text: "Password updated." };
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!themeDirty && !namesDirty && !emailDirty && !passwordDirty) {
      setNotices({});
      setFooter({ kind: "info", text: "No changes to save." });
      return;
    }

    setSaving(true);
    setFooter(null);
    const next: Partial<Record<Section, Notice>> = {};
    let updates: Partial<SettingsUser> = {};

    if (themeDirty || namesDirty) updates = { ...updates, ...(await saveProfile(next)) };
    if (emailDirty) updates = { ...updates, ...(await saveEmail(next)) };
    if (passwordDirty) await savePassword(next);

    setSaved((s) => ({ ...s, ...updates }));
    setNotices(next);
    setSaving(false);

    const failed = Object.values(next).some((n) => n?.kind === "error");
    setFooter(
      failed
        ? { kind: "error", text: "Some changes weren't saved — see the messages above." }
        : { kind: "success", text: "All changes saved." },
    );
    if (Object.keys(updates).length > 0) router.refresh();
  }

  return (
    <div className="mt-6">
      <form id={FORM_ID} onSubmit={handleSave} noValidate className="flex flex-col gap-6">
        <SettingsCard id="settings-appearance" title="Appearance">
          <fieldset>
            <legend className="sr-only">Theme</legend>
            <div className="grid grid-cols-2 gap-3">
              {THEMES.map((value) => (
                <label
                  key={value}
                  className={`flex cursor-pointer items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium text-text transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
                    theme === value
                      ? "border-primary bg-primary/10"
                      : "border-black/10 hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
                  }`}
                >
                  <input
                    type="radio"
                    name="theme"
                    value={value}
                    checked={theme === value}
                    onChange={() => setTheme(value)}
                    className="h-4 w-4 accent-primary"
                  />
                  {THEME_LABELS[value]}
                </label>
              ))}
            </div>
          </fieldset>
          <NoticeLine notice={notices.appearance} />
        </SettingsCard>

        <SettingsCard id="settings-contact" title="Contact information">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="firstName" className={LABEL_CLASS}>
                First name
              </label>
              <input
                id="firstName"
                name="firstName"
                autoComplete="given-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className={`mt-1 ${INPUT_CLASS}`}
              />
            </div>
            <div>
              <label htmlFor="lastName" className={LABEL_CLASS}>
                Last name
              </label>
              <input
                id="lastName"
                name="lastName"
                autoComplete="family-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className={`mt-1 ${INPUT_CLASS}`}
              />
            </div>
          </div>
          <NoticeLine notice={notices.contact} />
        </SettingsCard>

        <SettingsCard
          id="settings-email"
          title="Email"
          description={`You sign in with ${saved.email}.`}
        >
          <div className="flex flex-col gap-4">
            <div>
              <label htmlFor="email" className={LABEL_CLASS}>
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`mt-1 ${INPUT_CLASS}`}
              />
            </div>
            {emailDirty && (
              <div>
                <label htmlFor="emailCurrentPassword" className={LABEL_CLASS}>
                  Current password
                </label>
                <PasswordInput
                  id="emailCurrentPassword"
                  name="emailCurrentPassword"
                  autoComplete="current-password"
                  value={emailPassword}
                  onChange={(e) => setEmailPassword(e.target.value)}
                  className={INPUT_CLASS}
                />
                <p className="mt-1 text-xs text-text-muted">
                  Required to confirm an email change.
                </p>
              </div>
            )}
          </div>
          <NoticeLine notice={notices.email} />
        </SettingsCard>

        <SettingsCard id="settings-password" title="Password">
          <div className="flex flex-col gap-4">
            <div>
              <label htmlFor="currentPassword" className={LABEL_CLASS}>
                Current password
              </label>
              <PasswordInput
                id="currentPassword"
                name="currentPassword"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label htmlFor="newPassword" className={LABEL_CLASS}>
                New password
              </label>
              <PasswordInput
                id="newPassword"
                name="newPassword"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={INPUT_CLASS}
              />
              <p className="mt-1 text-xs text-text-muted">At least {MIN_PASSWORD_LENGTH} characters.</p>
            </div>
            <div>
              <label htmlFor="confirmNewPassword" className={LABEL_CLASS}>
                Confirm new password
              </label>
              <PasswordInput
                id="confirmNewPassword"
                name="confirmNewPassword"
                autoComplete="new-password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                className={INPUT_CLASS}
              />
            </div>
          </div>
          <NoticeLine notice={notices.password} />
        </SettingsCard>
      </form>

      <div className="mt-6 flex flex-col gap-6">
        <SettingsCard id="settings-etsy" title="Etsy connection">
          {etsy.configError && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
              {etsy.configError}
            </p>
          )}
          <dl className="space-y-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="text-text-muted">Shop:</dt>
              <dd className="font-medium text-text">
                {etsy.connected ? (etsy.shopName ?? "Shop name unavailable") : "No shop connected"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-text-muted">Status:</dt>
              <dd>
                {etsy.connected ? (
                  <span className="font-medium text-green-700 dark:text-green-400">Connected</span>
                ) : (
                  <span className="text-text">Not connected</span>
                )}
              </dd>
            </div>
          </dl>

          <div className="mt-4">
            {etsy.connected ? (
              <form action="/api/auth/etsy/logout" method="post">
                <input type="hidden" name="returnTo" value="/settings" />
                <button
                  type="submit"
                  className="inline-flex h-9 items-center rounded-full border border-red-200 px-4 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/50"
                >
                  Disconnect
                </button>
              </form>
            ) : (
              !etsy.configError && (
                // eslint-disable-next-line @next/next/no-html-link-for-pages -- an API route (redirects to Etsy's consent screen), not a page; the rule's matcher mistakes it for one because of the sibling app/api/auth/[...nextauth] catch-all.
                <a
                  href="/api/auth/etsy/login"
                  className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Connect Etsy shop
                </a>
              )
            )}
          </div>
        </SettingsCard>

        <SettingsCard id="settings-two-factor" title="Two-factor authentication">
          <TwoFactorCard status={twoFactor} />
        </SettingsCard>

        <div>
          <LogOutButton />
        </div>
      </div>

      <div className="sticky bottom-0 z-20 -mx-6 mt-8 border-t border-surface-border bg-surface px-6 py-3 backdrop-blur-md">
        <div className="flex items-center justify-end gap-4">
          <div aria-live="polite" className="min-w-0 flex-1 [&>p]:mt-0">
            <NoticeLine notice={footer} />
          </div>
          <button
            type="submit"
            form={FORM_ID}
            disabled={saving}
            className="inline-flex h-10 shrink-0 items-center justify-center rounded-full bg-primary px-6 text-sm font-medium text-white transition-colors hover:bg-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
