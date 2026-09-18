import type { Metadata } from "next";
import Link from "next/link";
import LegalDocument, { Fill } from "@/app/components/legal/LegalDocument";
import { APP_NAME } from "@/lib/brand";
import { ETSY_TRADEMARK_NOTICE } from "@/lib/legal";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return (
    <LegalDocument title="Terms of Service">
      <p>
        These terms are an agreement between you and <Fill>company or owner legal name</Fill> (&quot;we&quot;,
        &quot;us&quot;), of <Fill>registered address</Fill>, about your use of {APP_NAME} (the &quot;Service&quot;).
        By creating an account you agree to these terms and to our <Link href="/privacy">Privacy Policy</Link>.
      </p>

      <h2>1. What the Service does</h2>
      <p>
        {APP_NAME} helps Etsy sellers create product mockups, write and edit listings, edit many listings at
        once, and schedule listings or edits to be published to Etsy later. It works on your Etsy shop only
        through Etsy&apos;s official API and only after you connect your shop and approve access on Etsy.
      </p>

      <h2>2. Your account</h2>
      <ul>
        <li>You must give a valid email address and keep your password secret. You are responsible for what happens under your account.</li>
        <li>You must be at least <Fill>minimum age, e.g. 18</Fill> years old and able to enter a binding contract.</li>
        <li>Tell us at <Fill>contact email</Fill> if you think someone else has accessed your account.</li>
      </ul>

      <h2>3. Your Etsy shop</h2>
      <ul>
        <li>You may only connect shops you own or are authorised to manage.</li>
        <li>
          Changes you make through the Service — publishing, editing, reordering photos, deleting listings,
          scheduled jobs — are sent to Etsy on your instruction. You are responsible for your listings and for
          complying with Etsy&apos;s own terms and seller policies.
        </li>
        <li>Etsy can change or limit its API at any time. We can&apos;t guarantee that any feature relying on it will keep working.</li>
        <li>{ETSY_TRADEMARK_NOTICE}</li>
      </ul>

      <h2>4. Your content</h2>
      <p>
        You keep all rights to the designs, photos, videos, text and other content you upload or create
        (&quot;your content&quot;). You give us a limited licence to store, process and transmit your content only as
        needed to run the Service for you — for example to render mockups and send listings to Etsy. You
        confirm you have the rights to your content and that it doesn&apos;t infringe anyone else&apos;s rights.
      </p>
      <p>
        Mockup templates in our library remain ours or our licensors&apos;. You may use images you render with them
        in your own listings, but you may not extract, copy or redistribute the templates themselves.
      </p>

      <h2>5. AI features</h2>
      <p>
        Optional AI Edits suggest titles, descriptions and tags. Suggestions can be wrong or unsuitable; nothing
        is sent to Etsy until you review it and press Sync. You are responsible for what you publish.
      </p>

      <h2>6. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>break the law, Etsy&apos;s terms, or anyone&apos;s intellectual-property rights through the Service;</li>
        <li>try to access other users&apos; accounts or data, or probe, overload or bypass the Service&apos;s security;</li>
        <li>resell or give others access to the Service without our written permission.</li>
      </ul>

      <h2>7. Subscription and payment</h2>
      <p>
        The Service costs <Fill>subscription price and currency</Fill>, billed <Fill>billing period, e.g. monthly</Fill>{" "}
        through <Fill>payment provider</Fill>. <Fill>free trial terms, if any</Fill>. Subscriptions renew
        automatically until cancelled; you can cancel <Fill>how to cancel</Fill>, and cancellation takes effect at
        the end of the current billing period. Refunds are covered by our <Link href="/refunds">Refund Policy</Link>.
        We will give at least <Fill>notice period for price changes, e.g. 30 days</Fill> notice of any price change.
      </p>

      <h2>8. Ending your account</h2>
      <p>
        You can stop using the Service at any time and ask us to delete your account at <Fill>contact email</Fill>.
        We may suspend or close an account that breaks these terms, with notice where reasonable. On deletion,
        your data is removed as described in the <Link href="/privacy">Privacy Policy</Link>; listings already on
        Etsy stay on Etsy.
      </p>

      <h2>9. Availability and changes</h2>
      <p>
        We work to keep the Service available but don&apos;t promise it will be uninterrupted or error-free. We may
        change or remove features. If we change these terms in a way that matters, we will tell you by email or
        in the app before the change applies.
      </p>

      <h2>10. Disclaimers and liability</h2>
      <p>
        The Service is provided &quot;as is&quot;. To the extent the law allows, we are not liable for lost sales, lost
        profits, lost data or indirect damages, including those caused by Etsy&apos;s API or by listings you
        publish, and our total liability is limited to the amount you paid us in the <Fill>liability period, e.g. 12 months</Fill>{" "}
        before the claim. Nothing in these terms limits rights you have under consumer law that can&apos;t be limited.
      </p>

      <h2>11. Governing law</h2>
      <p>
        These terms are governed by the laws of <Fill>governing law / jurisdiction</Fill>, and disputes go to the
        courts of <Fill>court venue</Fill>, unless your local consumer law gives you the right to sue where you live.
      </p>

      <h2>12. Contact</h2>
      <p>
        <Fill>company or owner legal name</Fill>, <Fill>registered address</Fill>, <Fill>contact email</Fill>.
      </p>
    </LegalDocument>
  );
}
