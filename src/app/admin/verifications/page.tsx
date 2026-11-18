import { redirect, notFound } from "next/navigation";
import { AdminVerifications } from "@/components/admin-verifications";
import { AdminUnavailable } from "@/components/admin-live";
import { AdminVerificationList } from "@/components/admin-verification-list";
import { backendMode } from "@/lib/backend";
import { requireAdminSession } from "@/server/admin-gate";
import { listSubmissions, type SubmissionStatus } from "@/server/admin-verifications";

export const dynamic = "force-dynamic";
export default async function AdminVerificationsPage({ searchParams }: {
  searchParams?: Promise<{ status?: string | string[]; notice?: string | string[] }>;
} = {}) {
  if (backendMode() === "demo") return <AdminVerifications />;
  const client = await requireAdminSession("/admin/verifications");
  if (!client) return <AdminUnavailable />;
  const query = await searchParams;
  const status = typeof query?.status === "string" && ["submitted", "in_review", "approved", "rejected", "revoked"].includes(query.status) ? query.status as SubmissionStatus : "submitted";
  let currentUserId: string;
  try {
    const { data, error } = await client.auth.getClaims();
    if (error || !data?.claims || typeof data.claims.sub !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.claims.sub)) return <AdminUnavailable />;
    currentUserId = data.claims.sub;
  } catch { return <AdminUnavailable />; }
  const r = await listSubmissions(client, status, currentUserId);
  if (r.status === "forbidden") notFound();
  if (r.status === "unauthenticated") redirect("/login?next=%2Fadmin%2Fverifications");
  if (r.status !== "ok") return <AdminUnavailable />;
  const notice = query?.notice === "decided" || query?.notice === "released" ? query.notice : null;
  return <AdminVerificationList submissions={r.submissions} status={status} notice={notice} />;
}
