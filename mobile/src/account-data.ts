import type { SupabaseClient } from "@supabase/supabase-js";
import { callRpc, isUuid, type RpcClient } from "./rpc";

// MOBILE-002 (docs/42 §2 #4–#6): ports of the web's src/server/mypage-data.ts, verification-data.ts,
// verification-actions.ts and my-photos.ts, called with the user's own JWT. Own-row RLS and the RPCs decide; these
// only read the answers into fixed status codes. No provider text, birth date or token leaves these functions.
export type DataClient = RpcClient & Pick<SupabaseClient, "from">;
export type Failure = { status: "unauthenticated" | "unavailable" };

/** The app's version of the web's profileGate: where a signed-in user belongs (docs/42 §2, the end of the table). */
export type Gate = { status: "onboarding" | "complete" | "deleted" } | Failure;

export async function accountGate(client: RpcClient): Promise<Gate> {
  try {
    const result = await callRpc(client, "my_account");
    if (result.code === "unauthenticated") return { status: "unauthenticated" };
    if (result.code !== "ok" || !Array.isArray(result.data) || result.data.length !== 1) return { status: "unavailable" };
    const row = result.data[0] as Record<string, unknown> | null;
    if (!row || typeof row !== "object" || typeof row.profile_completed !== "boolean") return { status: "unavailable" };
    // Since order 18 a deleted account reads only its id and 'deleted', so it is checked first.
    if (row.account_status === "deleted") return { status: "deleted" };
    return { status: row.profile_completed ? "complete" : "onboarding" };
  } catch {
    return { status: "unavailable" };
  }
}

export type MyPageData = {
  name: string;
  accountStatus: "active" | "deactivated" | "suspended" | "deleted";
  ageVerified: boolean;
  affiliation: "confirmed" | "pending" | "rejected" | "unconfirmed" | "expired";
  eligible: boolean;
};

// src/server/mypage-data.ts loadMyPage.
export async function loadMyPage(client: DataClient): Promise<{ status: "ok"; page: MyPageData } | { status: "incomplete" } | Failure> {
  try {
    const account = await callRpc(client, "my_account");
    if (account.code === "unauthenticated") return { status: "unauthenticated" };
    if (account.code !== "ok" || !Array.isArray(account.data) || account.data.length !== 1) return { status: "unavailable" };
    const row = account.data[0] as Record<string, unknown> | null;
    if (!row || typeof row !== "object" || typeof row.profile_completed !== "boolean") return { status: "unavailable" };
    if (row.account_status === "deleted") return { status: "unavailable" };
    if (!row.profile_completed) return { status: "incomplete" };
    if (!["active", "deactivated", "suspended", "deleted"].includes(row.account_status as string) ||
        !["confirmed", "pending", "rejected", "unconfirmed"].includes(row.affiliation_status as string) ||
        ["age_verified", "affiliation_confirmed", "eligible"].some((key) => typeof row[key] !== "boolean")) return { status: "unavailable" };
    const names = await client.from("profiles").select("display_name").limit(2);
    if (names.status === 401 || ["PGRST301", "PGRST302"].includes(names.error?.code ?? "")) return { status: "unauthenticated" };
    if (names.error || !Array.isArray(names.data) || names.data.length !== 1) return { status: "unavailable" };
    const name: unknown = names.data[0]?.display_name;
    if (typeof name !== "string" || name.trim().length === 0 || Array.from(name).length > 20) return { status: "unavailable" };
    return { status: "ok", page: {
      name, accountStatus: row.account_status as MyPageData["accountStatus"], ageVerified: row.age_verified as boolean,
      affiliation: row.affiliation_status === "confirmed" && !row.affiliation_confirmed ? "expired" : row.affiliation_status as MyPageData["affiliation"],
      eligible: row.eligible as boolean,
    } };
  } catch {
    return { status: "unavailable" };
  }
}

// src/server/my-photos.ts listMyPhotos: the active photos in order, or null.
export async function listMyPhotos(client: Pick<SupabaseClient, "from">): Promise<string[] | null> {
  try {
    const { data, error } = await client.from("profile_photos").select("id,position").eq("status", "active").order("position");
    if (error || !Array.isArray(data)) return null;
    if (data.some((row) => !row || !isUuid(row.id) || !Number.isInteger(row.position) || row.position < 0 || row.position > 5)) return null;
    return data.map((row) => row.id as string);
  } catch {
    return null;
  }
}

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
const SUBMISSION_STATUSES = ["submitted", "in_review", "approved", "rejected", "withdrawn", "revoked", "superseded"];

