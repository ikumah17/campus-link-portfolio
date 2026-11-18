import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabasePublicConfig } from "./config";
import { sessionCookieOptions } from "./cookie-options";

export async function createServerSupabase() {
  const { url, publishableKey } = supabasePublicConfig();
  const store = await cookies();
  return createServerClient(url, publishableKey, {
    cookieOptions: sessionCookieOptions(),
    cookies: {
      getAll: () => store.getAll(),
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Server Components cannot write cookies; Proxy handles refresh before rendering.
        }
      },
    },
  });
}

// Server authorization must use signature-verified auth.getClaims() or auth.getUser().
// Never authorize from the unverified contents of auth.getSession().
