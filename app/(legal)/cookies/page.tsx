import type { Metadata } from "next";
import Link from "next/link";
import LegalDocument, { Fill } from "@/app/components/legal/LegalDocument";
import { APP_NAME } from "@/lib/brand";
import { COOKIES } from "@/lib/legal";

export const metadata: Metadata = { title: "Cookie Policy" };

export default function CookiesPage() {
  return (
    <LegalDocument title="Cookie Policy">
      <p>
        {APP_NAME} only uses cookies that are strictly necessary to sign you in and connect your Etsy shop. We
        don&apos;t use analytics, advertising or tracking cookies, and we don&apos;t store anything else in your
        browser&apos;s local storage. Because every cookie is essential, we don&apos;t show a cookie consent banner.
      </p>
      <p>
        On a live site the sign-in cookies may carry a <code>__Secure-</code> or <code>__Host-</code> prefix. All
        of them are http-only (not readable by page scripts) and are sent only over HTTPS in production.
      </p>

      <h2>Cookies we set</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-black/10 dark:border-white/15">
              <th className="py-2 pr-4 font-semibold">Name</th>
              <th className="py-2 pr-4 font-semibold">Purpose</th>
              <th className="py-2 font-semibold">Lasts</th>
            </tr>
          </thead>
          <tbody>
            {COOKIES.map((c) => (
              <tr key={c.name} className="border-b border-black/5 align-top dark:border-white/10">
                <td className="py-2 pr-4 font-mono text-xs">{c.name}</td>
                <td className="py-2 pr-4">{c.purpose}</td>
                <td className="py-2">{c.duration}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Third parties</h2>
      <p>
        If an account has been locked after failed sign-ins, the sign-in page loads a Cloudflare Turnstile
        check from Cloudflare&apos;s servers to tell people from bots. Cloudflare handles that check under its own
        privacy terms. Listing images are loaded from Etsy&apos;s servers. We don&apos;t set cookies for either.
      </p>

      <h2>Managing cookies</h2>
      <p>
        You can delete or block cookies in your browser settings, but you won&apos;t be able to sign in or use your
        Etsy connection without them.
      </p>

      <h2>Contact</h2>
      <p>
        Questions: <Fill>contact email</Fill>. See also the <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </LegalDocument>
  );
}
