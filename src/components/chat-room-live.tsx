"use client";
import { SafetyControlsLive } from "./safety-controls-live";
import Link from "next/link";
import { useEffect,useLayoutEffect,useRef,useState } from "react";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { primaryButton,secondaryButton } from "@/components/auth-demo-form";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { validateBody } from "@/lib/chat-gateway";
import type { LiveConversation,LiveMessage } from "@/server/chat-data";
import { sendChatMessage,olderMessages,latestMessages,markRead } from "@/server/chat-actions";
import { pageTitle, standalonePage, textLink } from "@/components/ui-tokens";
import { HiddenContentNotice } from "@/components/hidden-content";
// Fixed zone so the server render and hydration agree.
const clock=new Intl.DateTimeFormat("ja-JP",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Asia/Tokyo"});
const merge=(a:LiveMessage[],b:LiveMessage[])=>[...new Map([...a,...b].map(m=>[m.id,m])).values()].sort((a,b)=>a.id-b.id);
export function ChatRoomLive({conversation,messages:initial,hasOlder:initialOlder}:{conversation:LiveConversation;messages:LiveMessage[];hasOlder:boolean}){
 const [messages,setMessages]=useState(initial),[hasOlder,setHasOlder]=useState(initialOlder),[body,setBody]=useState(""),[sending,setSending]=useState(false),[status,setStatus]=useState(""),[available,setAvailable]=useState(true),[loadingOlder,setLoadingOlder]=useState(false);
 const busy=useRef(false),olderBusy=useRef(false),refreshBusy=useRef(false),refreshPending=useRef(false),unavailable=useRef(false),alive=useRef(true),retry=useRef<{body:string;id:string}|null>(null),log=useRef<HTMLDivElement>(null),scroll=useRef<{height:number;top:number}|"bottom"|null>("bottom");
 const history=useRef({messages:initial,hasOlder:initialOlder});
 const id=conversation.id;
 function makeUnavailable(){unavailable.current=true;refreshPending.current=false;setAvailable(false);}
 function read(rows:LiveMessage[]){const last=rows.at(-1);if(last&&!last.mine)void markRead(id,last.id).catch(()=>{});}
 useEffect(()=>{
  alive.current=true;read(initial);
  const visible=()=>{if(document.visibilityState==="visible")void refresh();};
  window.addEventListener("focus",refresh);document.addEventListener("visibilitychange",visible);
  return ()=>{alive.current=false;window.removeEventListener("focus",refresh);document.removeEventListener("visibilitychange",visible);};
 // Room identity is fixed by its page key.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[id]);
 useLayoutEffect(()=>{if(log.current&&scroll.current){log.current.scrollTop=scroll.current==="bottom"?log.current.scrollHeight:scroll.current.top+log.current.scrollHeight-scroll.current.height;scroll.current=null;}},[messages]);
 // Do not publish or mark a newest page read until it joins the loaded history.
 async function acceptNewest(page:{messages:LiveMessage[];hasOlder:boolean}){
  const boundary=history.current.messages.at(-1)?.id;
  let rows=page.messages,hasMore=page.hasOlder;
  while(boundary!==undefined&&hasMore&&rows.length&&rows[0].id>boundary){
   const before=rows[0].id,r=await olderMessages(id,before);
   if(!alive.current||unavailable.current)return;
   if(r.status==="not_available"){makeUnavailable();return;}
   if(r.status!=="ok")throw Error("backfill unavailable");
   if(r.messages.length&&r.messages[0].id>=before)throw Error("backfill made no progress");
   rows=merge(rows,r.messages);hasMore=r.hasOlder;
  }
  if(!alive.current||unavailable.current)return;
  const current=history.current;
  history.current={messages:merge(current.messages,rows),hasOlder:current.messages.length?current.hasOlder:page.hasOlder};
  setMessages(history.current.messages);setHasOlder(history.current.hasOlder);read(page.messages);
 }
 async function refresh(){
  if(!alive.current||unavailable.current)return;
  if(refreshBusy.current){refreshPending.current=true;return;}
  refreshBusy.current=true;
  try{const r=await latestMessages(id);if(!alive.current||unavailable.current)return;if(r.status==="not_available")makeUnavailable();else if(r.status==="ok")await acceptNewest(r);else setStatus("メッセージを表示できません。");}
  catch{if(alive.current&&!unavailable.current)setStatus("メッセージを表示できません。");}
  finally{refreshBusy.current=false;if(refreshPending.current){refreshPending.current=false;void refresh();}}
 }
 useEffect(()=>{
  if(!available)return;
  let active=true,recovering=false;
  let client:ReturnType<typeof createBrowserSupabase>;
  try{client=createBrowserSupabase();}catch{return;}
  let channel:ReturnType<typeof client.channel>|undefined;
  // A fresh browser client has not necessarily loaded its cookie session yet.
  // Join with the user JWT from the start, including on direct room navigation.
  void (async()=>{
   try{await client.realtime.setAuth();}catch{return;}
   if(!active||unavailable.current)return;
   channel=client.channel(`chat:${id}`)
   .on("postgres_changes",{event:"INSERT",schema:"public",table:"messages",filter:`conversation_id=eq.${id}`},()=>{if(active)void refresh();})
   .subscribe(status=>{
    if(!active||unavailable.current)return;
    if(status==="CHANNEL_ERROR"||status==="TIMED_OUT"||status==="CLOSED")recovering=true;
    else if(status==="SUBSCRIBED"&&recovering){recovering=false;void refresh();}
   });
  })();
  return ()=>{active=false;if(channel)void client.removeChannel(channel);};
 // Room identity is fixed by its page key; refresh uses refs for current state.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[id,available]);
 async function older(){if(olderBusy.current||!messages[0])return;olderBusy.current=true;setLoadingOlder(true);try{const r=await olderMessages(id,messages[0].id);if(!alive.current||unavailable.current)return;if(r.status==="not_available")makeUnavailable();else if(r.status==="ok"){if(log.current)scroll.current={height:log.current.scrollHeight,top:log.current.scrollTop};history.current={messages:merge(history.current.messages,r.messages),hasOlder:r.hasOlder};setMessages(history.current.messages);setHasOlder(r.hasOlder);}else setStatus("以前のメッセージを表示できません。");}catch{setStatus("以前のメッセージを表示できません。");}finally{olderBusy.current=false;setLoadingOlder(false);}}
 async function send(){if(busy.current||!available||!validateBody(body))return;busy.current=true;setSending(true);const attempt=retry.current?.body===body?retry.current:{body,id:crypto.randomUUID()};retry.current=attempt;
 try{const r=await sendChatMessage(id,attempt.id,attempt.body);if(!alive.current||unavailable.current)return;if(r.status==="ok"){scroll.current="bottom";await acceptNewest(r);if(!alive.current||unavailable.current)return;setBody(current=>current===attempt.body?"":current);retry.current=null;setStatus("メッセージを送信しました。");}else if(r.status==="not_available")makeUnavailable();else{if(r.status!=="unavailable")retry.current=null;setStatus(r.status==="rate_limited"?"しばらくしてから再度お試しください。":"メッセージを送信できません。");}}catch{setStatus("メッセージを送信できません。");}finally{busy.current=false;setSending(false);}}
 const back=<Link href={"/talk"} className={textLink}>トーク一覧へ戻る</Link>;
 if(!available)return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}><h1 className={pageTitle}>この会話は表示できません</h1><div className="mt-6">{back}</div></main>;
 return <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex h-dvh max-w-2xl flex-col bg-white px-4 text-ink sm:px-8"><header className="py-3">{back}<h1 className="text-xl font-medium">{conversation.partner.name}</h1><SafetyControlsLive kind="conversation" id={id} name={conversation.partner.name} block onBlocked={()=>makeUnavailable()} /><button type="button" className={secondaryButton} onClick={()=>void refresh()}>新しいメッセージを確認</button></header><div>{hasOlder&&<button type="button" className={secondaryButton} disabled={loadingOlder} onClick={()=>void older()}>以前のメッセージ</button>}</div><div ref={log} role="log" aria-label="会話履歴" aria-live="polite" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto py-3 [overflow-anchor:none]"><ol className="space-y-4">{messages.map(m=><li key={m.id} className={`flex ${m.mine?"justify-end":"justify-start"}`}><div className={`max-w-[85%] rounded-2xl px-4 py-3 ${m.hidden?"border border-line bg-white text-ink":m.mine?"bg-black text-white":"bg-surface text-ink"}`}><span className="sr-only">{m.mine?"自分":conversation.partner.name}：</span>{m.hidden?<HiddenContentNotice/>:<p className="whitespace-pre-wrap break-words">{m.body}</p>}<time dateTime={m.createdAt} className="mt-2 block text-xs">{clock.format(new Date(m.createdAt))}</time>{!m.mine&&!m.hidden&&<SafetyControlsLive kind="message" id={id} message={{id:m.id,body:m.body,time:clock.format(new Date(m.createdAt))}} />}</div></li>)}</ol></div><form className="shrink-0 border-t border-line py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" onSubmit={e=>{e.preventDefault();void send();}}><label htmlFor="chat-body" className="text-sm">メッセージ</label><textarea id="chat-body" rows={2} value={body} aria-describedby="chat-count" className="mt-2 block min-h-16 w-full resize-none rounded-xl border border-line p-3" onChange={e=>setBody(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/><p id="chat-count" className="mt-2 text-xs text-muted">{[...body].length} / 2000文字</p><button type="submit" className={`${primaryButton} mt-2 disabled:opacity-40`} disabled={sending||!validateBody(body)}>送信</button><p role="status" className="min-h-5 text-xs leading-5">{status}</p></form></main>;
}
