"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { isStaffRole, readStaff, staffHandle } from "@/server/admin-staff";
import { callRpc } from "@/server/rpc";

export type StaffActionResult = { status: "ok" | "invalid" | "not_found" | "invalid_state" | "mfa_required" | "forbidden" | "unauthenticated" | "unavailable" };
function result(code: string): StaffActionResult {
  const status = code === "validation" ? "invalid" : code === "not_available" ? "not_found" : code;
  if (status === "ok") revalidatePath("/admin/staff");
  return { status: ["ok", "invalid", "not_found", "invalid_state", "mfa_required", "forbidden", "unauthenticated"].includes(status) ? status as StaffActionResult["status"] : "unavailable" };
}
export async function grantRole(email: unknown, role: unknown): Promise<StaffActionResult> {
  if (typeof email !== "string" || [...email.trim()].length < 3 || [...email.trim()].length > 254 ||
    email.trim().split("@").length !== 2 || !isStaffRole(role)) return { status: "invalid" };
  try {
    if (backendMode() === "demo") return { status: "unavailable" };
    return result((await callRpc(await createServerSupabase(), "admin_grant_role_by_email", { p_email: email.trim(), p_role: role })).code);
  } catch { return { status: "unavailable" }; }
}
export async function revokeRole(handle: unknown, role: unknown): Promise<StaffActionResult> {
  if (typeof handle !== "string" || !/^[0-9a-f]{64}$/.test(handle) || !isStaffRole(role)) return { status: "invalid" };
  try {
    if (backendMode() === "demo") return { status: "unavailable" };
    const client = await createServerSupabase();
    const current = await readStaff(client);
    if (current.status !== "ok") return current;
    const target = current.rows.find(r => staffHandle(r.user_id) === handle);
    if (!target) return { status: "invalid_state" };
    return result((await callRpc(client, "admin_revoke_role", { p_user: target.user_id, p_role: role })).code);
  } catch { return { status: "unavailable" }; }
}
