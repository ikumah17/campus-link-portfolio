import { authFieldMessages, passwordFieldMessages, passwordMessages, type AuthFieldErrors, type AuthStatus } from "./shared";

// MOBILE-001: the typed client of MOBILE-API-001's POST /api/mobile/auth/signin and /signup. The answers carry the
// web action's status codes, so every refusal shows the same message as the web (src/lib/auth-validation.ts). Only
// the field names of a server field error are used; the text always comes from the shared messages. FIX-005: a
// password error keeps the server's text only when it is one of the shared password messages.
export type MobileSession = { access_token: string; refresh_token: string; expires_in?: number; expires_at?: number };
export type AuthAnswer =
  | { status: "ok"; session: MobileSession }
  | { status: Exclude<AuthStatus, "idle">; fieldErrors?: AuthFieldErrors };

export const REQUEST_TIMEOUT_MS = 15_000;
const STATUSES: readonly Exclude<AuthStatus, "idle">[] = ["sent", "failed", "rate_limited", "unavailable", "invalid"];
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

function fieldErrors(kind: "signin" | "signup", value: unknown): AuthFieldErrors | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fields = value as Record<string, unknown>;
  const errors: AuthFieldErrors = {};
  if (fields.email !== undefined) errors.email = authFieldMessages.email;
  if (fields.password !== undefined) {
    const known = passwordFieldMessages.find((message) => message === fields.password);
    errors.password = known ?? (kind === "signup" ? passwordMessages.rule : authFieldMessages.password);
  }
  return Object.keys(errors).length ? errors : undefined;
}

function session(value: unknown): MobileSession | null {
  if (!value || typeof value !== "object") return null;
  const fields = value as Record<string, unknown>;
  if (typeof fields.access_token !== "string" || !JWT.test(fields.access_token)) return null;
  if (typeof fields.refresh_token !== "string" || !fields.refresh_token) return null;
  return {
    access_token: fields.access_token,
    refresh_token: fields.refresh_token,
    ...(typeof fields.expires_in === "number" ? { expires_in: fields.expires_in } : {}),
    ...(typeof fields.expires_at === "number" ? { expires_at: fields.expires_at } : {}),
  };
}

/** Reads an answer body; anything unexpected (HTML, a proxy page, a demo-mode 404) is "unavailable". */
export function parseAnswer(kind: "signin" | "signup", body: unknown): AuthAnswer {
  if (!body || typeof body !== "object") return { status: "unavailable" };
  const fields = body as Record<string, unknown>;
  if (fields.status === "ok" && kind === "signin") {
    const value = session(fields.session);
    return value ? { status: "ok", session: value } : { status: "unavailable" };
  }
  const status = STATUSES.find((candidate) => candidate === fields.status);
  // Sign-in never answers "sent", and sign-up never returns a session.
  if (!status || (status === "sent" && kind === "signin")) return { status: "unavailable" };
  const errors = status === "invalid" ? fieldErrors(kind, fields.fieldErrors) : undefined;
  return errors ? { status, fieldErrors: errors } : { status };
}

export function createAuthApi(baseUrl: string, fetcher: Fetch = fetch) {
  async function post(kind: "signin" | "signup", email: string, password: string): Promise<AuthAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetcher(`${baseUrl}/api/mobile/auth/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email, password }),
        credentials: "omit",
        signal: controller.signal,
      });
      const type = response.headers.get("content-type") ?? "";
      if (!type.toLowerCase().startsWith("application/json")) return { status: "unavailable" };
      return parseAnswer(kind, await response.json());
    } catch {
      // A network error, a timeout or a broken body. Never log the request: it holds the password.
      return { status: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    signIn: (email: string, password: string) => post("signin", email, password),
    signUp: (email: string, password: string) => post("signup", email, password),
  };
}

export type AuthApi = ReturnType<typeof createAuthApi>;
