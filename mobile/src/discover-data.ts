import type { SupabaseClient } from "@supabase/supabase-js";
import { accountGate, type Failure } from "./account-data";
import { loadAffiliationMaster } from "./onboarding-data";
import { callRpc, isUuid, type RpcClient } from "./rpc";
import { PURPOSE_LABELS, type Purpose } from "./shared";

// MOBILE-003 (docs/42 §2 #7): ports of the web's src/server/discover-data.ts and the condition rules of
// src/lib/discover-gateway.ts (which imports the demo data, so it is not shared). discover_profiles and get_profile are
// called with the user's own JWT; an unviewable and a missing profile give the same empty answer (P5), and no count
// is ever read or shown. MOBILE-LIKES-001: one list since order 34 (no mode); an old ?mode= param is ignored.
export const PAGE_SIZE = 20;
export type Gender = "female" | "male" | "other";
export const genders: readonly { id: Gender; label: string }[] = [{ id: "female", label: "女性" }, { id: "male", label: "男性" }, { id: "other", label: "その他" }];
export type SearchConditions = { min?: number; max?: number; genders: Gender[]; schoolIds: string[] };
export type Schools = readonly { id: string; name: string }[];
export type LiveProfile = {
  id: string; name: string; age: number; gender: Gender; school: string; department: string | null; class: string | null;
  bio: string; purposes: Purpose[]; hobbies: string[]; photoIds: string[];
};
type DataClient = RpcClient & Pick<SupabaseClient, "from">;

// purposes: the fixed codes in their stored order (order 34, docs/43 §1.2); the screens show their labels.
const isPurposes = (v: unknown): v is Purpose[] => Array.isArray(v) && v.length <= 5 && new Set(v).size === v.length &&
  v.every((x) => typeof x === "string" && Object.hasOwn(PURPOSE_LABELS, x));

// src/lib/discover-gateway.ts normalizeAge, normalizeConditions and conditionLabels.
export function normalizeAge(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return undefined;
  const age = Number(value);
  return Number.isInteger(age) && age >= 18 && age <= 120 ? age : undefined;
}
export function normalizeConditions(input: { min?: unknown; max?: unknown; genders?: unknown[]; schoolIds?: unknown[] }, schools: Schools): SearchConditions {
  let min = normalizeAge(input.min), max = normalizeAge(input.max);
  if (min !== undefined && max !== undefined && min > max) { min = undefined; max = undefined; }
  return { min, max,
    genders: [...new Set((input.genders ?? []).filter((v): v is Gender => genders.some((g) => g.id === v)))],
    schoolIds: [...new Set((input.schoolIds ?? []).filter((v): v is string => schools.some((s) => s.id === v)))],
  };
}
export function conditionLabels(conditions: SearchConditions, schools: Schools): string[] {
  return [
    ...(conditions.min !== undefined || conditions.max !== undefined ? [`${conditions.min ?? 18}〜${conditions.max ?? 120}歳`] : []),
    ...conditions.genders.map((id) => genders.find((g) => g.id === id)!.label),
    ...conditions.schoolIds.map((id) => schools.find((s) => s.id === id)!.name),
  ];
}

/** The route params of the conditions: the app's counterpart of the web's searchHref query. */
export type DiscoverParams = { min?: string; max?: string; g?: string; s?: string };
export function conditionParams(conditions: SearchConditions): Record<string, string> {
  return {
    ...(conditions.min !== undefined ? { min: String(conditions.min) } : {}),
    ...(conditions.max !== undefined ? { max: String(conditions.max) } : {}),
    ...(conditions.genders.length ? { g: conditions.genders.join(",") } : {}),
    ...(conditions.schoolIds.length ? { s: conditions.schoolIds.join(",") } : {}),
  };
}
const single = (value: unknown) => typeof value === "string" ? value : undefined;
const list = (value: unknown) => typeof value === "string" && value ? value.split(",") : [];
export function conditionsFromParams(params: DiscoverParams, schools: Schools): SearchConditions {
  return normalizeConditions({ min: single(params.min), max: single(params.max), genders: list(params.g), schoolIds: list(params.s) }, schools);
}

