import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MyPage } from "@/components/mypage";
import { MyPageLive } from "@/components/mypage-live";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { loadMyPage } from "@/server/mypage-data";
import { standalonePage } from "@/components/ui-tokens";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: backendMode() === "demo" ? "マイページ（デモ）| Campus Link" : "マイページ | Campus Link" };
}
export default async function Page() {
  if (backendMode() === "demo") return <MyPage />;
  let result: Awaited<ReturnType<typeof loadMyPage>> = { status: "unavailable" };
  try { result = await loadMyPage(await createServerSupabase()); } catch {}
  if (result.status === "incomplete") redirect("/onboarding");
  if (result.status === "unauthenticated") redirect("/login?next=" + encodeURIComponent("/mypage"));
  if (result.status === "ok") return <MyPageLive page={result.page} />;
  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}><p role="alert">現在表示できません。時間をおいて再度お試しください。</p></main>;
}
