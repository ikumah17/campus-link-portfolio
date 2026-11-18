import { backendMode } from "@/lib/backend";
import { receivePhotoUpload, uploadResponse } from "@/server/photo-route-core";
import { uploadAccount } from "@/server/photo-upload";
import { NO_STORE_HEADERS } from "@/server/request-body";

// SEC-007: photo uploads. A route handler instead of a Server Action, so only this path reads a large body.
// Next's Server Action Origin check does not cover route handlers, so the same-origin rule is enforced here:
// the Origin's host must equal the Host header (X-Forwarded-Host is never consulted), a missing or "null" Origin is
// refused, and a present Sec-Fetch-Site must be same-origin.
// FIX-002: no body byte is read before the account check, this user's upload lock and a body slot have all passed;
// a refusal answers at once and spends no reservation (src/server/photo-route-core.ts, shared with the app's route).
// SEC-015: the proxy does not run for this path, so Next no longer buffers the body before this route
// (SECREVIEW-001 L-3). Without a session, or with one Supabase cannot refresh, my_account answers 401 and so does
// this route, before the body; a refreshed session's cookies are written to the response by createServerSupabase.
// The proxy's document CSP does not apply here, so every answer carries its own CSP that allows nothing.
const notFound = () => new Response(null, { status: 404, headers: NO_STORE_HEADERS });
const notAllowed = () => new Response(null, { status: 405, headers: { Allow: "POST", ...NO_STORE_HEADERS } });

function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || origin === "null" || !host) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin && url.host === host.toLowerCase();
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (backendMode() === "demo") return notFound();
  if (!sameOrigin(request)) return uploadResponse({ status: "invalid", http: 403 });
  return uploadResponse(await receivePhotoUpload(request, uploadAccount));
}

export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
export const OPTIONS = notAllowed;
