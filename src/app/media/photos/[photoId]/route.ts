import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { deliverAuthorizedPhoto, photoHeaders } from "@/server/photo-route-core";
import { isUuid } from "@/server/photo-upload";

export const dynamic = "force-dynamic";
function refused() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

// The checks after the cookie session are shared with the app's delivery (src/server/photo-route-core.ts).
export async function GET(_request: Request, context: { params: Promise<{ photoId: string }> }) {
  if (backendMode() === "demo") return refused();
  try {
    const { photoId } = await context.params;
    if (!isUuid(photoId)) return refused();
    const client = await createServerSupabase();
    const { data, error } = await client.auth.getUser();
    if (error || !data.user || data.user.is_anonymous !== false) return refused();
    // A session the database refuses gets the same 404 as every other refusal.
    const bytes = await deliverAuthorizedPhoto(client, data.user.id, photoId);
    if (bytes === null || bytes === "unauthenticated") return refused();
    return new Response(bytes, { headers: photoHeaders("Cookie") });
  } catch {
    return refused();
  }
}
