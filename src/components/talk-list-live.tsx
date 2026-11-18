import Link from "next/link";
import { TalkListRealtime } from "@/components/talk-list-realtime";
import { MainNav } from "@/components/main-nav";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import type { LiveConversation } from "@/server/chat-data";
import { emptyState, pageTitle, tabPage, textLink } from "@/components/ui-tokens";
export function TalkListLive({conversations}:{conversations:LiveConversation[]}){
 return <div className="min-h-screen bg-white text-ink"><TalkListRealtime/><main id={MAIN_CONTENT_ID} tabIndex={-1} className={tabPage}><h1 className={pageTitle}>トーク</h1>{conversations.length===0?<div className={`mt-8 ${emptyState}`}><p>つながりはまだありません。</p><Link href="/likes" className={`mt-2 ${textLink} text-ink`}>いいねを見る</Link></div>:<ul className="mt-8 divide-y divide-line">{conversations.map(row=><li key={row.id}><Link prefetch={false} href={`/talk/${row.id}`} className="flex min-h-24 items-center gap-4 rounded-2xl py-4">{row.partner.photoId?<img src={`/media/photos/${row.partner.photoId}`} alt="" width={64} height={64} className="size-16 shrink-0 rounded-2xl object-cover"/>:<div className="size-16 shrink-0 rounded-2xl bg-surface"/>}<div className="min-w-0 flex-1"><h2 className="font-medium">{row.partner.name}</h2><p className="mt-2 truncate text-sm text-muted">{row.latest?.body??"メッセージを送ってみましょう。"}</p></div>{row.unread&&<span className="shrink-0 rounded-full bg-black px-2 py-1 text-xs text-white">未読</span>}</Link></li>)}</ul>}</main><MainNav current="talk"/></div>;
}
