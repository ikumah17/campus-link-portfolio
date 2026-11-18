import "server-only";

// Public RPCs in docs/04_DATABASE.md §5. Database grants and RLS remain authoritative.
// Order 34 (docs/43) dropped set_modes and the four request RPCs; the likes RPCs replace them.
export const RPC_NAMES = [
  "discover_profiles", "get_profile", "authorize_photo_delivery",
  "start_onboarding", "update_birth_date", "update_profile", "set_affiliation",
  "complete_profile", "remove_photo", "reorder_photos", "service_register_photo", "reserve_photo_upload",
  "service_reserve_signin", "service_reserve_signup", "reserve_mfa_attempt",
  "submit_verification", "withdraw_verification", "update_privacy_settings", "my_account",
  "deactivate_account", "reactivate_account", "request_account_deletion",
  "like_user", "unlike_user", "list_my_likes", "get_like_state",
  "end_connection", "list_my_conversations", "list_messages",
  "send_message", "mark_read", "block_user", "unblock_user", "list_my_blocks", "submit_report", "my_reports",
  "admin_list_submissions", "admin_claim_submission", "admin_release_submission", "admin_get_submission",
  "admin_authorize_document_view", "admin_decide_submission", "admin_revoke_verification",
  "admin_set_account_status", "admin_upsert_school", "admin_upsert_department", "admin_upsert_class",
  "admin_list_reports", "admin_get_report", "admin_update_report", "admin_grant_role", "admin_revoke_role", "admin_list_affiliations",
  "admin_list_staff", "admin_grant_role_by_email", "my_staff_roles", "admin_list_suspended_accounts",
  "admin_get_report_content", "admin_authorize_report_photo", "admin_hide_reported_content", "admin_unhide_reported_content",
] as const;

const refusalCodes = ["not_available", "invalid_state", "already_pending", "already_connected", "rate_limited", "mfa_required"] as const;
type RefusalCode = typeof refusalCodes[number];
type FailureCode = RefusalCode | "forbidden" | "validation" | "unauthenticated" | "unavailable";
export type RpcResult = { code: "ok"; data: unknown[] | { ref: string | null } } | { code: FailureCode; data: null };
type RpcError = { code?: string; message?: string; status?: number };
export interface RpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null; status?: number }>;
}

function errorCode(error: RpcError | null, status?: number): FailureCode {
  if (status === 401 || error?.status === 401 || ["PGRST301", "PGRST302"].includes(error?.code ?? "")) return "unauthenticated";
  if (error?.code === "P0001" && (error.message === "forbidden" || error.message === "validation")) return error.message;
  return "unavailable";
}

export async function callRpc(client: RpcClient, name: string, args: Record<string, unknown> = {}): Promise<RpcResult> {
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
    const safeError = error && typeof error === "object" ? error as RpcError : null;
    return { code: errorCode(safeError), data: null };
  }
}
