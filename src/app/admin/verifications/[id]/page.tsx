import { notFound, redirect } from "next/navigation";
import { AdminUnavailable } from "@/components/admin-live";
import { AdminVerificationDetail } from "@/components/admin-verification-detail";
import { backendMode } from "@/lib/backend";
import { requireAdminSession } from "@/server/admin-gate";
import { getSubmission } from "@/server/admin-verifications";

export const dynamic = "force-dynamic";
export default async function AdminVerificationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (backendMode() === "demo") notFound();
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) notFound();
  const path = `/admin/verifications/${id}`;
  const client = await requireAdminSession(path);
  if (!client) return <AdminUnavailable />;
  const r = await getSubmission(client, id);
  if (r.status === "forbidden" || (r.status === "ok" && !r.submission)) notFound();
  if (r.status === "unauthenticated") redirect(`/login?next=${encodeURIComponent(path)}`);
  if (r.status !== "ok" || !r.submission) return <AdminUnavailable />;
  return <AdminVerificationDetail submission={r.submission} />;
}
