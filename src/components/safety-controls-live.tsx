"use client";
import { useId, useRef, useState } from "react";
import Link from "next/link";
import { LiveSafetyDialog, liveSafetyButton as button } from "./safety-dialog-live";
import { reportReasons, type ReportReason } from "@/lib/safety-gateway";
import { blockProfile, blockConversation, unblockUser, reportProfile, reportConversation, reportMessage } from "@/server/safety-actions";
const messages={validation:"入力内容を確認してください。",not_available:"この操作は利用できません。",rate_limited:"しばらくしてから再度お試しください。",unauthenticated:"ログインし直してください。",unavailable:"現在ご利用いただけません。時間をおいて再度お試しください。"};
export function SafetyControlsLive({kind,id,name,message,block=false,unblock=false,onBlocked}:{kind:"profile"|"conversation"|"message";id:string;name?:string;message?:{id:number;body:string;time:string};block?:boolean;unblock?:boolean;onBlocked?:()=>void}){
 const [dialog,setDialog]=useState<"menu"|"block"|"report"|null>(null),[reason,setReason]=useState<ReportReason>("harassment"),[detail,setDetail]=useState(""),[status,setStatus]=useState(""),[done,setDone]=useState(false),[busy,setBusy]=useState(false);
 const fieldId=useId();
 const running=useRef(false),trigger=useRef<HTMLElement|null>(null);
 function open(d:typeof dialog,e:React.MouseEvent<HTMLButtonElement>){trigger.current=e.currentTarget;setStatus("");setDone(false);setDetail("");setDialog(d);}
 async function submit(){if(running.current||done||(dialog==="report"&&[...detail].length>1000))return;running.current=true;setBusy(true);
 try{const r=dialog==="block"?await (unblock?unblockUser(id):kind==="profile"?blockProfile(id):blockConversation(id)):await (kind==="message"?reportMessage(id,message?.id,reason,detail):kind==="conversation"?reportConversation(id,reason,detail):reportProfile(id,reason,detail));
 if(r.status==="ok"){setDone(true);setStatus(dialog==="report"?"通報を受け付けました。":unblock?"ブロックを解除しました。":"ブロックしました。");if(dialog==="block")onBlocked?.();}else setStatus(messages[r.status]);
 }catch{setStatus(messages.unavailable);}finally{running.current=false;setBusy(false);}}
 return <><span inert={dialog!==null}>{block&&kind==="profile"?<><button className={button} onClick={e=>open("block",e)}>ブロック</button><button className={button} onClick={e=>open("report",e)}>通報</button></>:<button className={button} aria-label={message?`メッセージを通報 ${message.time}`:undefined} onClick={e=>open(unblock?"block":block?"menu":"report",e)}>{unblock?"ブロックを解除":block?"ブロック・通報":"通報"}</button>}</span>
 {dialog&&<LiveSafetyDialog title={dialog==="menu"?"ブロック・通報":dialog==="report"?"通報":unblock?"ブロックを解除しますか":`${name??"相手"}をブロックしますか`} returnFocus={trigger.current} onClose={()=>{if(!running.current)setDialog(null);}}>
 {dialog==="menu"?<><button className={button} onClick={()=>setDialog("block")}>ブロック</button><button className={button} onClick={()=>setDialog("report")}>通報</button></>:<>
 {dialog==="block"?<p>{unblock?"ブロックを解除しても、消えたいいねや終了したつながりは元に戻りません。":"お互いに表示されなくなり、いいねとつながりは終了します。"}</p>:<>{message&&<blockquote className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{message.body}</blockquote>}<fieldset disabled={done||busy}><legend>通報の理由</legend>{Object.entries(reportReasons).map(([key,label])=><label key={key} className="flex min-h-11 gap-3"><input type="radio" name={fieldId} checked={reason===key} onChange={()=>setReason(key as ReportReason)}/>{label}</label>)}<label>詳細（任意）<textarea className="block w-full rounded-xl border border-line p-3" aria-describedby={`${fieldId}-count`} aria-invalid={[...detail].length>1000} value={detail} onChange={e=>setDetail(e.target.value)} /></label><p id={`${fieldId}-count`} aria-live="polite">{[...detail].length} / 1000文字</p></fieldset></>}
 {!done&&<button className={button} disabled={busy||(dialog==="report"&&[...detail].length>1000)} onClick={()=>void submit()}>{dialog==="report"?"通報する":unblock?"ブロックを解除":"ブロックする"}</button>}<p role="status">{status}</p>{done&&dialog==="block"&&!unblock&&kind==="profile"&&<Link href="/">一覧へ戻る</Link>}</>}
 <button className={button} disabled={busy} onClick={()=>setDialog(null)}>{done?"閉じる":"キャンセル"}</button></LiveSafetyDialog>}</>;
}