// src/server/discover-data.ts parseProfile.
export function parseProfile(value: unknown): LiveProfile | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const nullable = (v: unknown) => v === null || typeof v === "string";
  if (!isUuid(r.user_id) || typeof r.display_name !== "string" || !Number.isInteger(r.age) || !["female", "male", "other"].includes(r.gender as string) ||
    typeof r.school_name !== "string" || !nullable(r.department_name) || !nullable(r.class_name) || !nullable(r.bio) || !isPurposes(r.purposes) ||
    !(r.hobbies === null || (Array.isArray(r.hobbies) && r.hobbies.every((v) => typeof v === "string"))) ||
    !Array.isArray(r.photo_ids) || !r.photo_ids.every(isUuid)) return null;
  return {
    id: r.user_id, name: r.display_name, age: r.age as number, gender: r.gender as Gender, school: r.school_name,
    department: r.department_name as string | null, class: r.class_name as string | null, bio: (r.bio as string | null) ?? "",
    purposes: r.purposes, hobbies: (r.hobbies as string[] | null) ?? [], photoIds: r.photo_ids as string[],
  };
}

const fail = (code: string): Failure => ({ status: code === "unauthenticated" ? "unauthenticated" : "unavailable" });

export async function listProfiles(client: RpcClient, p: SearchConditions & { after?: string }): Promise<Failure | { status: "ok"; profiles: LiveProfile[]; nextAfter: string | null }> {
  const r = await callRpc(client, "discover_profiles", {
    p_min_age: p.min ?? null, p_max_age: p.max ?? null, p_genders: p.genders.length ? p.genders : null,
    p_school_ids: p.schoolIds.length ? p.schoolIds : null, p_after: p.after ?? null, p_limit: PAGE_SIZE,
  });
  if (r.code !== "ok") return fail(r.code);
  if (!Array.isArray(r.data)) return fail("unavailable");
  const profiles = r.data.map(parseProfile);
  if (profiles.some((v) => v === null)) return fail("unavailable");
  const valid = profiles as LiveProfile[];
  return { status: "ok", profiles: valid, nextAfter: valid.length === PAGE_SIZE ? valid[valid.length - 1].id : null };
}

export async function getProfile(client: RpcClient, id: string): Promise<Failure | { status: "ok"; profile: LiveProfile | null }> {
  const r = await callRpc(client, "get_profile", { p_target: id });
  if (r.code !== "ok") return fail(r.code);
  if (!Array.isArray(r.data) || r.data.length > 1) return fail("unavailable");
  if (!r.data.length) return { status: "ok", profile: null };
  const profile = parseProfile(r.data[0]);
  return profile ? { status: "ok", profile } : fail("unavailable");
}

export async function viewerEligible(client: RpcClient): Promise<boolean | Failure> {
  const r = await callRpc(client, "my_account");
  if (r.code !== "ok") return fail(r.code);
  const row: unknown = Array.isArray(r.data) && r.data.length === 1 ? r.data[0] : null;
  if (!row || typeof row !== "object" || !("eligible" in row) || typeof row.eligible !== "boolean") return fail("unavailable");
  return row.eligible;
}

/** The gate of every signed-in screen (the web's profileGate): onboarding first; a deleted account sees nothing. */
export type Gated<T> = T | { status: "incomplete" } | Failure;
export async function gate<T>(client: RpcClient, next: () => Promise<Gated<T>>): Promise<Gated<T>> {
  try {
    const g = await accountGate(client);
    if (g.status === "onboarding") return { status: "incomplete" };
    if (g.status !== "complete") return { status: g.status === "unauthenticated" ? "unauthenticated" : "unavailable" };
    return await next();
  } catch {
    return { status: "unavailable" };
  }
}

export type DiscoverPage = { status: "ok"; profiles: LiveProfile[]; nextAfter: string | null; schools: Schools; conditions: SearchConditions } | { status: "not_eligible" };

// src/app/page.tsx: the gate, then eligibility, then the school master for the conditions, then one page.
export function loadDiscover(client: DataClient, params: DiscoverParams, after?: string): Promise<Gated<DiscoverPage>> {
  return gate<DiscoverPage>(client, async () => {
    const eligible = await viewerEligible(client);
    if (eligible === false) return { status: "not_eligible" };
    if (eligible !== true) return eligible;
    const master = await loadAffiliationMaster(client);
    if (!master) return { status: "unavailable" };
    const schools = master.map(({ id, name }) => ({ id, name }));
    const conditions = conditionsFromParams(params, schools);
    const result = await listProfiles(client, { ...conditions, after: after && isUuid(after) ? after : undefined });
    return result.status === "ok" ? { ...result, schools, conditions } : result;
  });
}

// src/app/search/page.tsx: the schools for the condition form.
export function loadSchools(client: DataClient): Promise<Gated<{ status: "ok"; schools: Schools }>> {
  return gate(client, async () => {
    const master = await loadAffiliationMaster(client);
    return master ? { status: "ok" as const, schools: master.map(({ id, name }) => ({ id, name })) } : { status: "unavailable" as const };
  });
}
