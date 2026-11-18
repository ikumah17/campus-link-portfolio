"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { MainNav } from "@/components/main-nav";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { LIKE_TEXT, likeMessages, type LikeOutcome } from "@/components/like-controls";
import { purposeText, type Purpose } from "@/lib/onboarding-rules";
import { emptyState, noticeText, pageTitle, primaryButton, secondaryButton, tabPage, textLink } from "@/components/ui-tokens";

// The likes page (docs/43 §4.1), shared by the demo and the live screens.
export type LikeRow = { id: string; name: string; age: number; school: string; purposes: Purpose[]; image: { src: string; alt: string } | null; href: string; extra?: ReactNode };
export type LikeAnswer = { status: LikeOutcome; conversationId?: string };
export const LIKES_DESCRIPTION = "お互いにいいねすると、マッチしてトークで話せます。";
const TABS = ["いいねされた", "いいねした"] as const;

export function LikesView({ received, sent, onLikeBack, onUnlike, notice, more, onDone, initialTab = 0 }: { received: LikeRow[]; sent: LikeRow[]; onLikeBack: (id: string) => Promise<LikeAnswer>; onUnlike: (id: string) => Promise<LikeAnswer>; notice?: string; more?: [ReactNode, ReactNode]; onDone?: () => void; initialTab?: 0 | 1 }) {
  const [tab, setTab] = useState<number>(initialTab), [status, setStatus] = useState("");
  const [talk, setTalk] = useState<string | null>(null), [busy, setBusy] = useState<Set<string>>(new Set()), [gone, setGone] = useState<Set<string>>(new Set());
  const running = useRef(new Set<string>()), statusRef = useRef<HTMLParagraphElement>(null);
  async function act(row: LikeRow, kind: "back" | "unlike") {
    if (running.current.has(row.id)) return;
    running.current.add(row.id); setBusy(new Set(running.current)); setTalk(null);
    let answer: LikeAnswer;
    try { answer = await (kind === "back" ? onLikeBack(row.id) : onUnlike(row.id)); } catch { answer = { status: "unavailable" }; }
    if (answer.status === "ok") {
      setGone((g) => new Set(g).add(`${kind}:${row.id}`));
      if (kind === "unlike") setStatus(LIKE_TEXT.unliked);
      else if (answer.conversationId) { setStatus(LIKE_TEXT.matched); setTalk(`/talk/${answer.conversationId}`); }
      else setStatus(LIKE_TEXT.liked);
    } else {
      setStatus(likeMessages[answer.status]);
      if (answer.status === "already_connected") setTalk("/talk");
    }
    running.current.delete(row.id); setBusy(new Set(running.current)); statusRef.current?.focus();
    if (answer.status === "ok") onDone?.();
  }
  const rows = (tab === 0 ? received : sent).filter((r) => !gone.has(`${tab === 0 ? "back" : "unlike"}:${r.id}`));
  return <div className="min-h-screen bg-white text-ink">
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className={tabPage}>
      <h1 className={pageTitle}>いいね</h1>
      <p className="mt-2 text-[15px] leading-7 text-ink-soft">{LIKES_DESCRIPTION}</p>
      {notice && <p className={noticeText}>{notice}</p>}
      <div role="tablist" aria-label="いいねの一覧" className="mt-8 flex gap-3">{TABS.map((label, i) => <button key={label} id={`likes-tab-${i}`} role="tab" type="button" aria-selected={tab === i} aria-controls="likes-panel" tabIndex={tab === i ? 0 : -1} className={`${secondaryButton} flex-1 ${tab === i ? "bg-surface border-ink" : ""}`} onClick={() => setTab(i)} onKeyDown={(e) => {
        const next = e.key === "Home" ? 0 : e.key === "End" ? 1 : ["ArrowLeft", "ArrowRight"].includes(e.key) ? 1 - i : null;
        if (next !== null) { e.preventDefault(); setTab(next); document.getElementById(`likes-tab-${next}`)?.focus(); }
      }}>{label}</button>)}</div>
      <p role="status" ref={statusRef} tabIndex={-1} className="mt-5 min-h-6 text-sm leading-6">{status}</p>
      {talk && <Link href={talk} className={`${primaryButton} mt-3`}>トークを開く</Link>}
      <section id="likes-panel" role="tabpanel" aria-labelledby={`likes-tab-${tab}`} tabIndex={0} className="mt-5">
        <ul className="space-y-4">{rows.map((r) => <li key={r.id} className="rounded-[24px] border border-line p-5">
          <Link href={r.href} prefetch={false} className="flex items-center gap-4">
            {r.image ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={r.image.src} alt={r.image.alt} width={64} height={64} className="size-16 shrink-0 rounded-2xl object-cover" /> : <div className="size-16 shrink-0 rounded-2xl bg-surface" />}
            <div className="min-w-0"><h2 className="text-lg font-medium">{r.name} <span className="text-base font-normal text-ink-soft">{r.age}歳</span></h2>
              <p className="mt-1 text-sm text-muted">{r.school}</p>
              {r.purposes.length > 0 && <p className="mt-1 text-sm text-muted">{purposeText(r.purposes)}</p>}</div>
          </Link>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {tab === 0 ? <button type="button" disabled={busy.has(r.id)} aria-label={`${r.name}にいいねを返す`} onClick={() => void act(r, "back")} className={`${primaryButton} disabled:opacity-50`}>いいねを返す</button>
              : <button type="button" disabled={busy.has(r.id)} aria-label={`${r.name}へのいいねを取り消す`} onClick={() => void act(r, "unlike")} className={`${secondaryButton} disabled:opacity-50`}>取り消す</button>}
            {r.extra}
          </div>
        </li>)}</ul>
        {rows.length === 0 && (tab === 0 ? <p className={emptyState}>まだいいねはありません。</p> : <div className={emptyState}><p>まだいいねしていません。</p><Link href="/" className={`${textLink} text-ink`}>探す</Link></div>)}
        {more?.[tab]}
      </section>
    </main>
    <MainNav current="likes" />
  </div>;
}
