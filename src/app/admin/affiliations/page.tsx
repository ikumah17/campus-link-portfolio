import { AdminAffiliations } from "@/components/admin-affiliations";
import { AdminUnavailable } from "@/components/admin-live";
import { AdminAffiliationsLive } from "@/components/admin-affiliations-live";
import { listAffiliations } from "@/server/admin-affiliations";
import { notFound, redirect } from "next/navigation";
import { backendMode } from "@/lib/backend";
import { requireAdminSession } from "@/server/admin-gate";

export const dynamic = "force-dynamic";
export default async function Page() {
  if (backendMode() === "demo") return <AdminAffiliations />;
  const client = await requireAdminSession("/admin/affiliations");
  if (!client) return <AdminUnavailable />;
  const result = await listAffiliations(client);
  if (result.status === "forbidden") notFound();
  if (result.status === "unauthenticated") redirect("/login?next=%2Fadmin%2Faffiliations");
  if (result.status !== "ok") return <AdminUnavailable />;
  return <AdminAffiliationsLive rows={result.rows} />;
}
