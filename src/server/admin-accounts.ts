import "server-only";
import { callRpc, type RpcClient } from "@/server/rpc";

// admin_list_suspended_accounts (order 23): the minimum an admin needs to lift a suspension.
export type SuspendedRow = { userId: string; shortId: string; name: string; suspendedAt: string | null; reason: string | null };
type Failure = { status: "forbidden" | "unauthenticated" | "unavailable" };
type RawSuspended = { user_id: string; display_name: string; suspended_at: string | null; reason: string | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function valid(value: unknown): value is RawSuspended {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).length === 4 && typeof r.user_id === "string" && uuid.test(r.user_id) &&
    typeof r.display_name === "string" && [...r.display_name].length >= 1 && [...r.display_name].length <= 20 &&
    (r.suspended_at === null || typeof r.suspended_at === "string" && Number.isFinite(Date.parse(r.suspended_at))) &&
    (r.reason === null || typeof r.reason === "string" && /^[a-z0-9_]{1,64}$/.test(r.reason));
}
export async function listSuspendedAccounts(client: RpcClient): Promise<{ status: "ok"; rows: SuspendedRow[] } | Failure> {
  try {
    const result = await callRpc(client, "admin_list_suspended_accounts");
    if (result.code !== "ok") return { status: result.code === "forbidden" || result.code === "unauthenticated" ? result.code : "unavailable" };
    if (!Array.isArray(result.data) || !result.data.every(valid)) return { status: "unavailable" };
    const rows = result.data as RawSuspended[];
    if (new Set(rows.map(r => r.user_id)).size !== rows.length) return { status: "unavailable" };
    return { status: "ok", rows: rows.map(r => ({ userId: r.user_id, shortId: `#${r.user_id.slice(0, 8)}`, name: r.display_name, suspendedAt: r.suspended_at, reason: r.reason })) };
  } catch { return { status: "unavailable" }; }
}
