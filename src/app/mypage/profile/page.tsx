import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ProfileEdit } from "@/components/profile-edit";
import { ProfileEditLive } from "@/components/profile-edit-live";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { profileGate } from "@/server/profile-gate";
import { loadMyProfile } from "@/server/profile-edit-data";
import { pageTitle, standalonePage } from "@/components/ui-tokens";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: backendMode() === "demo" ? "プロフィールを編集（デモ）| Campus Link" : "プロフィールを編集 | Campus Link" };
}
const login = "/login?next=" + encodeURIComponent("/mypage/profile");
export default async function Page() {
  if (backendMode() === "demo") return <ProfileEdit />;
  let gate: Awaited<ReturnType<typeof profileGate>> = "unavailable", result;
  try {
    const client = await createServerSupabase();
    gate = await profileGate(client);
    if (gate === "completed") result = await loadMyProfile(client);
  } catch { /* Fixed view below. */ }
  if (gate === "incomplete") redirect("/onboarding");
  if (gate === "unauthenticated" || result?.status === "unauthenticated") redirect(login);
  if (result?.status === "ok") return <ProfileEditLive initial={{ bio: result.profile.bio, purposes: result.profile.purposes }} />;
  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}><h1 className={pageTitle}>プロフィールを編集</h1><p role="alert" className="mt-8">現在表示できません。時間をおいて再度お試しください。</p></main>;
}
