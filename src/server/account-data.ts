import "server-only";
import { callRpc, type RpcClient } from "@/server/rpc";
import type { AccountState } from "@/server/account-rules";

type Result = { status: "ok"; accountStatus: AccountState } | { status: "unauthenticated" | "incomplete" | "deleted" | "unavailable" };
export async function loadAccountState(client: RpcClient): Promise<Result> {
  try {
    const account = await callRpc(client, "my_account");
    if (account.code === "unauthenticated") return { status: "unauthenticated" };
    if (account.code !== "ok" || !Array.isArray(account.data) || account.data.length !== 1) return { status: "unavailable" };
    const row = account.data[0] as Record<string, unknown> | null;
    if (!row || typeof row !== "object" || typeof row.profile_completed !== "boolean") return { status: "unavailable" };
    // Since order 18 a deleted account reads only its id and 'deleted' (profile_completed false), so check it first.
    if (row.account_status === "deleted") return { status: "deleted" };
    if (!row.profile_completed) return { status: "incomplete" };
    if (row.account_status === "active" || row.account_status === "deactivated" || row.account_status === "suspended") return { status: "ok", accountStatus: row.account_status };
  } catch {
    // Never forward account values or provider errors to the page.
  }
  return { status: "unavailable" };
}
