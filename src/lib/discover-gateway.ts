import { demoAffiliations } from "@/data/demo-affiliations";
import { demoProfiles, type DemoProfile } from "@/data/demo-profiles";
import type { LikesState } from "@/lib/likes-demo";

export const genders = [{ id: "female", label: "女性" }, { id: "male", label: "男性" }, { id: "other", label: "その他" }] as const;
export type Gender = typeof genders[number]["id"];
export type SearchConditions = { min?: number; max?: number; genders: Gender[]; schoolIds: string[] };
export type DiscoverParams = SearchConditions & { after?: string; limit?: number };
export type DiscoverResult = { code: "ok"; data: DemoProfile[] };
export interface DiscoverGateway {
  // discover_profiles(p_min_age, p_max_age, p_genders, p_school_ids, p_after, p_limit).
  // The demo uses fictional string user ids in place of hosted UUIDs; no totals are exposed.
  discoverProfiles(params: DiscoverParams): Promise<DiscoverResult>;
}
export function normalizeAge(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return undefined;
  const age = Number(value);
  return Number.isInteger(age) && age >= 18 && age <= 120 ? age : undefined;
}
export type Schools = readonly { id: string; name: string }[];
export function normalizeConditions(input: { min?: unknown; max?: unknown; genders?: unknown[]; schoolIds?: unknown[] }, schools: Schools = demoAffiliations): SearchConditions {
  let min = normalizeAge(input.min), max = normalizeAge(input.max);
  if (min !== undefined && max !== undefined && min > max) { min = undefined; max = undefined; }
  return { min, max,
    genders: [...new Set((input.genders ?? []).filter((v): v is Gender => genders.some((g) => g.id === v)))],
    schoolIds: [...new Set((input.schoolIds ?? []).filter((v): v is string => schools.some((s) => s.id === v)))],
  };
}
export function conditionsFromSearch(search: string, schools: Schools = demoAffiliations): SearchConditions {
  const query = new URLSearchParams(search);
  const single = (key: string) => query.getAll(key).length === 1 ? query.get(key) : undefined;
  return normalizeConditions({ min: single("min"), max: single("max"), genders: query.getAll("g"), schoolIds: query.getAll("s") }, schools);
}
export function searchHref(path: string, input: SearchConditions, schools: Schools = demoAffiliations): string {
  const conditions = normalizeConditions(input, schools);
  const url = new URL(path, "http://demo.local");
  if (conditions.min !== undefined) url.searchParams.set("min", String(conditions.min));
  if (conditions.max !== undefined) url.searchParams.set("max", String(conditions.max));
  conditions.genders.forEach((g) => url.searchParams.append("g", g));
  conditions.schoolIds.forEach((s) => url.searchParams.append("s", s));
  return url.pathname + url.search;
}
export function conditionLabels(conditions: SearchConditions, schools: Schools = demoAffiliations): string[] {
  return [
    ...(conditions.min !== undefined || conditions.max !== undefined ? [`${conditions.min ?? 18}〜${conditions.max ?? 120}歳`] : []),
    ...conditions.genders.map((id) => genders.find((g) => g.id === id)!.label),
    ...conditions.schoolIds.map((id) => schools.find((s) => s.id === id)!.name),
  ];
}
export function createDiscoverDemo(getState: () => LikesState, viewer: string, profiles = demoProfiles): DiscoverGateway {
  return { async discoverProfiles(params) {
    // One list (order 34): people the viewer liked or matched with are left out; people who liked the viewer stay.
    const conditions = normalizeConditions(params);
    const state = getState();
    const partners = new Set<string>();
    for (const [a, b] of state.connections) { if (a === viewer) partners.add(b); if (b === viewer) partners.add(a); }
    for (const l of state.likes) if (l.liker === viewer) partners.add(l.liked);
    const limit = Number.isFinite(params.limit) ? Math.max(1, Math.min(50, Math.trunc(params.limit!))) : 20;
    const data = profiles.filter((p) => p.id !== viewer && !partners.has(p.id)
      && !state.blocks?.some((b) => b.blocked_id === p.id)
      && (!params.after || p.id > params.after)
      && (conditions.min === undefined || p.age >= conditions.min)
      && (conditions.max === undefined || p.age <= conditions.max)
      && (!conditions.genders.length || conditions.genders.some((g) => genders.find((v) => v.id === g)!.label === p.gender))
      && (!conditions.schoolIds.length || conditions.schoolIds.includes(p.schoolId)))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, limit);
    return { code: "ok", data };
  } };
}
