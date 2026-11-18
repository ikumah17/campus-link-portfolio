import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccountSettings } from "@/components/account-settings";
import { AccountSettingsLive } from "@/components/account-settings-live";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { loadAccountState } from "@/server/account-data";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> { return { title: backendMode() === "demo" ? "アカウント（デモ）| Campus Link" : "アカウント | Campus Link" }; }
export default async function Page() {
  if (backendMode() === "demo") return <AccountSettings />;
  // my_account alone gates this page: a paused account still completed its profile and must reach it to resume.
  let result: Awaited<ReturnType<typeof loadAccountState>> = { status: "unavailable" };
  try { result = await loadAccountState(await createServerSupabase()); } catch {}
  if (result.status === "incomplete") redirect("/onboarding");
  if (result.status === "unauthenticated") redirect("/login?next=" + encodeURIComponent("/settings/account"));
  if (result.status === "ok") return <AccountSettingsLive accountStatus={result.accountStatus} />;
  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto max-w-2xl p-8"><h1>アカウント</h1><p role="alert">現在表示できません。時間をおいて再度お試しください。</p></main>;
}
