"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * The home screen's single primary action — the connected shop's real name,
 * fetched from Etsy (`shop_name`), linking to the listings page. A skeleton
 * shows while the fetch is in flight; a failed fetch (or no shop) falls back
 * to a generic label rather than blocking the button.
 */
export default function ShopButton() {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [shopName, setShopName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/etsy/shop")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((body: { shopName?: string }) => {
        if (cancelled) return;
        if (body?.shopName) {
          setShopName(body.shopName);
          setStatus("loaded");
        } else {
          setStatus("error");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "loading") {
    return (
      <div
        role="status"
        aria-label="Loading shop name"
        className="h-10 w-full animate-pulse rounded-full bg-black/[.06] dark:bg-white/[.08]"
      />
    );
  }

  return (
    <Link
      href="/listings"
      className="inline-flex h-10 items-center justify-center rounded-full bg-[#f56400] px-5 text-sm font-medium text-white transition-colors hover:bg-[#d95700]"
    >
      {status === "loaded" && shopName ? shopName : "My shop"}
    </Link>
  );
}
