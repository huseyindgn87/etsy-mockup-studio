import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // proxy.ts runs on every route, and a proxied request body is buffered
    // (and silently cut off) at this size — 10MB by default. Draft uploads go
    // up to a 100MB video (lib/etsy/video-limits.ts).
    proxyClientMaxBodySize: "101mb",
  },
};

export default nextConfig;
