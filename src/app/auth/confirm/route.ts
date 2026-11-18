import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safe-next";
import { callerAccount } from "@/server/admin-gate";

export async function GET(request: Request) {
  if (backendMode() === "demo") return new Response(null, { status: 404 });
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  let success = false;
  if (code || (tokenHash && (type === "email" || type === "signup"))) {
    try {
      const client = await createServerSupabase();
      const result = code
        ? await client.auth.exchangeCodeForSession(code)
        : await client.auth.verifyOtp({ token_hash: tokenHash!, type: type as "email" | "signup" });
      if (!result.error) {
        // A deleted account keeps its Auth user until retention: a link must not give it a session either.
        // Like sign-in, it ends every session and gets the ordinary failure; an unreadable account ends only this one.
        const account = await callerAccount(client);
        success = account === "usable";
        if (!success) {
          try { await client.auth.signOut({ scope: account === "deleted" ? "global" : "local" }); } catch {
            // auth-js removes this request's session even when the revoke call fails.
          }
        }
      }
    } catch {
      // The destination never includes the provider error or callback credentials.
    }
  }
  // Success never goes straight into the app: /auth/confirmed shows which account the link signed in (SEC-005 L-2),
  // so someone sent another person's link can leave it. Only a checked same-origin next is passed on.
  const next = success ? safeNextPath(params.get("next")) : undefined;
  const query = String(new URLSearchParams(success ? (next ? { next } : {}) : { error: "confirm" }));
  const destination = `${success ? "/auth/confirmed" : "/login"}${query ? `?${query}` : ""}`;
  // A relative Location: the browser resolves it against the host it actually requested, so the cookies set above
  // (merged into this response by Next from cookies()) stay with it. request.url can carry another host (FIX-001).
  return new Response(null, { status: 307, headers: { Location: destination, "Cache-Control": "no-store" } });
}
