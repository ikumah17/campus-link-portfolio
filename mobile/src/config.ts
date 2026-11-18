import Constants from "expo-constants";

// MOBILE-001: public values only. The Supabase URL and publishable key are the same public values as the web bundle;
// no service-role key ever goes into the app (docs/42 §1.1, docs/03 P6).
export type AppConfig = { apiBaseUrl: string; supabaseUrl: string; supabasePublishableKey: string };

const NEXT_DEV_PORT = 3000;
const SUPABASE_URL = /^(?:https:\/\/[a-z0-9-]+\.supabase\.co|http:\/\/(?:127\.0\.0\.1|localhost):54321)\/?$/;
const PUBLISHABLE_KEY = /^(?:sb_publishable_[A-Za-z0-9_-]+|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/**
 * The Next.js server the app calls. EXPO_PUBLIC_API_BASE_URL wins; otherwise `next dev` on the same PC as the Expo
 * dev server (its LAN address, as Expo Go reached it). There is no default to a deployed site: a protected Vercel
 * preview refuses the app's requests (docs/42 §1.2).
 */
export function apiBaseUrl(explicit: string | undefined, hostUri: string | undefined): string | null {
  const value = explicit?.trim();
  if (value) return /^https?:\/\/[^\s/?#]+$/.test(value.replace(/\/$/, "")) ? value.replace(/\/$/, "") : null;
  const host = hostUri?.split("/")[0]?.replace(/:\d+$/, "");
  return host && /^[A-Za-z0-9.-]+$/.test(host) ? `http://${host}:${NEXT_DEV_PORT}` : null;
}

/** The app's configuration, or null when a value is missing or malformed (the screens then answer "unavailable"). */
export function readConfig(): AppConfig | null {
  // Static references: Expo inlines EXPO_PUBLIC_* values only when written out in full.
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  const base = apiBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL, Constants.expoConfig?.hostUri);
  if (!base || !SUPABASE_URL.test(supabaseUrl) || !PUBLISHABLE_KEY.test(supabasePublishableKey)) return null;
  return { apiBaseUrl: base, supabaseUrl: supabaseUrl.replace(/\/$/, ""), supabasePublishableKey };
}
