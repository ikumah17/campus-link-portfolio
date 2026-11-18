"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { callRpc } from "@/server/rpc";

export type AccountActionResult = { status: "ok" | "invalid" | "invalid_state" | "forbidden" | "unauthenticated" | "unavailable" };
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
// The same outcome mapping as reactivateReportTarget: a missing profile and a changed status both read as invalid_state.
function result(code: string): AccountActionResult {
  const status = code === "validation" ? "invalid" : code === "not_available" ? "invalid_state" : code;
  if (status === "ok") revalidatePath("/admin/accounts");
  return { status: ["ok", "invalid", "invalid_state", "forbidden", "unauthenticated"].includes(status) ? status as AccountActionResult["status"] : "unavailable" };
}
// Reactivation goes only through admin_set_account_status, unchanged: admin at aal2, suspended -> active, audited.
export async function reactivateSuspendedAccount(userId: unknown): Promise<AccountActionResult> {
  if (!uuid(userId)) return { status: "invalid" };
  try {
    if (backendMode() === "demo") return { status: "unavailable" };
    return result((await callRpc(await createServerSupabase(), "admin_set_account_status", { p_user: userId, p_status: "active", p_reason: null })).code);
  } catch { return { status: "unavailable" }; }
}
