import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { SkipLink } from "@/components/skip-link";
import "./globals.css";
import { DemoLikesProvider } from "@/components/demo-likes-provider";
import { DemoChatProvider } from "@/components/demo-chat-provider";
import { DemoDiscoverProvider } from "@/components/demo-discover-provider";
import { DemoSafetyProvider } from "@/components/demo-safety-provider";

import { DemoPrivacyProvider } from "@/components/demo-privacy-provider";

export const metadata: Metadata = {
  title: "Campus Link",
  description: "Campus Link Discover (demo UI with fictional profiles)",
  // Inline neutral icon prevents the browser's implicit /favicon.ico 404.
  icons: { icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23171717'/%3E%3C/svg%3E" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Every page needs the incoming request's CSP nonce, including otherwise static pages.
  await connection();
  return (
    <html lang="ja">
      <body>
        <SkipLink />
        <DemoPrivacyProvider><DemoLikesProvider><DemoChatProvider><DemoSafetyProvider><DemoDiscoverProvider>{children}</DemoDiscoverProvider></DemoSafetyProvider></DemoChatProvider></DemoLikesProvider></DemoPrivacyProvider>
      </body>
    </html>
  );
}
