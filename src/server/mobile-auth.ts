import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabasePublicConfig } from "@/lib/supabase/config";
import { isUuid } from "@/server/photo-upload";
import { NO_STORE_HEADERS } from "@/server/request-body";

// MOBILE-API-001 (docs/42 §2.1): /api/mobile/* identify the caller only by `Authorization: Bearer <access token>`.
// Nothing here reads or writes a cookie: a browser attaches cookies to cross-site requests but never this header, so
// without cookies there is no CSRF. The token is checked with Auth (getUser), and RPCs run on a client that sends it,
// so the database checks it again. Tokens are never logged or returned.
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const MAX_AUTHORIZATION_LENGTH = 8192;

export function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value || value.length > MAX_AUTHORIZATION_LENGTH) return null;
  return BEARER.exec(value)?.[1] ?? null;
}

/** A client that keeps nothing: no cookies, no storage, no refresh, no session from the URL. */
export function memoryClient(accessToken?: string): SupabaseClient {
  const { url, publishableKey } = supabasePublicConfig();
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "pkce" },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

export type BearerSession = { status: "ok"; client: SupabaseClient; userId: string };
export type BearerRefusal = { status: "unauthenticated" | "unavailable" };

// Auth's 4xx answers (bad, expired or revoked token, deleted user) mean the token is not usable; anything else,
// a rate limit included, is an outage and fails closed without blaming the token.
function tokenRefused(error: { status?: number }): boolean {
  return typeof error.status === "number" && error.status >= 400 && error.status < 500 && error.status !== 429;
}

export async function bearerSession(request: Request): Promise<BearerSession | BearerRefusal> {
  const token = bearerToken(request);
  if (!token) return { status: "unauthenticated" };
  try {
    const client = memoryClient(token);
    const { data, error } = await client.auth.getUser(token);
    if (error) return { status: tokenRefused(error) ? "unauthenticated" : "unavailable" };
    const user = data?.user;
    if (!user || user.is_anonymous !== false || !isUuid(user.id)) return { status: "unauthenticated" };
    return { status: "ok", client, userId: user.id };
  } catch {
    // Never log the token or provider details.
    return { status: "unavailable" };
  }
}

// docs/42 §2.2: every JSON answer allows nothing and is never stored, the same headers as the web's upload route.
export const MOBILE_JSON_HEADERS = NO_STORE_HEADERS;

export function notAllowed(allow: string) {
  return () => new Response(null, { status: 405, headers: { Allow: allow, ...MOBILE_JSON_HEADERS } });
}
