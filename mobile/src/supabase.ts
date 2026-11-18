import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "./config";
import { secureSessionStorage } from "./secure-storage";

// MOBILE-001 (docs/42 §3.1): the session is kept only in the Keychain storage, refreshed only while the app is in the
// foreground (src/auth-context.tsx), and never read from a URL.
export const SESSION_STORAGE_KEY = "campus-link.session";

export function createSupabase(config: AppConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      storage: secureSessionStorage,
      storageKey: SESSION_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}
