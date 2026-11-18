import "server-only";
import type { Session } from "@supabase/supabase-js";
import type { AuthFormState, AuthStatus } from "@/lib/auth-validation";
import { MOBILE_JSON_HEADERS } from "@/server/mobile-auth";
import { boundedBody, declaredLength, mediaType } from "@/server/request-body";

// MOBILE-API-001: the JSON bodies and answers of POST /api/mobile/auth/signin and /signup. The routes run outside the
// proxy, so this module bounds the body itself; no cookie is read or set, and the answer is the web action's
// AuthFormState, so every refusal code is the same as on the web.
export const MAX_CREDENTIALS_BYTES = 4096;
export const CREDENTIALS_READ_MS = 10_000;
const HTTP_STATUS: Record<Exclude<AuthStatus, "idle">, number> = {
  sent: 200, invalid: 400, failed: 401, rate_limited: 429, unavailable: 503,
};

export const credentialsAnswer = (state: AuthFormState, http?: number) => Response.json(
  state.fieldErrors ? { status: state.status, fieldErrors: state.fieldErrors } : { status: state.status },
  { status: http ?? (state.status === "idle" ? 503 : HTTP_STATUS[state.status]), headers: MOBILE_JSON_HEADERS },
);

// The session goes only into this body: never a cookie, a header or a log.
export const sessionAnswer = (session: Session) => Response.json({ status: "ok", session: {
  access_token: session.access_token, refresh_token: session.refresh_token, token_type: session.token_type,
  expires_in: session.expires_in, expires_at: session.expires_at,
} }, { status: 200, headers: MOBILE_JSON_HEADERS });

/** The email and password fields of a bounded JSON object, or the refusal to answer instead. */
export async function readCredentials(request: Request): Promise<{ email: unknown; password: unknown } | Response> {
  if (mediaType(request) !== "application/json") return credentialsAnswer({ status: "invalid" }, 415);
  const length = declaredLength(request, MAX_CREDENTIALS_BYTES);
  if (length === "length") return credentialsAnswer({ status: "invalid" }, 411);
  if (length === "too_large") return credentialsAnswer({ status: "invalid" }, 413);
  try {
    const body = await boundedBody(request, MAX_CREDENTIALS_BYTES, CREDENTIALS_READ_MS);
    if (body === "too_large") return credentialsAnswer({ status: "invalid" }, 413);
    if (body === "timeout") return credentialsAnswer({ status: "invalid" });
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!value || typeof value !== "object" || Array.isArray(value)) return credentialsAnswer({ status: "invalid" });
    const fields = value as Record<string, unknown>;
    return { email: fields.email, password: fields.password };
  } catch {
    return credentialsAnswer({ status: "invalid" });
  }
}
