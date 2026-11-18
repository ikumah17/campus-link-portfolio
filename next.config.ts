import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Pin the workspace root to this repo so a lockfile in a parent directory
// is never inferred as the root.
const root = path.dirname(fileURLToPath(import.meta.url));
// FIX-008: a comma-separated hostname list (the PC's LAN IP for iPhone testing) that may load dev resources such as
// /_next/hmr. Set only on the command line for `npm run dev`; no address is committed, and Next ignores it outside dev.
const devOrigins = (process.env.CAMPUS_LINK_DEV_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  ...(devOrigins.length > 0 && process.env.NODE_ENV !== "production" ? { allowedDevOrigins: devOrigins } : {}),
  experimental: {
    // SEC-016: Next copies a proxied request body into memory up to this size (default 10 MiB) before the proxy runs,
    // and a body over it reaches the page truncated. No proxied POST needs more than the 1 MiB Server Action limit,
    // and the 256 KiB margin is several 64 KiB socket reads, so a truncated action body still exceeds 1 MiB (413).
    proxyClientMaxBodySize: 1_310_720,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
