import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabasePublicConfig } from "@/lib/supabase/config";

const BUCKET = "profile-photos";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATH = new RegExp(`^${UUID}/${UUID}\\.webp$`);
export type AuthorizedPhoto = { photo_id: string; storage_path: string };

function isServiceKey(key: string): boolean {
  if (key.trim() !== key) return false;
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return true;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) return false;
  try {
    return JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")).role === "service_role";
  } catch {
    return false;
  }
}

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !isServiceKey(key)) throw new Error("Photo storage unavailable");
  return createClient(supabasePublicConfig().url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Only the authorization row from this request may cross the E-3 boundary.
export async function readPhoto(row: AuthorizedPhoto): Promise<ArrayBuffer | null> {
  try {
    if (!row || typeof row.storage_path !== "string" || row.storage_path.length !== 78 ||
        !PATH.test(row.storage_path) || row.storage_path.slice(37, 73) !== row.photo_id) return null;
    const { data, error } = await serviceClient().storage.from(BUCKET).download(row.storage_path);
    if (error || !data) return null;
    return await data.arrayBuffer();
  } catch {
    return null;
  }
}
