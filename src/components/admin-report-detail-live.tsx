"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect,useRef,useState } from "react";
import { AdminLiveShell } from "@/components/admin-live";
import { reportDate } from "@/components/admin-report-list-live";
import { contextLabels,statusLabels,transitions,type ReportStatus } from "@/lib/admin-gateway";
import { reportReasons } from "@/lib/safety-gateway";
import { updateReport,suspendReportTarget,reactivateReportTarget,type ReportActionResult } from "@/server/admin-report-actions";
import type { ReportContentItem,ReportDetail } from "@/server/admin-reports";
import { AdminReportContentLive } from "@/components/admin-report-content-live";
import { pageTitle } from "@/components/ui-tokens";
const control="min-h-11 rounded-xl border border-line px-4 py-2 disabled:opacity-50";
export function AdminReportDetailLive({report,content}:{report:ReportDetail;content?:ReportContentItem[]|null}) {
 const router=useRouter(),lock=useRef(false),heading=useRef<HTMLHeadingElement>(null),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const returnFocus=useRef(false),reactivateTrigger=useRef<HTMLButtonElement>(null);
 const [reactivating,setReactivating]=useState(false),[contentBusy,setContentBusy]=useState(false);
 const [pending,setPending]=useState(false),[opened,setOpened]=useState(false),[note,setNote]=useState(""),[reason,setReason]=useState<string>(report.reason),[message,setMessage]=useState("");
 useEffect(()=>{heading.current?.focus();},[]);
 useEffect(()=>{if(opened){dialog.current?.showModal();dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();}},[opened]);
 useEffect(()=>{if(opened&&pending)dialog.current?.focus();},[opened,pending]);
 useEffect(()=>{if(!opened&&!pending&&returnFocus.current){returnFocus.current=false;(reactivating?reactivateTrigger:trigger).current?.focus();}},[opened,pending,reactivating]);
 function close(){if(lock.current)return;returnFocus.current=true;dialog.current?.close();setOpened(false);(reactivating?reactivateTrigger:trigger).current?.focus();}
 async function act(next?:ReportStatus) {
  if(lock.current)return;lock.current=true;setPending(true);setMessage("");
  try{const r:ReportActionResult=next?await updateReport(report.id,next,note):reactivating?await reactivateReportTarget(report.id):await suspendReportTarget(report.id,reason);
   if(r.status==="ok"){setMessage(next?`${statusLabels[next]}に変更しました。`:reactivating?"アカウントを再開しました。":"アカウントを停止しました。");router.refresh();}
   else setMessage(r.status==="forbidden"?"この操作の権限がありません。":r.status==="invalid_state"?(next?"状態が変わったため操作できません。":reactivating?"この利用者は停止されていません。":"この利用者は停止できません。"):reactivating&&!next?"現在操作できません。時間をおいて再度お試しください。":r.status==="invalid"?(next?"メモは1000文字以内で入力してください。":"理由を選択してください。"):r.status==="unauthenticated"?"再度ログインしてください。":"現在操作できません。時間をおいて再度お試しください。");
  }catch{setMessage("現在操作できません。時間をおいて再度お試しください。");}
  finally{lock.current=false;setPending(false);if(!next)close();}
 }
 return <AdminLiveShell><Link href={`/admin/reports?status=${report.status}`}>一覧へ戻る</Link><h1 ref={heading} tabIndex={-1} className={`mt-5 ${pageTitle}`}>通報の詳細</h1>
 <dl className="my-6 grid gap-3">{[["理由",reportReasons[report.reason]],["対象",report.targetLabel??"対象なし"],["種別",contextLabels[report.context]],["日付",reportDate(report.createdAt)],["状態",statusLabels[report.status]],["詳細",report.detail||"なし"]].map(([label,value])=><div key={label}><dt>{label}</dt><dd className="whitespace-pre-wrap break-words">{value}</dd></div>)}</dl>
 {report.evidence&&<section aria-label="メッセージの証拠"><blockquote className="whitespace-pre-wrap break-words">{report.evidence.body}</blockquote>{report.evidence.createdAt&&<time dateTime={report.evidence.createdAt}>{report.evidence.createdAt}</time>}</section>}
 <p role="status" className="my-4">{message}</p>
 {transitions[report.status].length>0&&<fieldset disabled={pending||contentBusy} className="grid gap-3"><legend>状態の変更</legend><label>対応メモ（任意）<textarea className={control+" block w-full"} value={note} onChange={e=>setNote(e.target.value)}/></label><p>{[...note].length}/1000</p>{transitions[report.status].map(s=><button className={control} key={s} onClick={()=>void act(s)}>{statusLabels[s]}にする</button>)}</fieldset>}
 {content!==undefined&&<AdminReportContentLive reportId={report.id} content={content} disabled={pending} onMessage={setMessage} onBusy={setContentBusy}/>}
 <section className="mt-8"><h2>アカウントの停止</h2><button className={control} ref={trigger} disabled={pending||contentBusy||!report.targetLabel} onClick={()=>{if(lock.current||opened)return;setReactivating(false);setOpened(true);}}>アカウントを停止</button><button className={control} ref={reactivateTrigger} disabled={pending||contentBusy||!report.targetLabel} onClick={()=>{if(lock.current||opened)return;setReactivating(true);setOpened(true);}}>停止を解除</button></section>
 {opened&&<dialog ref={dialog} tabIndex={-1} aria-labelledby="suspend-title" aria-describedby="suspend-description" className="m-auto max-w-lg rounded-2xl p-6 backdrop:bg-black/40" onCancel={e=>{e.preventDefault();close();}} onKeyDown={e=>{if(e.key!=="Tab")return;const nodes=Array.from(dialog.current!.querySelectorAll<HTMLElement>("button:not(:disabled),select:not(:disabled)"));const first=nodes[0],last=nodes.at(-1);if(!first){e.preventDefault();dialog.current?.focus();return;}if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}>
 <h2 id="suspend-title">{reactivating?"停止の解除":"アカウントの停止"}</h2><p id="suspend-description">{reactivating?`${report.targetLabel}のアカウントを再開します。他の利用者に再び表示されるようになります。`:`${report.targetLabel}のアカウントは、再開されるまで他の利用者に表示されなくなります。`}</p><fieldset disabled={pending} className="mt-4 grid gap-3"><button className={control} onClick={close}>キャンセル</button>{!reactivating&&<label>停止理由<select className={control} value={reason} onChange={e=>setReason(e.target.value)}>{Object.entries(reportReasons).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>}<button className={control} onClick={()=>void act()}>{reactivating?"再開する":"停止する"}</button></fieldset></dialog>}
 </AdminLiveShell>;
}
