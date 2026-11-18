import { notFound, redirect } from "next/navigation";
import { AdminUnavailable } from "@/components/admin-live";
import { AdminAccountsLive } from "@/components/admin-accounts-live";
import { backendMode } from "@/lib/backend";
import { requireAdminSession } from "@/server/admin-gate";
import { listSuspendedAccounts } from "@/server/admin-accounts";

export const dynamic = "force-dynamic";
export default async function Page() {
  if (backendMode() === "demo") notFound();
  const client = await requireAdminSession("/admin/accounts");
  if (!client) return <AdminUnavailable />;
  const result = await listSuspendedAccounts(client);
  if (result.status === "forbidden") notFound();
  if (result.status === "unauthenticated") redirect("/login?next=%2Fadmin%2Faccounts");
  if (result.status !== "ok") return <AdminUnavailable />;
  return <AdminAccountsLive rows={result.rows} />;
}
