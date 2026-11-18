import { Onboarding } from "@/components/onboarding";
import { DemoShell } from "@/components/auth-demo-form";
import { redirect } from "next/navigation";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { loadAffiliationMaster, type Affiliation } from "@/server/affiliation-master";
import { callRpc } from "@/server/rpc";
import { listMyPhotos } from "@/server/my-photos";

export default async function OnboardingPage({ searchParams }: { searchParams?: Promise<{ edit?: string | string[] }> } = {}) {
  if (backendMode() === "demo") return <Onboarding />;
  let master: Affiliation[] | null = null;
  let completed = false;
  let available = false;
  let edit = false;
  let initialPhotos: string[] | null | undefined;
  try {
    edit = (await searchParams)?.edit === "1";
    const client = await createServerSupabase();
    master = await loadAffiliationMaster(client);
    const account = await callRpc(client, "my_account");
    const row = account.code === "ok" && Array.isArray(account.data) ? account.data[0] : undefined;
    // A deleted account keeps its Auth user until retention; onboarding and editing stay closed to it.
    available = !!row && typeof row === "object" && "profile_completed" in row && typeof row.profile_completed === "boolean" &&
      !("account_status" in row && row.account_status === "deleted");
    completed = available && (row as { profile_completed: boolean }).profile_completed;
    if (available && !completed && row && typeof row === "object" && "has_profile" in row && row.has_profile === true && !edit) {
      initialPhotos = await listMyPhotos(client);
    }
  } catch {
    // Render a fixed unavailable message without forwarding provider details.
  }
  if (completed) redirect("/mypage");
  if (master === null || !available || initialPhotos === null) return <DemoShell notice={false}><p role="alert" className="mt-8">現在保存できません。時間をおいて再度お試しください。</p></DemoShell>;
  return <Onboarding key={edit ? "edit" : "onboarding"} backend={{ master, ...(initialPhotos !== undefined ? { initialPhotos } : {}) }} />;
}
