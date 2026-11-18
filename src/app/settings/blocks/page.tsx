import { redirect } from "next/navigation";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { profileGate } from "@/server/profile-gate";
import { listBlocks, listReports } from "@/server/safety-data";
import { BlocksSettingsLive } from "@/components/blocks-settings-live";
export const dynamic="force-dynamic";
import type { Metadata } from "next";
import { BlocksSettings } from "@/components/blocks-settings";

export const metadata: Metadata = { title: "ブロック中のユーザー | Campus Link" };
export default async function Page() {
  if(backendMode()==="supabase"){
    let gate,blocks,reports;
    try{const client=await createServerSupabase();gate=await profileGate(client);if(gate==="completed"){blocks=await listBlocks(client);reports=await listReports(client);}}catch{}
    if(gate==="unauthenticated"||blocks?.status==="unauthenticated"||reports?.status==="unauthenticated")redirect("/login");
    if(gate==="incomplete")redirect("/onboarding");
    if(blocks?.status==="ok"&&reports?.status==="ok")return <BlocksSettingsLive blocks={blocks.blocks} reports={reports.reports}/>;
    return <main id="main-content" tabIndex={-1}><h1>ブロック中のユーザー</h1><p role="alert">現在表示できません。時間をおいて再度お試しください。</p></main>;
  }
  return <BlocksSettings />;
}
