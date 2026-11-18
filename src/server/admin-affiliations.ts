import "server-only";
import type { Affiliation, Level } from "@/lib/admin-gateway";
import { callRpc, type RpcClient } from "@/server/rpc";

type Failure = { status: "forbidden" | "unauthenticated" | "unavailable" };
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export async function listAffiliations(client: RpcClient): Promise<{ status: "ok"; rows: Affiliation[] } | Failure> {
  try {
    const result = await callRpc(client, "admin_list_affiliations");
    if (result.code !== "ok") return { status: result.code === "forbidden" || result.code === "unauthenticated" ? result.code : "unavailable" };
    if (!Array.isArray(result.data)) return { status: "unavailable" };
    const rows: Affiliation[] = [];
    for (const value of result.data) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "unavailable" };
      const r = value as Record<string, unknown>;
      if (!["school", "department", "class"].includes(r.level as string) || !uuid(r.id) ||
        (r.level === "school" ? r.parent_id !== null : !uuid(r.parent_id)) ||
        typeof r.name !== "string" || typeof r.is_active !== "boolean" || !Number.isInteger(r.sort_order) ||
        (r.level === "class" ? r.academic_year !== null && !Number.isInteger(r.academic_year) : r.academic_year !== null)) return { status: "unavailable" };
      rows.push({ level: r.level as Level, id: r.id, parentId: r.parent_id as string | null, name: r.name, isActive: r.is_active, sortOrder: r.sort_order as number, academicYear: r.academic_year as number | null });
    }
    const ids = new Map(rows.map(r => [r.id, r.level]));
    if (ids.size !== rows.length || rows.some(r => r.level !== "school" && ids.get(r.parentId!) !== (r.level === "department" ? "school" : "department"))) return { status: "unavailable" };
    return { status: "ok", rows };
  } catch { return { status: "unavailable" }; }
}
