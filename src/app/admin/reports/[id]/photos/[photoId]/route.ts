import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { adminAccountUsable } from "@/server/admin-gate";
import { callRpc } from "@/server/rpc";
import { readPhoto } from "@/server/storage/photo-read";

// MOD-001: a moderator sees the photos of a profile report's target to choose one to hide.
// admin_authorize_report_photo (order 33) authorizes and audits every request; nothing is cached.
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function refused() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

export async function GET(_request: Request, context: { params: Promise<{ id: string; photoId: string }> }) {
  if (backendMode() === "demo") return refused();
  try {
    const { id, photoId } = await context.params;
    if (typeof id !== "string" || id.length !== 36 || !UUID.test(id) ||
        typeof photoId !== "string" || photoId.length !== 36 || !UUID.test(photoId)) return refused();
    const client = await createServerSupabase();
    const { data, error } = await client.auth.getUser();
    if (error || !data.user || data.user.is_anonymous !== false) return refused();
    if (!await adminAccountUsable(client)) return refused();
    const authorized = await callRpc(client, "admin_authorize_report_photo", { p_id: id, p_photo: photoId });
    if (authorized.code !== "ok" || !Array.isArray(authorized.data) || authorized.data.length !== 1) return refused();
    const row = authorized.data[0];
    if (!row || typeof row !== "object" || !("photo_id" in row) || row.photo_id !== photoId ||
        !("storage_path" in row) || typeof row.storage_path !== "string") return refused();
    const bytes = await readPhoto({ photo_id: row.photo_id, storage_path: row.storage_path });
    if (bytes === null) return refused();
    return new Response(bytes, { headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    } });
  } catch {
    return refused();
  }
}
