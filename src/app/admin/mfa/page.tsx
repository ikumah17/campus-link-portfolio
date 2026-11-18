import { notFound, redirect } from "next/navigation";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { adminAccountUsable, adminNextPath, adminSession } from "@/server/admin-gate";
import { AdminMfa } from "@/components/admin-mfa";
import { AdminUnavailable } from "@/components/admin-live";

export const dynamic = "force-dynamic";

export default async function AdminMfaPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  if (backendMode() === "demo") notFound();
  let client;
  try { client = await createServerSupabase(); } catch { return <AdminUnavailable />; }
  const status = await adminSession(client);
  const next = adminNextPath((await searchParams).next);
  if (status === "unauthenticated") redirect(`/login?next=${encodeURIComponent("/admin/mfa")}`);
  if (status === "aal2") redirect(next);
  if (status === "unavailable" || !await adminAccountUsable(client)) return <AdminUnavailable />;
  try {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error || !data) return <AdminUnavailable />;
    const verified = data.all.some((factor) => factor.factor_type === "totp" && factor.status === "verified");
    return <AdminMfa mode={verified ? "challenge" : "enroll"} next={next} />;
  } catch { return <AdminUnavailable />; }
}
