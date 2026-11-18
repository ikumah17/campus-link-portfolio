import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ProfileDetail } from "@/components/profile-detail";
import { demoProfiles, getDemoProfile } from "@/data/demo-profiles";

import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { getProfile, UUID } from "@/server/discover-data";
import { profileGate } from "@/server/profile-gate";
import { ProfileDetailLive } from "@/components/profile-detail-live";
import { getLikeState } from "@/server/like-data";
// The query (an old ?mode= included) is ignored since order 34.
type Props = { params: Promise<{ id: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };

// Empty live generateStaticParams otherwise opts unknown IDs into static ISR.
// Profiles require request cookies and a fresh CSP nonce on every request.
export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return backendMode() === "supabase" ? [] : demoProfiles.map((p) => ({ id: p.id }));
}



export async function generateMetadata({ params }: Props): Promise<Metadata> {
  if (backendMode() === "supabase") return { title: "プロフィール | Campus Link" };
  const profile = getDemoProfile((await params).id);
  return { title: profile ? `${profile.name}（架空）| Campus Link` : "Campus Link" };
}

export default async function Page({ params }: Props) {
  if (backendMode() === "supabase") {
    const { id } = await params;
    if (!UUID.test(id)) notFound();
    let gate: Awaited<ReturnType<typeof profileGate>> = "unavailable", result, like;
    try {
      const client = await createServerSupabase();
      gate = await profileGate(client);
      if (gate === "completed") result = await getProfile(client, id);
      if (result?.status === "ok" && result.profile) like = await getLikeState(client, id);
    } catch { /* Fixed failure below. */ }
    if (gate === "incomplete") redirect("/onboarding");
    if (gate === "unauthenticated" || result?.status === "unauthenticated" || like?.status === "unauthenticated") redirect(`/login?next=${encodeURIComponent(`/profiles/${id}`)}`);
    if (result?.status === "ok") {
      if (!result.profile) notFound();
      return <ProfileDetailLive profile={result.profile} likeState={like?.status === "ok" ? like.state : null} />;
    }
    return <main><p role="alert">現在表示できません。時間をおいて再度お試しください。</p></main>;
  }
  const profile = getDemoProfile((await params).id);
  if (!profile) notFound();
  return <ProfileDetail profile={profile} />;
}
