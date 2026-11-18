import { TalkList } from "@/components/talk-list";
import { TalkListLive } from "@/components/talk-list-live";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { profileGate } from "@/server/profile-gate";
import { listConversations } from "@/server/chat-data";
import { redirect } from "next/navigation";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { standalonePage } from "@/components/ui-tokens";
export const dynamic="force-dynamic";
export default async function TalkPage(){
 if(backendMode()==="demo")return <TalkList/>;
 let gate:Awaited<ReturnType<typeof profileGate>>="unavailable", result;
 try{const client=await createServerSupabase();gate=await profileGate(client);if(gate==="completed")result=await listConversations(client);}catch{}
 if(gate==="incomplete")redirect("/onboarding");
 if(gate==="unauthenticated"||result?.status==="unauthenticated")redirect("/login");
 if(result?.status==="ok")return <TalkListLive conversations={result.conversations}/>;
 return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}><p role="alert">現在表示できません。時間をおいて再度お試しください。</p></main>;
}
