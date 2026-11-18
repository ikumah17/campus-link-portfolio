"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useChatGateway } from "@/components/demo-chat-provider";
import { MainNav } from "@/components/main-nav";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { CHAT_NOTICE, type Conversation } from "@/lib/chat-gateway";
import { emptyState, loadingText, noticeText, pageTitle, tabPage, textLink } from "@/components/ui-tokens";

export function TalkList() {
  const gateway = useChatGateway();
  const [rows, setRows] = useState<Conversation[] | null>(null);
  useEffect(() => { let active = true; void gateway.listMyConversations().then((r) => { if (active) setRows(r.data); }); return () => { active = false; }; }, [gateway]);
  return <div className="min-h-screen bg-white text-ink"><main id={MAIN_CONTENT_ID} tabIndex={-1} className={tabPage}>
    <h1 className={pageTitle}>トーク</h1><p className={noticeText}>{CHAT_NOTICE}</p>
    {rows === null ? <p role="status" className={`mt-8 ${loadingText}`}>読み込み中</p> : rows.length === 0 ? <div className={`mt-8 ${emptyState}`}><p>つながりはまだありません。</p><Link href="/likes" className={`mt-2 ${textLink} text-ink`}>いいねを見る</Link></div> : <ul className="mt-8 divide-y divide-line">{rows.map((row) => <li key={row.id}>
      <Link href={`/talk/${row.id}`} className="flex min-h-24 items-center gap-4 rounded-2xl py-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={row.partner.image} alt={row.partner.imageAlt} width={64} height={64} className="size-16 shrink-0 rounded-2xl object-cover" />
        <div className="min-w-0 flex-1"><h2 className="font-medium">{row.partner.name}</h2><p className="mt-2 truncate text-sm text-muted">{row.latest?.body ?? "メッセージを送ってみましょう。"}</p></div>
        {row.unread && <span className="shrink-0 rounded-full bg-black px-2 py-1 text-xs text-white">未読</span>}
      </Link></li>)}</ul>}
  </main><MainNav current="talk" /></div>;
}
