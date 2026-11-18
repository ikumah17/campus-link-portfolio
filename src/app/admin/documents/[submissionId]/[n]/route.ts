import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { adminAccountUsable } from "@/server/admin-gate";
import { callRpc } from "@/server/rpc";
import { readDocument } from "@/server/storage/document-read";
import { syntheticDocument } from "@/server/synthetic-documents";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function refused() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

export async function GET(_request: Request, context: { params: Promise<{ submissionId: string; n: string }> }) {
  if (backendMode() === "demo") return refused();
  try {
    const { submissionId, n } = await context.params;
    if (typeof submissionId !== "string" || submissionId.length !== 36 || !UUID.test(submissionId) ||
        typeof n !== "string" || n.length !== 1 || !/^[1-4]$/.test(n)) return refused();
    const client = await createServerSupabase();
    const { data, error } = await client.auth.getUser();
    if (error || !data.user || data.user.is_anonymous !== false) return refused();
    // A deleted staff account is refused here too, even where the database predates ACCOUNT-003 (order 17).
    if (!await adminAccountUsable(client)) return refused();
    const authorized = await callRpc(client, "admin_authorize_document_view", { p_id: submissionId });
    if (authorized.code !== "ok" || !Array.isArray(authorized.data)) return refused();
    const rows = authorized.data.filter((row) => row && typeof row === "object" && "n" in row && row.n === Number(n));
    if (rows.length !== 1) return refused();
    const row = rows[0];
    if (!row || typeof row !== "object" || !("document_ref" in row) || typeof row.document_ref !== "string") return refused();
    const synthetic = syntheticDocument(row.document_ref);
    const body = synthetic ?? await readDocument(row.document_ref);
    if (body === null) return refused();
    return new Response(body, { headers: {
      "Content-Type": synthetic === null ? "image/webp" : "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    } });
  } catch {
    return refused();
  }
}
