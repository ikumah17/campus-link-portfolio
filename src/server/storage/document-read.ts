import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabasePublicConfig } from "@/lib/supabase/config";

const BUCKET = "verification-documents";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REFERENCE = new RegExp(`^${UUID}/[A-Za-z0-9_-]{1,64}(/[A-Za-z0-9_-]{1,64})*\\.webp$`);

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
  if (!key || !isServiceKey(key)) throw new Error("Document storage unavailable");
  return createClient(supabasePublicConfig().url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Only a reference returned by this request's authorization RPC may enter E-2.
export async function readDocument(reference: unknown): Promise<ArrayBuffer | null> {
  try {
    if (typeof reference !== "string" || reference.length > 256 ||
        REFERENCE.exec(reference)?.[0] !== reference) return null;
    const { data, error } = await serviceClient().storage.from(BUCKET).download(reference);
    if (error || !data) return null;
    return await data.arrayBuffer();
  } catch {
    return null;
  }
}
