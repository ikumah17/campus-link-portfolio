import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PrivacySettings } from "@/components/privacy-settings";
import { PrivacySettingsLive } from "@/components/privacy-settings-live";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { profileGate } from "@/server/profile-gate";
import { loadMyPrivacy, privacyTargets } from "@/server/privacy-data";
import { loadAffiliationMaster } from "@/server/affiliation-master";
export const dynamic="force-dynamic";
export async function generateMetadata():Promise<Metadata>{return {title:backendMode()==="demo"?"公開範囲設定（デモ）| Campus Link":"公開範囲設定 | Campus Link"};}
function Unavailable(){return <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto max-w-2xl p-8"><h1>公開範囲設定</h1><p role="alert">現在表示できません。時間をおいて再度お試しください。</p></main>;}
export default async function Page(){
 if(backendMode()==="demo")return <PrivacySettings/>;
 const login="/login?next="+encodeURIComponent("/settings/privacy");
 let client; let gate;
 try{client=await createServerSupabase();gate=await profileGate(client);}catch{return <Unavailable/>;}
 if(gate==="incomplete")redirect("/onboarding");
 if(gate==="unauthenticated")redirect(login);
 if(gate!=="completed")return <Unavailable/>;
 const [privacy,master]=await Promise.all([loadMyPrivacy(client),loadAffiliationMaster(client)]);
 if(privacy.status==="unauthenticated")redirect(login);
 return privacy.status==="ok" && master ? <PrivacySettingsLive initialSettings={privacy.settings} targets={privacyTargets(master)}/> : <Unavailable/>;
}
