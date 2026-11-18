import { SearchConditionsForm } from "@/components/search-conditions";
import { conditionsFromSearch } from "@/lib/discover-gateway";

import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { loadAffiliationMaster } from "@/server/affiliation-master";
import { profileGate } from "@/server/profile-gate";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  let schools;
  if (backendMode() === "supabase") {
    let gate: Awaited<ReturnType<typeof profileGate>> = "unavailable";
    try {
      const client = await createServerSupabase();
      gate = await profileGate(client);
      const master = gate === "completed" ? await loadAffiliationMaster(client) : null;
      if (master) schools = master.map(({ id, name }) => ({ id, name }));
    } catch { /* Render the fixed failure below. */ }
    if (gate === "incomplete") redirect("/onboarding");
    if (gate === "unauthenticated") redirect("/login?next=%2Fsearch");
    if (!schools) return <main><p role="alert">現在表示できません。時間をおいて再度お試しください。</p></main>;
  }
  return <SearchConditionsForm schools={schools} initialConditions={conditionsFromSearch(query.toString(), schools)} />;
}
