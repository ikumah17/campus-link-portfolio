import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type Affiliation = {
  id: string;
  name: string;
  departments: { id: string; name: string; classes: { id: string; name: string }[] }[];
};

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
    if (schools.some((row) => !named(row)) || departments.some((row) => !named(row) || typeof row.school_id !== "string") || classes.some((row) => !named(row) || typeof row.department_id !== "string")) return null;
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
