import Link from "next/link";
import { ChatRoom } from "@/components/chat-room";
import { ChatRoomLive } from "@/components/chat-room-live";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { profileGate } from "@/server/profile-gate";
import { loadRoom,validId } from "@/server/chat-data";
import { redirect } from "next/navigation";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { pageTitle, standalonePage, textLink } from "@/components/ui-tokens";
export const dynamic="force-dynamic";
export const metadata={title:"トーク | Campus Link"};
export default async function ChatPage({params}:{params:Promise<{id:string}>}){
 const {id}=await params;
 if(backendMode()==="demo")return <ChatRoom key={id} id={id}/>;
 const missing=<main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}><h1 className={pageTitle}>この会話は表示できません</h1><Link href="/talk" className={`mt-6 ${textLink}`}>トーク一覧へ戻る</Link></main>;
 if(!validId(id))return missing;
 let gate:Awaited<ReturnType<typeof profileGate>>="unavailable",result;
 try{const client=await createServerSupabase();gate=await profileGate(client);if(gate==="completed")result=await loadRoom(client,id);}catch{}
 if(gate==="incomplete")redirect("/onboarding");
 if(gate==="unauthenticated"||result?.status==="unauthenticated")redirect(`/login?next=${encodeURIComponent(`/talk/${id}`)}`);
 if(result?.status==="ok")return result.room?<ChatRoomLive key={id} {...result.room}/>:missing;
 return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}><p role="alert">現在表示できません。時間をおいて再度お試しください。</p></main>;
}
