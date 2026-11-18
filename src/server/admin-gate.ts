import "server-only";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safe-next";
import { callRpc } from "@/server/rpc";

type AdminClient = Awaited<ReturnType<typeof createServerSupabase>>;
type AdminSession = "aal2" | "needs_mfa" | "unauthenticated" | "unavailable";

export async function adminSession(client: AdminClient): Promise<AdminSession> {
  try {
    const { data, error } = await client.auth.getClaims();
    if (error) {
      return error.name === "AuthSessionMissingError" || ["session_not_found", "session_expired", "refresh_token_not_found", "refresh_token_already_used"].includes(error.code ?? "")
        ? "unauthenticated" : "unavailable";
    }
    if (!data?.claims || data.claims.is_anonymous === true) return "unauthenticated";
    if (data.claims.aal === "aal2") return "aal2";
    if (data.claims.aal === "aal1") return "needs_mfa";
  } catch {
    // Fail closed without logging session or provider details.
  }
  return "unavailable";
}

// A deleted account keeps its Auth user (and any staff role) until retention, so a token can outlive the deletion.
// The caller's own my_account: only an explicit 'deleted' is "deleted" (staff need no profile); anything unreadable is "unknown".
export async function callerAccount(client: AdminClient): Promise<"usable" | "deleted" | "unknown"> {
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

// The admin screens and the document route refuse a deleted account too, and fail closed.
export async function adminAccountUsable(client: AdminClient): Promise<boolean> {
  return await callerAccount(client) === "usable";
}

export type StaffRole = "reviewer" | "moderator" | "admin";
const staffRoles: readonly StaffRole[] = ["reviewer", "moderator", "admin"];

// The caller's own active roles from my_staff_roles (order 19), only to choose what /admin shows: each admin RPC
// still checks its role. Anything unreadable is null, so the page fails closed.
export async function callerStaffRoles(client: AdminClient): Promise<StaffRole[] | null> {
  try {
    const result = await callRpc(client, "my_staff_roles");
    if (result.code !== "ok" || !Array.isArray(result.data)) return null;
    const roles: StaffRole[] = [];
    for (const row of result.data as unknown[]) {
      if (!row || typeof row !== "object" || !("role" in row) || !staffRoles.includes(row.role as StaffRole)) return null;
      if (!roles.includes(row.role as StaffRole)) roles.push(row.role as StaffRole);
    }
    return roles;
  } catch {
    return null;
  }
}

export function adminNextPath(raw: unknown): string {
  const safe = safeNextPath(raw);
  if (!safe) return "/admin";
  const url = new URL(safe, "https://campus.invalid");
  // Check the decoded, normalized pathname too: encoded names and dot segments
  // must not escape the admin area or return to the MFA screen.
  let path = url.pathname;
  try {
    for (let i = 0; i < 8; i++) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
    if (path.includes("%") || !safeNextPath(path) || /[?#]/.test(path)) return "/admin";
    path = new URL(path, "https://campus.invalid").pathname;
  } catch {
    return "/admin";
  }
  if ((path !== "/admin" && !path.startsWith("/admin/")) || path === "/admin/mfa" || path.startsWith("/admin/mfa/")) return "/admin";
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function requireAdminSession(next: string): Promise<AdminClient | null> {
  let client: AdminClient;
  try { client = await createServerSupabase(); } catch { return null; }
  const status = await adminSession(client);
  const destination = encodeURIComponent(adminNextPath(next));
  if (status === "unauthenticated") redirect(`/login?next=${destination}`);
  if (status === "needs_mfa") redirect(`/admin/mfa?next=${destination}`);
  // This gate only routes the screen; authorization stays in the database.
  return status === "aal2" && await adminAccountUsable(client) ? client : null;
}
