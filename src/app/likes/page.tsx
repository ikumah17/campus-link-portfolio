import { redirect } from "next/navigation";
import { Likes } from "@/components/likes";
import { LikesLive } from "@/components/likes-live";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { profileGate } from "@/server/profile-gate";
import { listLikes } from "@/server/like-data";
import { UUID } from "@/server/discover-data";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { pageTitle, standalonePage } from "@/components/ui-tokens";
export const dynamic = "force-dynamic";
type Params = Promise<{ tab?: string | string[]; at?: string | string[]; id?: string | string[] }>;
function Unavailable() { return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}><h1 className={pageTitle}>いいね</h1><p role="alert" className="mt-8">現在表示できません。時間をおいて再度お試しください。</p></main>; }
// ?tab=received|sent&at=&id= continues one list from its last row (keyset, docs/43 §2.7); anything else starts both.
function cursor(params: Awaited<Params>) {
  const one = (v: string | string[] | undefined) => typeof v === "string" ? v : undefined;
  const tab = one(params.tab), at = one(params.at), id = one(params.id);
  const direction: "received" | "sent" | undefined = tab === "sent" ? "sent" : tab === "received" ? "received" : undefined;
  return { tab: direction, before: direction && at && id && UUID.test(id) && !Number.isNaN(Date.parse(at)) ? { at, id } : undefined };
}
export default async function LikesPage({ searchParams }: { searchParams: Params }) {
  if (backendMode() === "demo") return <Likes />;
  const { tab, before } = cursor(await searchParams);
  let gate: Awaited<ReturnType<typeof profileGate>> = "unavailable";
  try { gate = await profileGate(await createServerSupabase()); } catch { /* Fixed view below. */ }
  if (gate === "incomplete") redirect("/onboarding");
  if (gate === "unauthenticated") redirect("/login?next=%2Flikes");
  if (gate !== "completed") return <Unavailable />;
  let received, sent;
  try {
    const client = await createServerSupabase();
    [received, sent] = await Promise.all([listLikes(client, "received", tab === "received" ? before : undefined), listLikes(client, "sent", tab === "sent" ? before : undefined)]);
  } catch { /* Fixed view below. */ }
  if (received?.status === "unauthenticated" || sent?.status === "unauthenticated") redirect("/login?next=%2Flikes");
  if (received?.status !== "ok" || sent?.status !== "ok") return <Unavailable />;
  return <LikesLive received={received.likes} sent={sent.likes} next={{ received: received.next, sent: sent.next }} tab={tab} />;
}
