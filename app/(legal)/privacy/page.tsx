import type { Metadata } from "next";
import Link from "next/link";
import LegalDocument, { Fill } from "@/app/components/legal/LegalDocument";
import { APP_NAME } from "@/lib/brand";
import { ETSY_TRADEMARK_NOTICE } from "@/lib/legal";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  return (
    <LegalDocument title="Privacy Policy">
      <p>
        This policy explains what personal data {APP_NAME} stores, where it goes and how long it is kept. The
        controller is <Fill>company or owner legal name</Fill>, <Fill>registered address</Fill>. Questions and
        requests: <Fill>contact email</Fill>.
      </p>
      <p>
        We don&apos;t sell your data, we don&apos;t show ads, and the Service contains no analytics or tracking
        tools.
      </p>

      <h2>1. What we store</h2>

      <h3>Your account</h3>
      <ul>
        <li>Email address and, if you add them in Account settings, first and last name.</li>
        <li>Your password, stored only as a bcrypt hash — never in readable form.</li>
        <li>Your theme choice (light or dark) and when you accepted these terms.</li>
        <li>
          If you turn on two-factor authentication: the authenticator secret (encrypted with AES-256-GCM), your
          recovery codes (stored only as SHA-256 hashes) and the time step of the last code used, so a code
          can&apos;t be reused.
        </li>
        <li>When the account was created and last changed.</li>
      </ul>

      <h3>Your Etsy connection</h3>
      <ul>
        <li>
          When you connect a shop, Etsy gives us access and refresh tokens. The refresh token is stored in our
          database encrypted; both tokens are also kept in an encrypted, http-only cookie in your browser. We
          never see or store your Etsy password.
        </li>
        <li>Your Etsy user id, shop id, shop name and shop icon URL, and when the shop was connected and last synced.</li>
        <li>
          The access you approve on Etsy: reading and writing listings and reading shop details, plus deleting
          listings if that permission is enabled.
        </li>
      </ul>

      <h3>Your shop&apos;s listings</h3>
      <p>
        To show and edit your listings quickly we keep a copy of your listings as Etsy returns them: title,
        description, tags, materials, price, quantity, SKUs, variations and inventory, shipping and return
        settings, personalization settings, photo and video references (Etsy URLs, alt text, order) and similar
        listing fields. This is listing data, not your customers&apos; data — we don&apos;t request access to orders,
        transactions or buyers.
      </p>

      <h3>Files and work in progress</h3>
      <ul>
        <li>Designs, photos, videos and mockup files you upload into a draft, and the draft&apos;s listing text and settings.</li>
        <li>Mockup templates you upload yourself, and mockup calibration settings.</li>
        <li>
          Scheduled listings and scheduled bulk edits: the date, time zone, the changes to apply, the images
          rendered for them, and the outcome of each attempt (including Etsy&apos;s error message if one fails).
        </li>
      </ul>

      <h3>Sign-in protection</h3>
      <ul>
        <li>
          Failed sign-in attempts are counted per account under a SHA-256 hash of the email address (not the
          address itself), to lock an account after repeated failures. The counter is deleted when you next sign
          in successfully.
        </li>
        <li>
          Failed sign-ins and new sign-ups are also counted per IP address, to limit abuse. These counters
          store the IP address itself with a count and time window; they are not currently deleted
          automatically.
        </li>
      </ul>

      <h3>Server logs</h3>
      <p>
        When a request to Etsy or to the AI service fails, the server logs the error. These logs can include
        the request address (which contains shop and listing ids), Etsy&apos;s response, and the listing content we
        tried to send. Our hosting provider, <Fill>hosting provider</Fill>, may also keep standard request logs
        (such as IP address, URL and time) under its own policy. Log retention: <Fill>log retention period</Fill>.
      </p>

      <h2>2. Who we share it with</h2>
      <p>We only send data to the services the Service needs to work:</p>
      <ul>
        <li>
          <strong>Etsy, Inc.</strong> — your listing content, photos, videos and changes are sent to Etsy&apos;s API
          when you publish, sync or schedule, and listing data is read from it. Listing images shown in the app
          load directly from Etsy&apos;s servers. {ETSY_TRADEMARK_NOTICE}
        </li>
        <li>
          <strong>Cloudflare (R2 storage)</strong> — uploaded files, draft files, your own templates and images
          rendered for scheduled listings are stored in Cloudflare R2.
        </li>
        <li>
          <strong>Cloudflare (Turnstile)</strong> — after an account has been locked for failed sign-ins, the
          sign-in page shows a Cloudflare Turnstile check. Your browser loads it from Cloudflare, which
          processes technical data (such as IP address and browser characteristics) to tell people from bots, and
          we send the resulting token and your IP address to Cloudflare to verify it.
        </li>
        <li>
          <strong>Neon</strong> — our database (everything under &quot;What we store&quot; except files) is hosted by
          Neon.
        </li>
        <li>
          <strong>Anthropic</strong> — only when you use AI Edits (Optimize or Regenerate): the listing&apos;s
          current title, description and tags, the preset you picked and any instructions you typed are sent to
          Anthropic&apos;s API to generate a suggestion. Nothing is sent if you don&apos;t use it.
        </li>
        <li>
          <strong><Fill>hosting provider</Fill></strong> — runs the application and so processes all requests.
        </li>
        <li>
          <strong><Fill>payment provider</Fill></strong> — processes subscription payments; we don&apos;t store card
          details.
        </li>
      </ul>
      <p>
        We may also disclose data if the law requires it. Some of these providers process data outside your
        country, including in the United States; <Fill>transfer safeguards, e.g. Standard Contractual Clauses</Fill>.
      </p>

      <h2>3. Why we use it (legal bases)</h2>
      <ul>
        <li>To provide the Service you signed up for — account, Etsy connection, listings, files, scheduling (performance of a contract).</li>
        <li>To keep accounts secure — password hashing, two-factor authentication, sign-in limits, Turnstile, error logs (legitimate interests).</li>
        <li>To bill you and keep records the law requires (contract and legal obligation).</li>
      </ul>

      <h2>4. How long we keep it</h2>
      <ul>
        <li>Account data, shop connections, the listings copy, your templates and schedules: until you delete them or your account.</li>
        <li>Drafts and their files: deleted automatically after 30 days without changes.</li>
        <li>
          Images rendered for a scheduled listing: deleted once it is published or the schedule is cancelled;
          kept after a failed attempt so it can be retried.
        </li>
        <li>
          Disconnecting a shop in Account settings removes the Etsy cookie from your browser; the stored
          connection stays until you delete your account or ask us to remove it. You can also revoke the
          app&apos;s access at any time in your Etsy account settings.
        </li>
      </ul>

      <h2>5. Cookies</h2>
      <p>
        We only use cookies needed to sign you in and connect your Etsy shop. See the{" "}
        <Link href="/cookies">Cookie Policy</Link>.
      </p>

      <h2>6. Security</h2>
      <p>
        Passwords are hashed, Etsy tokens and two-factor secrets are encrypted, connections use HTTPS, and every
        request is checked against your account so you only reach your own data.
      </p>

      <h2>7. Your rights</h2>
      <p>
        Depending on where you live, you can ask to access, correct, export or delete your data, or object to or
        restrict how we use it. You can change your name, email and password yourself in Account settings; for
        anything else, including deleting your account, email <Fill>contact email</Fill>. You can also complain
        to your data-protection authority.
      </p>

      <h2>8. Children</h2>
      <p>The Service is not meant for anyone under <Fill>minimum age, e.g. 18</Fill>.</p>

      <h2>9. Changes</h2>
      <p>If we change this policy in a way that matters, we will tell you by email or in the app.</p>
    </LegalDocument>
  );
}
