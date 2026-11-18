"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import type { Affiliation, Level } from "@/lib/admin-gateway";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { listAffiliations } from "@/server/admin-affiliations";
import { callRpc, type RpcClient } from "@/server/rpc";

export type AffiliationActionResult = { status: "ok" | "invalid" | "duplicate" | "not_found" | "forbidden" | "unauthenticated" | "unavailable" };
type AffiliationInput = Omit<Affiliation, "id"> & { id: string | null };
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
function valid(input: unknown): input is AffiliationInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const r = input as AffiliationInput;
  return ["school", "department", "class"].includes(r.level) && (r.id === null || uuid(r.id)) &&
    (r.level === "school" ? r.parentId === null : uuid(r.parentId)) && typeof r.name === "string" &&
    [...r.name.trim()].length >= 1 && [...r.name.trim()].length <= (r.level === "class" ? 40 : 80) && typeof r.isActive === "boolean" &&
    (r.level === "class" || Number.isInteger(r.sortOrder) && r.sortOrder >= 0 && r.sortOrder <= 9999) &&
    (r.level === "class" ? r.academicYear === null || Number.isInteger(r.academicYear) && r.academicYear >= 2000 && r.academicYear <= 2100 : r.academicYear === null);
}
async function write(client: RpcClient, r: AffiliationInput): Promise<AffiliationActionResult> {
  const args = { p_id: r.id, p_name: r.name.trim(), p_is_active: r.isActive };
  const result = await callRpc(client, `admin_upsert_${r.level}`, r.level === "school" ? { ...args, p_sort_order: r.sortOrder } : r.level === "department" ? { ...args, p_school_id: r.parentId, p_sort_order: r.sortOrder } : { ...args, p_department_id: r.parentId, p_academic_year: r.academicYear });
  const mapped: Partial<Record<string, string>> = { validation: "invalid", invalid_state: "duplicate", not_available: "not_found" };
  const status = mapped[result.code] ?? result.code;
  if (status === "ok") revalidatePath("/admin/affiliations");
  return { status: ["ok", "invalid", "duplicate", "not_found", "forbidden", "unauthenticated"].includes(status) ? status as AffiliationActionResult["status"] : "unavailable" };
}
export async function saveAffiliation(input: unknown): Promise<AffiliationActionResult> {
  if (!valid(input)) return { status: "invalid" };
  try {
    if (backendMode() === "demo") return { status: "unavailable" };
    return await write(await createServerSupabase(), input);
  } catch { return { status: "unavailable" }; }
}
export async function setAffiliationActive(level: unknown, id: unknown, isActive: unknown): Promise<AffiliationActionResult> {
  if (!["school", "department", "class"].includes(level as string) || !uuid(id) || typeof isActive !== "boolean") return { status: "invalid" };
  try {
    if (backendMode() === "demo") return { status: "unavailable" };
    const client = await createServerSupabase();
    const result = await listAffiliations(client);
    if (result.status !== "ok") return result;
    const row = result.rows.find(r => r.level === level as Level && r.id === id);
    return row ? await write(client, { ...row, isActive }) : { status: "not_found" };
  } catch { return { status: "unavailable" }; }
}
