import { redirect } from "next/navigation";
import { Verification } from "@/components/verification";
import { VerificationLive } from "@/components/verification-live";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { loadMyVerification } from "@/server/verification-data";
export const dynamic = "force-dynamic";
export default async function VerificationPage() {
  if (backendMode() === "demo") return <Verification />;
  let state;
  try { state = await loadMyVerification(await createServerSupabase()); }
  catch { return <p role="alert">現在表示できません。時間をおいて再度お試しください。</p>; }
  if (state.status === "unauthenticated") redirect("/login?next=/verification");
  if (state.status !== "ok") return <p role="alert">現在表示できません。時間をおいて再度お試しください。</p>;
  return <VerificationLive state={state} />;
}
