import { notFound, redirect } from "next/navigation";
import { AdminUnavailable } from "@/components/admin-live";
import { AdminStaffLive } from "@/components/admin-staff-live";
import { backendMode } from "@/lib/backend";
import { requireAdminSession } from "@/server/admin-gate";
import { listStaff } from "@/server/admin-staff";

export const dynamic = "force-dynamic";
export default async function Page() {
  if (backendMode() === "demo") notFound();
  const client = await requireAdminSession("/admin/staff");
  if (!client) return <AdminUnavailable />;
  const result = await listStaff(client);
  if (result.status === "forbidden") notFound();
  if (result.status === "unauthenticated") redirect("/login?next=%2Fadmin%2Fstaff");
  if (result.status !== "ok") return <AdminUnavailable />;
  return <AdminStaffLive rows={result.rows} />;
}
