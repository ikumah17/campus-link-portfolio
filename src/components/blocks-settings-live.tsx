"use client";
import { useState } from "react";
import Link from "next/link";
import { SafetyControlsLive } from "./safety-controls-live";
import type { LiveBlock, LiveReport } from "@/server/safety-data";
import { emptyState, pageTitle, tabPage, textLink } from "@/components/ui-tokens";
// Fixed zone so the server render and hydration agree.
const day=new Intl.DateTimeFormat("ja-JP",{year:"numeric",month:"2-digit",day:"2-digit",timeZone:"Asia/Tokyo"});
export function BlocksSettingsLive({blocks:initial,reports}:{blocks:LiveBlock[];reports:LiveReport[]}){
 const [blocks,setBlocks]=useState(initial);
 const labels={open:"受付済み",triaged:"確認中",actioned:"対応済み",dismissed:"対応なし"};
 return <main id="main-content" tabIndex={-1} className={tabPage}><Link href="/mypage" className={textLink}>マイページへ戻る</Link><h1 className={`mt-4 ${pageTitle}`}>ブロック中のユーザー</h1>{blocks.length===0?<p className={`mt-6 ${emptyState}`}>ブロック中のユーザーはいません。</p>:<ul className="mt-6 divide-y divide-line">{blocks.map(b=><li key={b.key} className="py-4"><p>{b.name??"表示できないユーザー"}</p><time className="text-xs text-muted" dateTime={b.createdAt}>{day.format(new Date(b.createdAt))}</time><SafetyControlsLive kind="profile" id={b.key} unblock onBlocked={()=>setBlocks(rows=>rows.filter(row=>row.key!==b.key))}/></li>)}</ul>}<section className="mt-10"><h2 className="text-lg font-medium">通報の履歴</h2>{reports.length===0?<p className={`mt-3 ${emptyState}`}>通報の履歴はありません。</p>:<ul className="mt-3 space-y-3">{reports.map((r,i)=><li key={i} className="text-sm"><time dateTime={r.createdAt}>{day.format(new Date(r.createdAt))}</time> · <span>{labels[r.status]}</span></li>)}</ul>}</section></main>;
}
