import "server-only";
import { callRpc, type RpcClient } from "@/server/rpc";
import type { DiscoverParams } from "@/lib/discover-gateway";
import { PURPOSE_LABELS, type Purpose } from "@/lib/onboarding-rules";
export const PAGE_SIZE = 20;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// purposes: the fixed codes in their stored order (order 34, docs/43 §1.2); the screens show their labels.
export type LiveProfile = { id: string; name: string; age: number; gender: "female" | "male" | "other"; school: string; department: string | null; class: string | null; bio: string; purposes: Purpose[]; hobbies: string[]; photoIds: string[] };
export { PURPOSE_LABELS, type Purpose };
const isPurposes = (v: unknown): v is Purpose[] => Array.isArray(v) && v.length <= 5 && new Set(v).size === v.length && v.every(x => typeof x === "string" && Object.hasOwn(PURPOSE_LABELS, x));
type Failure = { status: "unauthenticated" | "unavailable" };
const fail = (code: string): Failure => ({ status: code === "unauthenticated" ? code : "unavailable" });
export function parseProfile(value: unknown): LiveProfile | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const nullable = (v: unknown) => v === null || typeof v === "string";
  if (typeof r.user_id !== "string" || !UUID.test(r.user_id) || typeof r.display_name !== "string" || !Number.isInteger(r.age) || !["female", "male", "other"].includes(r.gender as string) || typeof r.school_name !== "string" || !nullable(r.department_name) || !nullable(r.class_name) || !nullable(r.bio) || !isPurposes(r.purposes) || !(r.hobbies === null || (Array.isArray(r.hobbies) && r.hobbies.every(v => typeof v === "string"))) || !Array.isArray(r.photo_ids) || !r.photo_ids.every(v => typeof v === "string" && UUID.test(v))) return null;
  return { id: r.user_id, name: r.display_name, age: r.age as number, gender: r.gender as LiveProfile["gender"], school: r.school_name, department: r.department_name as string | null, class: r.class_name as string | null, bio: r.bio as string ?? "", purposes: r.purposes as Purpose[], hobbies: r.hobbies as string[] ?? [], photoIds: r.photo_ids };
}
// One list since order 34 (no mode).
export async function listProfiles(client: RpcClient, p: DiscoverParams): Promise<Failure | { status: "ok"; profiles: LiveProfile[]; nextAfter: string | null }> {
  const r = await callRpc(client, "discover_profiles", { p_min_age: p.min ?? null, p_max_age: p.max ?? null, p_genders: p.genders.length ? p.genders : null, p_school_ids: p.schoolIds.length ? p.schoolIds : null, p_after: p.after ?? null, p_limit: PAGE_SIZE });
  if (r.code !== "ok") return fail(r.code);
  if (!Array.isArray(r.data)) return fail("unavailable");
  const profiles = r.data.map(parseProfile);
  if (profiles.some(p => p === null)) return fail("unavailable");
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
  if (!Array.isArray(r.data) || r.data.length !== 1 || !r.data[0] || typeof r.data[0] !== "object" || !("eligible" in r.data[0]) || typeof r.data[0].eligible !== "boolean") return fail("unavailable");
  return r.data[0].eligible;
}
