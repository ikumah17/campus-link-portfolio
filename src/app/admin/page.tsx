import { notFound } from "next/navigation";
import { AdminDashboard } from "@/components/admin-dashboard";
import { AdminLiveDashboard, AdminUnavailable } from "@/components/admin-live";
import { backendMode } from "@/lib/backend";
import { callerStaffRoles, requireAdminSession } from "@/server/admin-gate";

export const dynamic = "force-dynamic";
export default async function Page() {
  if (backendMode() === "demo") return <AdminDashboard />;
  const client = await requireAdminSession("/admin");
  if (!client) return <AdminUnavailable />;
  // Like every other admin page, a caller with no staff role (or an unreadable answer) gets the not-found page.
  const roles = await callerStaffRoles(client);
  if (!roles?.length) notFound();
  return <AdminLiveDashboard roles={roles} />;
}
