import { Discover } from "@/components/discover";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { redirect } from "next/navigation";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { profileGate } from "@/server/profile-gate";

import { DiscoverLive, DiscoverNotEligible } from "@/components/discover-live";
import { listProfiles, viewerEligible, UUID } from "@/server/discover-data";
import { loadAffiliationMaster } from "@/server/affiliation-master";
import { conditionsFromSearch } from "@/lib/discover-gateway";
import { standalonePage } from "@/components/ui-tokens";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (backendMode() === "supabase") {
    let gate: Awaited<ReturnType<typeof profileGate>> = "unavailable";
    try {
      gate = await profileGate(await createServerSupabase());
    } catch {
      // A fixed unavailable view keeps provider details on the server.
    }
    if (gate === "incomplete") redirect("/onboarding");
    if (gate === "unauthenticated") redirect("/login");
    if (gate !== "completed") return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}>
      <h1 className="font-brand text-[28px]">Campus Link</h1>
      <p role="alert" className="mt-8">現在ご利用いただけません。時間をおいて再度お試しください。</p>
    </main>;
    let result;
    let schools;
    const params = await searchParams;
    const after = typeof params.after === "string" && UUID.test(params.after) ? params.after : undefined;
    let conditions;
    try {
      const client = await createServerSupabase();
      const eligible = await viewerEligible(client);
      if (eligible === false) return <DiscoverNotEligible />;
      if (typeof eligible !== "boolean") result = eligible;
      else {
        const master = await loadAffiliationMaster(client);
        if (master) {
          schools = master.map(({ id, name }) => ({ id, name }));
          const query = new URLSearchParams();
          Object.entries(params).forEach(([k, v]) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).forEach(item => query.append(k, item)));
          conditions = conditionsFromSearch(query.toString(), schools);
          result = await listProfiles(client, { ...conditions, after });
        }
      }
    } catch { /* Fixed unavailable view below. */ }
    if (result?.status === "unauthenticated") redirect("/login");
    if (result?.status === "ok" && schools && conditions) return <DiscoverLive {...result} schools={schools} conditions={conditions} after={after} />;
    return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}><h1 className="font-brand text-[28px]">Campus Link</h1><p role="alert" className="mt-8">現在ご利用いただけません。時間をおいて再度お試しください。</p></main>;
  }
  return <Discover />;
}
