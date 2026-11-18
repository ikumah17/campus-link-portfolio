import "server-only";
import { createHash } from "node:crypto";
import { callRpc, type RpcClient } from "@/server/rpc";

export type StaffRole = "admin" | "moderator" | "reviewer";
// acting[i] says whether roles[i] acts (order 35, private.staff_role_effective); a listed role may not act.
export type StaffRow = { handle: string; label: string; name: string | null; roles: StaffRole[]; acting: boolean[]; isMe: boolean };
type Failure = { status: "forbidden" | "unauthenticated" | "unavailable" };
type RawStaff = { user_id: string; display_name: string | null; roles: StaffRole[]; is_me: boolean; acting: boolean[] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function staffHandle(id: string): string { return createHash("sha256").update(id).digest("hex"); }
export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && ["admin", "moderator", "reviewer"].includes(value);
}
function valid(value: unknown): value is RawStaff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return typeof r.user_id === "string" && uuid.test(r.user_id) &&
    (r.display_name === null || typeof r.display_name === "string" && [...r.display_name].length >= 1 && [...r.display_name].length <= 20) &&
    Array.isArray(r.roles) && r.roles.length > 0 && Array.from(r.roles).every(isStaffRole) && new Set(r.roles).size === r.roles.length &&
    typeof r.is_me === "boolean" &&
    Array.isArray(r.acting) && r.acting.length === r.roles.length && Array.from(r.acting).every(a => typeof a === "boolean");
}
// Raw ids are available only to server callers resolving a fresh revoke target.
export async function readStaff(client: RpcClient): Promise<{ status: "ok"; rows: RawStaff[] } | Failure> {
  try {
    const result = await callRpc(client, "admin_list_staff");
    if (result.code !== "ok") return { status: result.code === "forbidden" || result.code === "unauthenticated" ? result.code : "unavailable" };
    if (!Array.isArray(result.data)) return { status: "unavailable" };
    const rows: RawStaff[] = [];
    for (const value of result.data) {
      if (!valid(value)) return { status: "unavailable" };
      rows.push(value);
    }
    if (new Set(rows.map(r => r.user_id)).size !== rows.length || rows.filter(r => r.is_me).length > 1) return { status: "unavailable" };
    return { status: "ok", rows };
  } catch { return { status: "unavailable" }; }
}
export async function listStaff(client: RpcClient): Promise<{ status: "ok"; rows: StaffRow[] } | Failure> {
  const result = await readStaff(client);
  if (result.status !== "ok") return result;
  return { status: "ok", rows: result.rows.map(r => {
    const handle = staffHandle(r.user_id);
    return { handle, label: `担当 #${handle.slice(0, 8)}`, name: r.display_name, roles: r.roles, acting: r.acting, isMe: r.is_me };
  }) };
}
