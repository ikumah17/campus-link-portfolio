import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callRpc, type RpcClient } from "@/server/rpc";

export type MyPageData = {
  name: string;
  accountStatus: "active" | "deactivated" | "suspended" | "deleted";
  ageVerified: boolean;
  affiliation: "confirmed" | "pending" | "rejected" | "unconfirmed" | "expired";
  eligible: boolean;
};
type Result = { status: "ok"; page: MyPageData } | { status: "unauthenticated" | "incomplete" | "unavailable" };
export async function loadMyPage(client: RpcClient & Pick<SupabaseClient, "from">): Promise<Result> {
  try {
    const account = await callRpc(client, "my_account");
    if (account.code === "unauthenticated") return { status: "unauthenticated" };
    if (account.code !== "ok" || !Array.isArray(account.data) || account.data.length !== 1) return { status: "unavailable" };
    const row = account.data[0] as Record<string, unknown> | null;
    if (!row || typeof row !== "object" || typeof row.profile_completed !== "boolean") return { status: "unavailable" };
    // Since order 18 a deleted account reads only its id and 'deleted' (profile_completed false), so check it first.
    if (row.account_status === "deleted") return { status: "unavailable" };
    // A user before onboarding has no profile (and hence null account/affiliation enums).
    if (!row.profile_completed) return { status: "incomplete" };
    if (!["active", "deactivated", "suspended", "deleted"].includes(row.account_status as string) ||
        !["confirmed", "pending", "rejected", "unconfirmed"].includes(row.affiliation_status as string) ||
        ["age_verified", "affiliation_confirmed", "eligible"].some(key => typeof row[key] !== "boolean")) return { status: "unavailable" };
    const names = await client.from("profiles").select("display_name").limit(2);
    if (names.status === 401 || ["PGRST301", "PGRST302"].includes(names.error?.code ?? "")) return { status: "unauthenticated" };
    if (names.error || !Array.isArray(names.data) || names.data.length !== 1) return { status: "unavailable" };
    const name = names.data[0]?.display_name;
    if (typeof name !== "string" || name.trim().length === 0 || Array.from(name).length > 20) return { status: "unavailable" };
    return { status: "ok", page: {
      name, accountStatus: row.account_status as MyPageData["accountStatus"], ageVerified: row.age_verified as boolean,
      affiliation: row.affiliation_status === "confirmed" && !row.affiliation_confirmed ? "expired" : row.affiliation_status as MyPageData["affiliation"],
      eligible: row.eligible as boolean,
    } };
  } catch { return { status: "unavailable" }; }
}
