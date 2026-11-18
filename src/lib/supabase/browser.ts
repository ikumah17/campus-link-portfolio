"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabasePublicConfig } from "./config";

// SEC-010: the session cookies are HttpOnly, so the browser client never reads them. Realtime is its only use, and it
// takes a short-lived access token from the server route. Realtime calls the accessToken callback on connect and on
// every heartbeat (realtime-js RealtimeClient._wrapHeartbeatCallback), so the cache below keeps a long session joined.
export const REALTIME_TOKEN_PATH = "/api/realtime-token";
// Refetch this long before expiry. The server hands out tokens with at least auth-js's 90 s refresh margin left.
const REFRESH_MARGIN_SECONDS = 60;

type Token = { token: string; expiresAt: number };

async function fetchToken(): Promise<Token> {
  const response = await globalThis.fetch(REALTIME_TOKEN_PATH, { credentials: "same-origin", cache: "no-store" });
  // A signed-out fetch follows the proxy's redirect to the HTML login page, so the content type is checked too.
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!response.ok || type !== "application/json") throw new Error("Realtime token unavailable");
  const body: unknown = await response.json();
  const { token, expiresAt } = (body && typeof body === "object" ? body : {}) as Partial<Token>;
  if (typeof token !== "string" || token === "" || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new Error("Realtime token unavailable");
  }
  return { token, expiresAt };
}

/** The accessToken callback: one cached token until REFRESH_MARGIN_SECONDS before expiry, one shared in-flight fetch. */
export function realtimeTokenSource(now: () => number = () => Date.now()) {
  let cached: Token | undefined;
  let pending: Promise<string> | undefined;
  return function accessToken(): Promise<string> {
    if (cached && now() < (cached.expiresAt - REFRESH_MARGIN_SECONDS) * 1000) return Promise.resolve(cached.token);
    if (!pending) {
      const request: Promise<string> = fetchToken().then(
        (fresh) => { cached = fresh; return fresh.token; },
        (error: unknown) => { cached = undefined; throw error; },
      ).finally(() => { if (pending === request) pending = undefined; });
      pending = request;
    }
    return pending;
  };
}

let client: SupabaseClient | undefined;

export function createBrowserSupabase() {
  if (client) return client;
  const { url, publishableKey } = supabasePublicConfig();
  const created = createClient(url, publishableKey, { accessToken: realtimeTokenSource() });
  // One client per browser tab. Only client effects call this; a server render would get a fresh client.
  if (typeof window !== "undefined") client = created;
  return created;
}