// src/server/verification-data.ts loadMyVerification.
export async function loadMyVerification(client: DataClient): Promise<VerificationState | Failure> {
  try {
    const result = await callRpc(client, "my_account");
    if (result.code === "unauthenticated") return { status: "unauthenticated" };
    if (result.code !== "ok" || !Array.isArray(result.data) || result.data.length !== 1) return { status: "unavailable" };
    const a = result.data[0] as (VerificationState["account"] & { account_status?: unknown }) | null;
    if (a && typeof a === "object" && a.account_status === "deleted") return { status: "unavailable" };
    if (!a || typeof a.has_profile !== "boolean" || typeof a.age_verified !== "boolean" || typeof a.affiliation_confirmed !== "boolean" ||
      !(a.affiliation_status === null || ["unconfirmed", "pending", "confirmed", "rejected"].includes(a.affiliation_status))) return { status: "unavailable" };
    const { data, error } = await client.from("verification_submissions")
      .select("id,kind,status,created_at,decided_at,decision_reason,valid_until").order("created_at", { ascending: false });
    if (error || !Array.isArray(data)) return { status: "unavailable" };
    const rows: VerificationRow[] = [];
    for (const row of data) {
      if (!row || typeof row !== "object" || !isUuid(row.id) || !["age", "enrollment"].includes(row.kind) || !SUBMISSION_STATUSES.includes(row.status) ||
        !(["created_at", "decided_at", "decision_reason", "valid_until"] as const).every((k) => row[k] === null || typeof row[k] === "string")) return { status: "unavailable" };
      rows.push({ id: row.id, kind: row.kind, status: row.status, created_at: row.created_at, decided_at: row.decided_at, decision_reason: row.decision_reason, valid_until: row.valid_until });
    }
    return {
      status: "ok",
      account: { has_profile: a.has_profile, age_verified: a.age_verified, affiliation_status: a.affiliation_status, affiliation_confirmed: a.affiliation_confirmed },
      age: rows.find((r) => r.kind === "age") ?? null, enrollment: rows.find((r) => r.kind === "enrollment") ?? null,
    };
  } catch {
    return { status: "unavailable" };
  }
}

export type VerificationResult = { status: "ok" | "invalid" | "invalid_state" | "unauthenticated" | "unavailable" };
// Only the synthetic samples, as on the web: no real document is ever uploaded (docs/42 §2 #6, docs/37 §1).
export const SYNTHETIC_SAMPLES = ["synthetic:sample-1", "synthetic:sample-2", "synthetic:sample-3"] as const;

// src/server/verification-actions.ts submitVerification.
export async function submitVerification(client: RpcClient, kind: unknown, refs: unknown): Promise<VerificationResult> {
  if ((kind !== "age" && kind !== "enrollment") || !Array.isArray(refs) || refs.length < 1 || refs.length > 3 || new Set(refs).size !== refs.length ||
    !Array.from(refs).every((r) => typeof r === "string" && r.length === 18 && /^synthetic:sample-[1-3]$/.test(r))) return { status: "invalid" };
  try {
    const r = await callRpc(client, "submit_verification", { p_kind: kind, p_document_refs: refs });
    return { status: r.code === "validation" ? "invalid" : ["ok", "invalid_state", "unauthenticated"].includes(r.code) ? r.code as "ok" | "invalid_state" | "unauthenticated" : "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

// src/server/verification-actions.ts withdrawVerification.
export async function withdrawVerification(client: RpcClient, id: unknown): Promise<VerificationResult> {
  if (!isUuid(id)) return { status: "invalid" };
  try {
    const r = await callRpc(client, "withdraw_verification", { p_id: id });
    return { status: r.code === "not_available" ? "invalid_state" : r.code === "validation" ? "invalid" : ["ok", "invalid_state", "unauthenticated"].includes(r.code) ? r.code as "ok" | "invalid_state" | "unauthenticated" : "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
