import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateBio, validateDisplayName, validateGender, validatePurposes, type Purpose } from "@/lib/onboarding-rules";

// The own profile row (profiles' own-row policy), read for the profile edit screen (docs/43 §4.5).
// Name, gender and hobbies are not edited here; the save sends their current values back unchanged.
export type MyProfile = { displayName: string; gender: "female" | "male" | "other"; bio: string; purposes: Purpose[]; hobbies: string[] };
type Result = { status: "ok"; profile: MyProfile } | { status: "unauthenticated" | "unavailable" };
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
