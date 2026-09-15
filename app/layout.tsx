import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { unstable_rethrow } from "next/navigation";
import { getCurrentUser } from "@/lib/account/current-user";
import { DEFAULT_THEME, type Theme } from "@/lib/account/theme";
import { APP_NAME } from "@/lib/brand";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: "Listings and product mockups for your shop.",
};

/**
 * The signed-in account's stored theme, or the default when signed out. A DB
 * hiccup shouldn't take down every page, so it falls back to the default —
 * but Next's own dynamic-rendering signals are rethrown, not swallowed.
 */
async function storedTheme(): Promise<Theme> {
  try {
    return (await getCurrentUser())?.theme ?? DEFAULT_THEME;
  } catch (err) {
    unstable_rethrow(err);
    return DEFAULT_THEME;
  }
}

/**
 * `data-theme` is rendered server-side from the DB, so the correct theme is
 * in the very first HTML byte — no inline script, no flash of the wrong
 * theme. A save on /settings calls `router.refresh()`, which re-renders this
 * layout with the new value.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const theme = await storedTheme();

  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
