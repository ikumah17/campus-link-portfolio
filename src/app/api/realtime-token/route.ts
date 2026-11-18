// SEC-010: the session cookies are HttpOnly, so the browser's Realtime client gets its access token here. The route
// authorizes by signature-verified getClaims() and only then reads the session for the token, which must belong to the
// same user. It answers only the access token and its expiry: never the refresh token or user data, and never a log.
// The proxy keeps it behind the session.
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";

const headers = { "Cache-Control": "no-store" };
const answer = (status: number, body: Record<string, unknown> = {}) => Response.json(body, { status, headers });
const notAllowed = () => new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });

export async function GET(request: Request) {
  if (backendMode() !== "supabase") return new Response(null, { status: 404, headers });
  // Fetch Metadata: a browser marks any cross-site or same-site (other subdomain) read; only same-origin passes.
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return answer(403);
  try {
    const supabase = await createServerSupabase();
    const { data, error } = await supabase.auth.getClaims();
    const sub = data?.claims?.sub;
    if (error || typeof sub !== "string" || sub === "") return answer(401);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || session.user?.id !== sub) return answer(401);
    const { access_token: token, expires_at: expiresAt } = session;
    if (typeof token !== "string" || token === "" || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return answer(401);
    return answer(200, { token, expiresAt });
  } catch {
    return answer(401);
  }
}

export const POST = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
export const OPTIONS = notAllowed;
