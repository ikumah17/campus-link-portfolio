import "server-only";
import { callRpc, type RpcClient } from "@/server/rpc";

export type VerificationRow = {
  id: string; kind: "age" | "enrollment";
  status: "submitted" | "in_review" | "approved" | "rejected" | "withdrawn" | "revoked" | "superseded";
  created_at: string | null; decided_at: string | null; decision_reason: string | null; valid_until: string | null;
};
export type VerificationState = {
  status: "ok";
  account: { has_profile: boolean; age_verified: boolean; affiliation_status: "unconfirmed" | "pending" | "confirmed" | "rejected" | null; affiliation_confirmed: boolean };
  age: VerificationRow | null; enrollment: VerificationRow | null;
};
interface Client extends RpcClient {
  from(table: string): { select(columns: string): { order(column: string, options: { ascending: boolean }): PromiseLike<{ data: unknown; error: unknown }> } };
}
export async function loadMyVerification(client: Client): Promise<VerificationState | { status: "unauthenticated" | "unavailable" }> {
  try {
    const result = await callRpc(client, "my_account");
    if (result.code === "unauthenticated") return { status: "unauthenticated" };
    if (result.code !== "ok" || !Array.isArray(result.data) || result.data.length !== 1) return { status: "unavailable" };
    const a = result.data[0] as (VerificationState["account"] & { account_status?: unknown }) | null;
    // A deleted account keeps its Auth user until retention; its verification history is not shown again.
    if (a && typeof a === "object" && a.account_status === "deleted") return { status: "unavailable" };
    if (!a || typeof a.has_profile !== "boolean" || typeof a.age_verified !== "boolean" || typeof a.affiliation_confirmed !== "boolean" ||
      !(a.affiliation_status === null || ["unconfirmed", "pending", "confirmed", "rejected"].includes(a.affiliation_status))) return { status: "unavailable" };
    const { data, error } = await client.from("verification_submissions").select("id,kind,status,created_at,decided_at,decision_reason,valid_until").order("created_at", { ascending: false });
    if (error || !Array.isArray(data)) return { status: "unavailable" };
    const rows: VerificationRow[] = [];
    for (const row of data) {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || row.id.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id) ||
        !["age", "enrollment"].includes(row.kind) || !["submitted", "in_review", "approved", "rejected", "withdrawn", "revoked", "superseded"].includes(row.status) ||
        !["created_at", "decided_at", "decision_reason", "valid_until"].every(k => row[k] === null || typeof row[k] === "string")) return { status: "unavailable" };
      rows.push({ id: row.id, kind: row.kind, status: row.status, created_at: row.created_at, decided_at: row.decided_at, decision_reason: row.decision_reason, valid_until: row.valid_until });
    }
    return { status: "ok", account: { has_profile: a.has_profile, age_verified: a.age_verified, affiliation_status: a.affiliation_status, affiliation_confirmed: a.affiliation_confirmed }, age: rows.find(r => r.kind === "age") ?? null, enrollment: rows.find(r => r.kind === "enrollment") ?? null };
  } catch { return { status: "unavailable" }; }
}
