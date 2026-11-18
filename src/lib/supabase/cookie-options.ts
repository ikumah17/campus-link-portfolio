import type { CookieOptionsWithName } from "@supabase/ssr";

// SEC-010 (SECREVIEW-001 L-4): every server-side Supabase client writes the session cookies with these options, so
// JavaScript can never read the access or refresh token. Secure only on Vercel: local `next start` serves http.
// The library keeps its other defaults (path, sameSite, maxAge).
export function sessionCookieOptions(): CookieOptionsWithName {
  return { httpOnly: true, secure: process.env.VERCEL === "1" };
}
