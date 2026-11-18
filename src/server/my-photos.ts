import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function listMyPhotos(client: Pick<SupabaseClient, "from">): Promise<string[] | null> {
  try {
    // The session client's own-row RLS supplies the owner boundary.
    const { data, error } = await client.from("profile_photos").select("id,position").eq("status", "active").order("position");
    if (error || !Array.isArray(data)) return null;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (data.some((row) => !row || typeof row.id !== "string" || row.id.length !== 36 || !uuid.test(row.id) ||
        !Number.isInteger(row.position) || row.position < 0 || row.position > 5)) return null;
    return data.map((row) => row.id);
  } catch {
    return null;
  }
}
