import type { SupabaseClient } from "@supabase/supabase-js";
import { callRpc, isUuid, type RpcClient, type RpcResult } from "./rpc";
import { validateBio, validateBirthDate, validateDisplayName, validateGender, validatePurposes } from "./shared";

// MOBILE-002 (docs/42 §2 #4): ports of the web's src/server/onboarding-actions.ts and affiliation-master.ts. The same
// RPCs in the same order with the user's own JWT; the database stays the authority (an under-18 birth date is never
// stored, docs/42 §2 #4). Only fixed status codes leave these functions, never provider text or the birth date.
export type OnboardingInput = {
  displayName: string;
  gender: string;
  birthDate: string;
  adultDeclared: boolean;
  schoolId: string;
  departmentId: string;
  classId: string;
  // Optional purpose codes (order 34) and the one optional bio (MOBILE-LIKES-001, docs/43 §4.4).
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
export type Affiliation = {
  id: string;
  name: string;
  departments: { id: string; name: string; classes: { id: string; name: string }[] }[];
};
export type OnboardingStart =
  | { status: "ok"; master: Affiliation[]; initialPhotos?: string[] }
  | { status: "completed" | "unavailable" | "unauthenticated" };

// src/server/affiliation-master.ts loadAffiliationMaster.
export async function loadAffiliationMaster(client: Pick<SupabaseClient, "from">): Promise<Affiliation[] | null> {
  try {
    const results = await Promise.all([
      client.from("schools").select("id,name").eq("is_active", true).order("name"),
      client.from("departments").select("id,name,school_id").eq("is_active", true).order("name"),
      client.from("classes").select("id,name,department_id").eq("is_active", true).order("name"),
    ]);
    if (results.some(({ data, error }) => error || !Array.isArray(data))) return null;
    const [schools, departments, classes] = results.map(({ data }) => data as Record<string, unknown>[]);
    const named = (row: Record<string, unknown>) => typeof row.id === "string" && typeof row.name === "string";
    if (schools.some((row) => !named(row)) || departments.some((row) => !named(row) || typeof row.school_id !== "string") ||
        classes.some((row) => !named(row) || typeof row.department_id !== "string")) return null;
    return schools.map((school) => ({
      id: school.id as string,
      name: school.name as string,
      departments: departments.filter((dept) => dept.school_id === school.id).map((dept) => ({
        id: dept.id as string,
        name: dept.name as string,
        classes: classes.filter((cls) => cls.department_id === dept.id).map((cls) => ({ id: cls.id as string, name: cls.name as string })),
      })),
    }));
  } catch {
    return null;
  }
}

/**
 * The web's src/app/onboarding/page.tsx load: the master, the account (a deleted account gets nothing) and, for a
 * saved but unfinished profile, its photos so the screen opens on the photo step.
 */
export async function loadOnboarding(client: RpcClient & Pick<SupabaseClient, "from">,
  listPhotos: (client: Pick<SupabaseClient, "from">) => Promise<string[] | null>): Promise<OnboardingStart> {
  try {
    const master = await loadAffiliationMaster(client);
    const account = await callRpc(client, "my_account");
    if (account.code === "unauthenticated") return { status: "unauthenticated" };
    const row = account.code === "ok" && Array.isArray(account.data) ? account.data[0] as Record<string, unknown> | undefined : undefined;
    const available = !!row && typeof row === "object" && typeof row.profile_completed === "boolean" && row.account_status !== "deleted";
    if (!available) return { status: "unavailable" };
    if (row.profile_completed) return { status: "completed" };
    if (master === null) return { status: "unavailable" };
    if (row.has_profile !== true) return { status: "ok", master };
    const initialPhotos = await listPhotos(client);
    return initialPhotos === null ? { status: "unavailable" } : { status: "ok", master, initialPhotos };
  } catch {
    return { status: "unavailable" };
  }
}

export async function completeOnboarding(client: RpcClient): Promise<CompleteOnboardingResult> {
  try {
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

/** YYYY-MM-DD from the three fields, or "" when a field is not a number; the shared check decides the rest. */
export function birthDateOf(year: string, month: string, day: string): string {
  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(month) || !/^\d{1,2}$/.test(day)) return "";
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function invalidStep(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return 0;
  const input = value as Record<string, unknown>;
  if (typeof input.displayName !== "string" || !validateDisplayName(input.displayName) ||
      typeof input.gender !== "string" || !validateGender(input.gender) ||
      typeof input.birthDate !== "string" || !validateBirthDate(input.birthDate, new Date()) || input.adultDeclared !== true) return 0;
  if ([input.schoolId, input.departmentId, input.classId].some((id) => !isUuid(id))) return 1;
  if (!Array.isArray(input.purposes) || !Array.from(input.purposes).every((p) => typeof p === "string") || !validatePurposes(input.purposes)) return 3;
  if (typeof input.bio !== "string" || !validateBio(input.bio)) return 3;
}

function failure(result: RpcResult, step: number): OnboardingResult {
  return { status: result.code === "validation" ? "invalid" : result.code === "unauthenticated" ? "unauthenticated" : "unavailable", step };
}

// src/server/onboarding-actions.ts saveOnboarding.
export async function saveOnboarding(client: RpcClient, value: unknown): Promise<OnboardingResult> {
  const invalid = invalidStep(value);
  if (invalid !== undefined) return { status: "invalid", step: invalid };
  const input = value as OnboardingInput;
  let step = 0;
  try {
    const account = await callRpc(client, "my_account");
    if (account.code !== "ok") return failure(account, step);
    const row = Array.isArray(account.data) ? account.data[0] : undefined;
    if (!row || typeof row !== "object" || !("has_profile" in row) || typeof row.has_profile !== "boolean" ||
        !("profile_completed" in row) || typeof row.profile_completed !== "boolean") return { status: "unavailable", step };
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
    return { status: "unavailable", step };
  }
}
