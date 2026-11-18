import "server-only";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { backendMode } from "@/lib/backend";
import { authFieldMessages, passwordMessages, validateAuthInput, type AuthFormState } from "@/lib/auth-validation";
import { reserveSignIn, reserveSignUp } from "@/server/auth-rate";
import { callRpc } from "@/server/rpc";

// MOBILE-API-001: the sign-up and sign-in checks shared by the web Server Actions (src/server/auth-actions.ts) and
// POST /api/mobile/auth/*. Only the Supabase client differs: the web's keeps the session in cookies, the app's in
// memory for the JSON answer. Not a "use server" module, so nothing here is callable as a Server Action.
type AuthClient = SupabaseClient;
export type SignInResult = { status: "signed_in"; session: Session | null } | AuthFormState;

function emailRedirectTo(): string | undefined {
  const raw = process.env.CAMPUS_LINK_SITE_URL;
  if (!raw) return undefined;
  try {
    // Check the original spelling: URL parsing alone hides paths, whitespace and backslashes.
    if (!/^(?:https:\/\/[^/\\?#\s\u0000- \u007f]+|http:\/\/(?:localhost|127\.0\.0\.1):[0-9]+)$/.test(raw)) return undefined;
    const url = new URL(raw);
    if (url.username || url.password || url.origin === "null") return undefined;
    return `${raw}/auth/confirm`;
  } catch {
    return undefined;
  }
}

function rateLimited(error: { status?: number; code?: string }) {
  return error.status === 429 || error.code === "over_email_send_rate_limit" || error.code === "over_request_rate_limit";
}

export async function signUpWithPassword(rawEmail: unknown, rawPassword: unknown, createClient: () => Promise<AuthClient>): Promise<AuthFormState> {
  if (backendMode() === "demo") return { status: "unavailable" };
  // FIX-005: a new password must meet the sign-up rule before Auth sees it.
  const input = validateAuthInput(rawEmail, rawPassword, "signup");
  if (!input.valid) return { status: "invalid", fieldErrors: input.fieldErrors };
  // SEC-012: Auth sends a confirmation email only after this address's attempt, and on Vercel this client IP's, is
  // reserved; any other answer fails closed. Every typed address counts, so the answer reveals no account.
  const reservation = await reserveSignUp(input.email).catch(() => "unavailable" as const);
  if (reservation === "rate_limited") return { status: "rate_limited" };
  if (reservation !== "ok") return { status: "unavailable" };
  try {
    const client = await createClient();
    const destination = emailRedirectTo();
    const { error } = await client.auth.signUp({
      email: input.email, password: input.password,
      ...(destination ? { options: { emailRedirectTo: destination } } : {}),
    });
    if (!error || error.code === "user_already_exists" || error.code === "email_exists") return { status: "sent" };
    if (rateLimited(error)) return { status: "rate_limited" };
    if (error.code === "weak_password") return { status: "invalid", fieldErrors: { password: passwordMessages.rule } };
    if (error.code === "email_address_invalid") return { status: "invalid", fieldErrors: { email: authFieldMessages.email } };
  } catch {
    // Never return or log credentials or provider error details.
  }
  return { status: "unavailable" };
}

// Every 'failed' answer leaves a fixed time after the attempt starts, so the account read and global sign-out that a
// deleted account adds cannot be told from a wrong password by response time (ACCOUNT-002-R1-M3).
export const FAILED_ANSWER_MS = 1500;
async function failedAnswer(started: number): Promise<AuthFormState> {
  const wait = started + FAILED_ANSWER_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return { status: "failed" };
}

// "signed_in" carries the session Auth returned; the web ignores it (its client already wrote the cookies).
export async function signInWithPassword(rawEmail: unknown, rawPassword: unknown, createClient: () => Promise<AuthClient>): Promise<SignInResult> {
  if (backendMode() === "demo") return { status: "unavailable" };
  // Only the basic checks: an account made under an older rule must still sign in (FIX-005).
  const input = validateAuthInput(rawEmail, rawPassword, "signin");
  if (!input.valid) return { status: "invalid", fieldErrors: input.fieldErrors };
  const started = Date.now();
  // SEC-006/SEC-008: Auth is called only after this address's attempt, and on Vercel this client IP's, is reserved;
  // any other answer fails closed.
  const reservation = await reserveSignIn(input.email).catch(() => "unavailable" as const);
  if (reservation === "rate_limited") return { status: "rate_limited" };
  if (reservation !== "ok") return { status: "unavailable" };
  let client: AuthClient;
  let session: Session | null;
  try {
    client = await createClient();
    const { data, error } = await client.auth.signInWithPassword({ email: input.email, password: input.password });
    if (error) return rateLimited(error) ? { status: "rate_limited" } : failedAnswer(started);
    session = data?.session ?? null;
  } catch {
    return failedAnswer(started);
  }
  const access = await signedInAccount(client);
  if (access !== "usable") {
    try {
      // A deleted account keeps its Auth user until retention: end every session it has, as leaving does.
      await client.auth.signOut({ scope: access === "deleted" ? "global" : "local" });
    } catch {
      // auth-js removes this request's session even when the revoke call fails.
    }
    // The wrong-password answer on purpose: a deleted-account message would confirm the password to whoever typed it.
    return access === "deleted" ? failedAnswer(started) : { status: "unavailable" };
  }
  return { status: "signed_in", session };
}

async function signedInAccount(client: AuthClient): Promise<"usable" | "deleted" | "unknown"> {
  try {
    const account = await callRpc(client, "my_account");
    if (account.code !== "ok" || !Array.isArray(account.data) || account.data.length !== 1) return "unknown";
    const row: unknown = account.data[0];
    if (!row || typeof row !== "object" || !("account_status" in row)) return "unknown";
    return row.account_status === "deleted" ? "deleted" : "usable";
  } catch {
    return "unknown";
  }
}
