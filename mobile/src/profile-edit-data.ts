import type { SupabaseClient } from "@supabase/supabase-js";
import { gate, type Gated } from "./discover-data";
import { callRpc, type RpcClient } from "./rpc";
import { validateBio, validateDisplayName, validateGender, validatePurposes, type Purpose } from "./shared";

// MOBILE-LIKES-001 (docs/43 §4.5): ports of the web's src/server/profile-edit-data.ts and profile-edit-actions.ts.
// The own profile row (profiles' own-row policy) is read for the edit screen; only the bio and the purposes are
// edited, and the save sends the current name, gender and hobbies back unchanged through update_profile.
export type MyProfile = { displayName: string; gender: "female" | "male" | "other"; bio: string; purposes: Purpose[]; hobbies: string[] };
export type ProfileEditStatus = "ok" | "invalid" | "unauthenticated" | "unavailable";
type Result = { status: "ok"; profile: MyProfile } | { status: "unauthenticated" | "unavailable" };
type DataClient = RpcClient & Pick<SupabaseClient, "from">;

export async function loadMyProfile(client: Pick<SupabaseClient, "from">): Promise<Result> {
  try {
    const r = await client.from("profiles").select("display_name, gender, bio, purposes, hobbies").limit(2);
    if (r.status === 401 || ["PGRST301", "PGRST302"].includes(r.error?.code ?? "")) return { status: "unauthenticated" };
    if (r.error || !Array.isArray(r.data) || r.data.length !== 1) return { status: "unavailable" };
    const row = r.data[0] as Record<string, unknown> | null;
    if (!row || typeof row.display_name !== "string" || !validateDisplayName(row.display_name) || typeof row.gender !== "string" || !validateGender(row.gender)) return { status: "unavailable" };
    // A bio hidden by a moderator is null, like an empty one.
    const bio = row.bio ?? "";
    if (typeof bio !== "string" || !validateBio(bio)) return { status: "unavailable" };
    if (!Array.isArray(row.purposes) || !row.purposes.every((p) => typeof p === "string") || !validatePurposes(row.purposes)) return { status: "unavailable" };
    const hobbies = row.hobbies ?? [];
    if (!Array.isArray(hobbies) || !hobbies.every((h) => typeof h === "string")) return { status: "unavailable" };
    return { status: "ok", profile: { displayName: row.display_name, gender: row.gender as MyProfile["gender"], bio, purposes: row.purposes, hobbies } };
  } catch { return { status: "unavailable" }; }
}

// src/app/mypage/profile/page.tsx: the gate, then the own row.
export const loadProfileEdit = (client: DataClient): Promise<Gated<Result>> => gate(client, () => loadMyProfile(client));

export async function saveMyProfile(client: DataClient, input: unknown): Promise<{ status: ProfileEditStatus }> {
  try {
    if (!input || typeof input !== "object") return { status: "invalid" };
    const { bio, purposes } = input as Record<string, unknown>;
    if (typeof bio !== "string" || !validateBio(bio) || !Array.isArray(purposes) || !purposes.every((p) => typeof p === "string") || !validatePurposes(purposes)) return { status: "invalid" };
    const current = await loadMyProfile(client);
    if (current.status !== "ok") return { status: current.status };
    const { displayName, gender, hobbies } = current.profile;
    const r = await callRpc(client, "update_profile", { p_display_name: displayName, p_gender: gender, p_bio: bio, p_purposes: purposes, p_hobbies: hobbies });
    if (r.code === "ok") return { status: "ok" };
    return { status: r.code === "validation" ? "invalid" : r.code === "unauthenticated" ? "unauthenticated" : "unavailable" };
  } catch { return { status: "unavailable" }; }
}
