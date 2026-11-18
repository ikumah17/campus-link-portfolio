"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { validateBio, validatePurposes } from "@/lib/onboarding-rules";
import { callRpc } from "@/server/rpc";
import { loadMyProfile } from "@/server/profile-edit-data";

export type ProfileEditStatus = "ok" | "invalid" | "unauthenticated" | "unavailable";
// update_profile with the edited bio and purposes; name, gender and hobbies are re-read here and sent unchanged.
export async function saveMyProfile(input: unknown): Promise<{ status: ProfileEditStatus }> {
  try {
    if (backendMode() !== "supabase") return { status: "unavailable" };
    if (!input || typeof input !== "object") return { status: "invalid" };
    const { bio, purposes } = input as Record<string, unknown>;
    if (typeof bio !== "string" || !validateBio(bio) || !Array.isArray(purposes) || !purposes.every((p) => typeof p === "string") || !validatePurposes(purposes)) return { status: "invalid" };
    const client = await createServerSupabase();
    const current = await loadMyProfile(client);
    if (current.status !== "ok") return { status: current.status };
    const { displayName, gender, hobbies } = current.profile;
    const r = await callRpc(client, "update_profile", { p_display_name: displayName, p_gender: gender, p_bio: bio, p_purposes: purposes, p_hobbies: hobbies });
    if (r.code === "ok") { for (const path of ["/mypage", "/mypage/profile"]) revalidatePath(path); return { status: "ok" }; }
    return { status: r.code === "validation" ? "invalid" : r.code === "unauthenticated" ? "unauthenticated" : "unavailable" };
  } catch { return { status: "unavailable" }; }
}
