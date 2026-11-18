// MOBILE-002 (docs/42 §2): the app calls the web's RPCs directly with the user's JWT; the database decides as on the web.
// The same result mapping as the web's src/server/rpc.ts (which is server-only), with only the names the app uses:
// any other name is refused before a request is made. No admin_* or service_* RPC is ever called from the app.
export const RPC_NAMES = [
  "my_account", "start_onboarding", "update_birth_date", "set_affiliation", "update_profile",
  "complete_profile", "reorder_photos", "submit_verification", "withdraw_verification",
  // MOBILE-003 (docs/42 §2 #7–#11): discovery, chat, and the block and report entry points.
  "discover_profiles", "get_profile", "list_my_conversations", "list_messages", "send_message", "mark_read", "block_user", "submit_report",
  // MOBILE-LIKES-001 (docs/43 §2.4–§2.7): likes replace the requests; set_modes and the four request RPCs are gone (order 34).
  "like_user", "unlike_user", "list_my_likes", "get_like_state",
  // MOBILE-004 (docs/42 §2 #10–#14): privacy, the block list and own reports, pause, resume and deletion.
  "update_privacy_settings", "list_my_blocks", "unblock_user", "my_reports",
  "deactivate_account", "reactivate_account", "request_account_deletion",
] as const;
export type RpcName = typeof RPC_NAMES[number];

const refusalCodes = ["not_available", "invalid_state", "already_pending", "already_connected", "rate_limited", "mfa_required"] as const;
type RefusalCode = typeof refusalCodes[number];
type FailureCode = RefusalCode | "forbidden" | "validation" | "unauthenticated" | "unavailable";
export type RpcResult = { code: "ok"; data: unknown[] | { ref: string | null } } | { code: FailureCode; data: null };
type RpcError = { code?: string; message?: string; status?: number };
export interface RpcClient {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null; status?: number }>;
}

function errorCode(error: RpcError | null, status?: number): FailureCode {
  if (status === 401 || error?.status === 401 || ["PGRST301", "PGRST302"].includes(error?.code ?? "")) return "unauthenticated";
  if (error?.code === "P0001" && (error.message === "forbidden" || error.message === "validation")) return error.message;
  return "unavailable";
}

export async function callRpc(client: RpcClient, name: RpcName, args: Record<string, unknown> = {}): Promise<RpcResult> {
  if (!(RPC_NAMES as readonly string[]).includes(name)) throw new Error("Unknown RPC name");
  try {
    const { data, error, status } = await client.rpc(name, args);
    if (error || status === 401 || (status !== undefined && status >= 400)) return { code: errorCode(error, status), data: null };
    if (Array.isArray(data)) return { code: "ok", data };
    if (data && typeof data === "object" && "ok" in data && "code" in data) {
      if (data.ok === true && data.code === "ok" && "ref" in data && (data.ref === null || typeof data.ref === "string")) {
        return { code: "ok", data: { ref: data.ref } };
      }
      if (data.ok === false && refusalCodes.includes(data.code as RefusalCode)) {
        return { code: data.code as RefusalCode, data: null };
      }
    }
    return { code: "unavailable", data: null };
  } catch (error) {
    // Never log the error: it may carry provider text.
    const safeError = error && typeof error === "object" ? error as RpcError : null;
    return { code: errorCode(safeError), data: null };
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (value: unknown): value is string => typeof value === "string" && value.length === 36 && UUID.test(value);
