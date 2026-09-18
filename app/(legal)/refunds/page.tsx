import type { Metadata } from "next";
import Link from "next/link";
import LegalDocument, { Fill } from "@/app/components/legal/LegalDocument";
import { APP_NAME } from "@/lib/brand";

export const metadata: Metadata = { title: "Refund Policy" };

export default function RefundsPage() {
  return (
    <LegalDocument title="Refund Policy">
      <p>
        {APP_NAME} is a subscription costing <Fill>subscription price and currency</Fill> per{" "}
        <Fill>billing period, e.g. month</Fill>, paid through <Fill>payment provider</Fill>.
      </p>

      <h2>Cancelling</h2>
      <p>
        You can cancel at any time <Fill>how to cancel</Fill>. You keep access until the end of the period you
        have already paid for, and you won&apos;t be charged again.
      </p>

      <h2>Refunds</h2>
      <ul>
        <li>
          First payment: if you ask within <Fill>refund window, e.g. 14 days</Fill> of your first payment, we
          refund it in full.
        </li>
        <li>Renewals: renewal payments are not refunded, except where the law requires it or as described below.</li>
        <li>
          Our fault: if the Service was unavailable or didn&apos;t work for a significant part of a billing period
          because of a problem on our side, we will refund that period or a fair share of it.
        </li>
        <li>
          Duplicate or mistaken charges are always refunded in full.
        </li>
      </ul>
      <p>
        Problems caused by Etsy — such as changes to or outages of Etsy&apos;s API, or Etsy&apos;s decisions about your
        shop or listings — are outside our control, but tell us and we will look at each case fairly.
      </p>

      <h2>Your legal rights</h2>
      <p>
        If you are a consumer in a country that gives you a right to withdraw from online purchases, that right
        applies in addition to this policy. By starting to use the Service straight away you ask us to begin
        providing it during the withdrawal period, <Fill>withdrawal-right wording for your jurisdiction</Fill>.
      </p>

      <h2>How to ask</h2>
      <p>
        Email <Fill>contact email</Fill> with your account email address and the charge in question. We reply
        within <Fill>response time, e.g. 5 business days</Fill>; approved refunds go back to the original payment
        method, usually within <Fill>refund processing time, e.g. 5–10 business days</Fill>.
      </p>
      <p>
        See also our <Link href="/terms">Terms of Service</Link>.
      </p>
    </LegalDocument>
  );
}
