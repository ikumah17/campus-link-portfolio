"use client";
import { useRouter } from "next/navigation";
import { useEffect,useRef,useState } from "react";
import { hideReportContent,unhideReportContent,type ReportActionResult } from "@/server/admin-report-actions";
import type { ReportContentItem } from "@/server/admin-reports";
import { HIDDEN_CONTENT_TEXT } from "@/components/hidden-content";
const control="min-h-11 rounded-xl border border-line px-4 py-2 disabled:opacity-50";
const labels={message:"メッセージ",request_message:"申請メッセージ",bio:"自己紹介",photo:"写真"};
const label=(c:ReportContentItem)=>c.item==="photo"?`写真 ${(c.position??0)+1}`:labels[c.item];
const undoable=(c:ReportContentItem)=>c.item==="message"||c.item==="request_message";
const consequence=(c:ReportContentItem)=>undoable(c)?`両方の参加者には「${HIDDEN_CONTENT_TEXT}」と表示されます。後から表示を戻せます。`
 :c.item==="photo"?"この写真は削除され、元に戻せません。最後の1枚の場合、本人が新しい写真を登録するまでプロフィールは表示されなくなります。"
 :"本人が新しく書き直すまで、この自己紹介はどこにも表示されなくなります。元に戻せません。";
// MOD-001: the content a report points at, with its state and the hide (and, for messages, undo) action.
// Results go to the detail page's single status region through onMessage.
export function AdminReportContentLive({reportId,content,disabled,onMessage,onBusy}:{reportId:string;content:ReportContentItem[]|null;disabled:boolean;onMessage:(m:string)=>void;onBusy:(busy:boolean)=>void}) {
 const router=useRouter(),lock=useRef(false),dialog=useRef<HTMLDialogElement>(null),triggers=useRef(new Map<string,HTMLButtonElement>()),returnFocus=useRef<string|null>(null);
 const [target,setTarget]=useState<{key:string;item:ReportContentItem;undo:boolean}|null>(null),[pending,setPending]=useState(false);
 useEffect(()=>{if(target){dialog.current?.showModal();dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();}},[target]);
 useEffect(()=>{if(target&&pending)dialog.current?.focus();},[target,pending]);
 // the trigger is disabled while pending; focus it once it is enabled again
 useEffect(()=>{if(!target&&!pending&&!disabled&&returnFocus.current!==null){triggers.current.get(returnFocus.current)?.focus();returnFocus.current=null;}},[target,pending,disabled]);
 function close(){if(lock.current||!target)return;returnFocus.current=target.key;dialog.current?.close();setTarget(null);triggers.current.get(target.key)?.focus();}
 async function act(){
  if(lock.current||!target)return;lock.current=true;setPending(true);onBusy(true);onMessage("");
  const {item,undo}=target;
  try{const r:ReportActionResult=undo?await unhideReportContent(reportId,item.item):await hideReportContent(reportId,item.item,item.item==="photo"?item.ref:null);
   if(r.status==="ok"){onMessage(undo?"表示を戻しました。":"内容を非表示にしました。");router.refresh();}
   else onMessage(r.status==="forbidden"?"この操作の権限がありません。":r.status==="invalid_state"?"状態が変わったため操作できません。":r.status==="unauthenticated"?"再度ログインしてください。":"現在操作できません。時間をおいて再度お試しください。");
  }catch{onMessage("現在操作できません。時間をおいて再度お試しください。");}
  finally{lock.current=false;setPending(false);onBusy(false);close();}
 }
 function open(key:string,item:ReportContentItem,undo:boolean){if(lock.current||target||disabled)return;setTarget({key,item,undo});}
 const busy=disabled||pending;
 return <section aria-labelledby="report-content-title" className="mt-8"><h2 id="report-content-title">通報された内容</h2>
 {content===null?<p>内容を表示できません。</p>:content.length===0?<p>非表示にできる内容はありません。</p>:<ul className="mt-3 grid gap-4">{content.map(c=>{const key=`${c.item}:${c.ref??""}`,name=label(c);
  return <li key={key} className="grid gap-2 rounded-2xl border border-line p-4"><h3>{name}</h3>
  {c.item==="photo"&&c.ref?/* eslint-disable-next-line @next/next/no-img-element */<img src={`/admin/reports/${reportId}/photos/${c.ref}`} alt={name} width={160} height={160} loading="lazy" className="size-40 rounded-2xl object-cover"/>
   :c.body!==null?<blockquote className="whitespace-pre-wrap break-words">{c.body}</blockquote>:null}
  <p>{c.hidden?"非表示（運営）":"表示中"}</p>
  {c.hidden?undoable(c)&&<button className={control} ref={el=>{if(el)triggers.current.set(key,el);else triggers.current.delete(key);}} disabled={busy} aria-label={`${name}の表示を戻す`} onClick={()=>open(key,c,true)}>表示を戻す</button>
   :<button className={control} ref={el=>{if(el)triggers.current.set(key,el);else triggers.current.delete(key);}} disabled={busy} aria-label={`${name}の内容を非表示にする`} onClick={()=>open(key,c,false)}>内容を非表示にする</button>}
  </li>;})}</ul>}
 {target&&<dialog ref={dialog} tabIndex={-1} aria-labelledby="content-dialog-title" aria-describedby="content-dialog-description" className="m-auto max-w-lg rounded-2xl p-6 backdrop:bg-black/40" onCancel={e=>{e.preventDefault();close();}} onKeyDown={e=>{if(e.key!=="Tab")return;const nodes=Array.from(dialog.current!.querySelectorAll<HTMLElement>("button:not(:disabled)"));const first=nodes[0],last=nodes.at(-1);if(!first){e.preventDefault();dialog.current?.focus();return;}if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}>
 <h2 id="content-dialog-title">{target.undo?"表示を戻す":"内容の非表示"}</h2><p id="content-dialog-description">{target.undo?`${label(target.item)}を、両方の参加者に再び表示します。`:`${label(target.item)}を非表示にします。${consequence(target.item)}`}</p>
 <fieldset disabled={pending} className="mt-4 grid gap-3"><button className={control} onClick={close}>キャンセル</button><button className={control} onClick={()=>void act()}>{target.undo?"戻す":"非表示にする"}</button></fieldset></dialog>}
 </section>;
}
