"use client";

import Link from "next/link";
import {
  useEffect,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { burstDollars } from "./dollar-burst";
import MarketplaceBadge from "./MarketplaceBadge";

/**
 * The home screen's single primary action — the connected shop's real name,
 * fetched from Etsy (`shop_name`), linking to the listings page. A skeleton
 * shows while the fetch is in flight; a failed fetch (or no shop) falls back
 * to a generic label rather than blocking the button.
 */
export default function ShopButton() {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [shopName, setShopName] = useState<string | null>(null);
  const [glowing, setGlowing] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  const [glowStyle, setGlowStyle] = useState<CSSProperties>({});

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

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  function handlePointerMove(e: ReactPointerEvent<HTMLAnchorElement>) {
    if (reducedMotion || e.pointerType === "touch") return;
    const rect = e.currentTarget.getBoundingClientRect();
    setGlowStyle({
      "--mx": `${e.clientX - rect.left}px`,
      "--my": `${e.clientY - rect.top}px`,
    } as CSSProperties);
  }

  function handlePointerEnter(e: ReactPointerEvent<HTMLAnchorElement>) {
    if (reducedMotion || e.pointerType === "touch") return;
    setGlowing(true);
  }

  function handlePointerLeave() {
    setGlowing(false);
  }

  /** Fires the "$" burst and lets the click carry on — never prevents the navigation. */
  function handleClick(e: ReactMouseEvent<HTMLAnchorElement>) {
    let x = e.clientX;
    let y = e.clientY;
    // Keyboard activation (Enter) reports no pointer position — burst from the button's centre.
    if (e.detail === 0) {
      const rect = e.currentTarget.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
    }
    burstDollars(x, y);
  }

  if (status === "loading") {
    return (
      <div
        role="status"
        aria-label="Loading shop name"
        className="h-11 w-full animate-pulse rounded-full bg-black/[.06]"
      />
    );
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Link
        href="/listings"
        onClick={handleClick}
        onPointerMove={handlePointerMove}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        style={glowStyle}
        className="group relative inline-flex h-11 w-full items-center justify-center overflow-hidden rounded-full bg-primary px-6 text-sm font-medium text-white transition-[background-color,transform] duration-150 hover:bg-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 active:scale-[0.98]"
      >
        <span
          aria-hidden
          data-testid="shop-button-glow"
          className="pointer-events-none absolute inset-0 rounded-full transition-opacity duration-200 motion-reduce:hidden"
          style={{
            opacity: glowing ? 1 : 0,
            background:
              "radial-gradient(120px circle at var(--mx, 50%) var(--my, 50%), var(--color-accent), transparent 100%)",
          }}
        />
        <span className="relative">{status === "loaded" && shopName ? shopName : "My shop"}</span>
      </Link>
      <MarketplaceBadge marketplace="etsy" />
    </div>
  );
}
