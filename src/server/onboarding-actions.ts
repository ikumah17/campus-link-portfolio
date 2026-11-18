"use server";

import "server-only";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { validateBio, validateBirthDate, validateDisplayName, validateGender, validatePurposes } from "@/lib/onboarding-validation";
import { callRpc, type RpcResult } from "@/server/rpc";
import { listMyPhotos } from "@/server/my-photos";

export type OnboardingInput = {
  displayName: string;
  gender: string;
  birthDate: string;
  adultDeclared: boolean;
  schoolId: string;
  departmentId: string;
  classId: string;
  // Optional purpose codes (order 34) and the one optional bio.
  purposes: string[];
  bio: string;
};
export type OnboardingResult = {
  status: "completed" | "saved_needs_photo" | "invalid" | "birth_locked" | "unauthenticated" | "unavailable";
  step?: number;
};
export type CompleteOnboardingResult = {
  status: "completed" | "needs_photo" | "needs_details" | "unauthenticated" | "unavailable";
};

export async function refreshOnboardingPhotos(): Promise<string[] | null> {
  if (backendMode() === "demo") return null;
  try {
    return await listMyPhotos(await createServerSupabase());
  } catch {
    return null;
  }
}

export async function completeOnboarding(): Promise<CompleteOnboardingResult> {
  if (backendMode() === "demo") return { status: "unavailable" };
  try {
    const client = await createServerSupabase();
    const result = await callRpc(client, "complete_profile");
    if (result.code === "ok") return { status: "completed" };
    if (result.code === "invalid_state") {
      const account = await callRpc(client, "my_account");
      if (account.code === "unauthenticated") return { status: "unauthenticated" };
      if (account.code !== "ok" || !Array.isArray(account.data) || account.data.length !== 1) return { status: "unavailable" };
      const row = account.data[0];
      if (!row || typeof row !== "object") return { status: "unavailable" };
      return { status: "has_active_photo" in row && row.has_active_photo === false ? "needs_photo" : "needs_details" };
    }
    return { status: result.code === "unauthenticated" ? "unauthenticated" : "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

function invalidStep(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return 0;
  const input = value as Record<string, unknown>;
  if (typeof input.displayName !== "string" || !validateDisplayName(input.displayName) ||
      typeof input.gender !== "string" || !validateGender(input.gender) ||
      typeof input.birthDate !== "string" || !validateBirthDate(input.birthDate, new Date()) || input.adultDeclared !== true) return 0;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if ([input.schoolId, input.departmentId, input.classId].some((id) => typeof id !== "string" || id.length !== 36 || !uuid.test(id))) return 1;
  if (!Array.isArray(input.purposes) || !Array.from(input.purposes).every((p) => typeof p === "string") || !validatePurposes(input.purposes)) return 3;
  if (typeof input.bio !== "string" || !validateBio(input.bio)) return 3;
}

function failure(result: RpcResult, step: number): OnboardingResult {
  return { status: result.code === "validation" ? "invalid" : result.code === "unauthenticated" ? "unauthenticated" : "unavailable", step };
}

export async function saveOnboarding(value: unknown): Promise<OnboardingResult> {
  if (backendMode() === "demo") return { status: "unavailable" };
  const invalid = invalidStep(value);
  if (invalid !== undefined) return { status: "invalid", step: invalid };
  const input = value as OnboardingInput;
  let step = 0;
  try {
    const client = await createServerSupabase();
    const account = await callRpc(client, "my_account");
    if (account.code !== "ok") return failure(account, step);
    const row = Array.isArray(account.data) ? account.data[0] : undefined;
    if (!row || typeof row !== "object" || !("has_profile" in row) || typeof row.has_profile !== "boolean" || !("profile_completed" in row) || typeof row.profile_completed !== "boolean") return { status: "unavailable", step };
    // A deleted account keeps the answer it had before order 18 hid its flags (deletion is offered only after completion).
    if (row.profile_completed || ("account_status" in row && row.account_status === "deleted")) return { status: "completed" };
    if (!row.has_profile) {
      const result = await callRpc(client, "start_onboarding", {
        p_display_name: input.displayName, p_gender: input.gender, p_birth_date: input.birthDate, p_adult_declared: input.adultDeclared,
      });
      if (result.code !== "ok") return failure(result, step);
    } else {
      if (!("birth_date" in row) || typeof row.birth_date !== "string") return { status: "unavailable", step };
      if (row.birth_date !== input.birthDate) {
        const result = await callRpc(client, "update_birth_date", { p_birth_date: input.birthDate });
        if (result.code === "invalid_state") return { status: "birth_locked", step };
        if (result.code !== "ok") return failure(result, step);
      }
    }
    step = 1;
    const affiliation = await callRpc(client, "set_affiliation", { p_school: input.schoolId, p_department: input.departmentId, p_class: input.classId });
    if (affiliation.code !== "ok") return failure(affiliation, step);
    step = 3;
    // Onboarding has no hobby field yet; all required SQL arguments are explicit (order 34, five arguments).
    const profile = await callRpc(client, "update_profile", {
      p_display_name: input.displayName, p_gender: input.gender, p_bio: input.bio, p_purposes: input.purposes, p_hobbies: [],
    });
    if (profile.code !== "ok") return failure(profile, step);
    step = 2;
    const complete = await callRpc(client, "complete_profile");
    if (complete.code === "ok") return { status: "completed" };
    if (complete.code === "invalid_state") return { status: "saved_needs_photo" };
    return failure(complete, step);
  } catch {
    // Only fixed status codes leave the action, never provider text or personal values.
    return { status: "unavailable", step };
  }
}
