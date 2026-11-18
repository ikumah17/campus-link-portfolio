"use client";
import { BlockDialog, SafetyDialog, safetyButton } from "@/components/block-dialog";
import { ReportDialog } from "@/components/report-dialog";
import { useDemoLikes } from "@/components/demo-likes-provider";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChatGateway } from "@/components/demo-chat-provider";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { primaryButton, secondaryButton } from "@/components/auth-demo-form";
import { CHAT_NOTICE, validateBody, type ChatMessage, type Conversation } from "@/lib/chat-gateway";
import { loadingText, noticeText, pageTitle, standalonePage, textLink } from "@/components/ui-tokens";

export function ChatRoom({ id }: { id: string }) {
  const { state } = useDemoLikes();
  const [safetyMenu, setSafetyMenu] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [report, setReport] = useState<"profile" | ChatMessage | null>(null);
  const safetyTrigger = useRef<HTMLButtonElement>(null);
  const gateway = useChatGateway();
  const [conversation, setConversation] = useState<Conversation | null | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [announcement, setAnnouncement] = useState(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const olderBusy = useRef(false);
  const scroll = useRef<{ height: number; top: number } | "bottom" | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await gateway.listMyConversations();
      const row = result.data.find((c) => c.id === id);
      if (!row) { if (active) setConversation(null); return; }
      const page = await gateway.listMessages(id);
      if (!active) return;
      setConversation(row); setMessages(page.data.slice().reverse()); setHasOlder(page.data.length === 30); scroll.current = "bottom";
      if (page.data[0]) await gateway.markRead(id, page.data[0].id);
    })();
    return () => { active = false; };
  }, [gateway, id]);
  useLayoutEffect(() => {
    if (log.current && scroll.current) {
      log.current.scrollTop = scroll.current === "bottom" ? log.current.scrollHeight : scroll.current.top + log.current.scrollHeight - scroll.current.height;
      scroll.current = null;
    }
  }, [messages]);
  async function older() {
    if (olderBusy.current || !messages[0]) return;
    olderBusy.current = true; setLoadingOlder(true);
    try {
      const page = await gateway.listMessages(id, { before: messages[0].id, limit: 30 });
      if (page.code !== "ok") { setStatus("以前のメッセージを表示できません。"); return; }
      if (log.current) scroll.current = { height: log.current.scrollHeight, top: log.current.scrollTop };
      setMessages((rows) => [...page.data.slice().reverse(), ...rows]); setHasOlder(page.data.length === 30);
      if (page.data.length < 30) log.current?.focus({ preventScroll: true });
    } finally { olderBusy.current = false; setLoadingOlder(false); }
  }
  async function send() {
    if (busy.current || !validateBody(body)) return;
    busy.current = true; setSending(true);
    try {
      const result = await gateway.sendMessage(id, crypto.randomUUID(), body);
      if (result.code === "ok" && result.data) {
        const message = result.data;
        scroll.current = "bottom";
        setMessages((rows) => rows.some((m) => m.id === message.id) ? rows : [...rows, message]);
        setBody(""); setStatus("メッセージを送信しました（デモ）。"); setAnnouncement((value) => value + 1);
      } else setStatus(result.code === "rate_limited" ? "しばらくしてから再度お試しください。" : "メッセージを送信できません。");
    } finally { busy.current = false; setSending(false); composer.current?.focus(); }
  }
  const back = <Link href={"/talk"} className={textLink}>トーク一覧へ戻る</Link>;
  if (conversation === undefined) return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}><p role="status" className={loadingText}>読み込み中</p></main>;
  if (conversation === null || (state.blocks?.some((b) => b.blocked_id === id) && !blockOpen)) return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}><h1 className={pageTitle}>この会話は表示できません</h1><div className="mt-6">{back}</div><p className={noticeText}>{CHAT_NOTICE}</p></main>;
  return <><main inert={safetyMenu || blockOpen || report !== null} id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex h-dvh max-w-2xl flex-col bg-white px-4 text-ink sm:px-8">
    <header className="shrink-0 py-3">{back}<div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-xl font-medium">{conversation.partner.name}</h1><button ref={safetyTrigger} type="button" onClick={() => setSafetyMenu(true)} className={secondaryButton}>ブロック・通報</button></div><p className="mt-2 text-xs leading-5 text-muted">{CHAT_NOTICE}</p></header>
    <div className="min-h-14 shrink-0 py-1">{hasOlder && <button className={secondaryButton} type="button" disabled={loadingOlder} onClick={older}>以前のメッセージ</button>}</div>
    <div ref={log} role="log" aria-label="会話履歴" aria-live="polite" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3 [overflow-anchor:none]">
      {messages.length === 0 && <p className="text-sm text-muted">まだメッセージはありません。</p>}
      <ol className="space-y-4">{messages.map((m) => {
        const own = m.sender !== id;
        return <li key={m.id} className={`flex ${own ? "justify-end" : "justify-start"}`}><div className={`max-w-[85%] rounded-2xl px-4 py-3 ${own ? "bg-black text-white" : "bg-surface text-ink"}`}><span className="sr-only">{own ? "自分" : conversation.partner.name}：</span><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.body}</p><time dateTime={new Date(m.createdAt).toISOString()} className="mt-2 block text-xs">{new Date(m.createdAt).toISOString().slice(11, 16)}</time>{!own && <button type="button" aria-label={`メッセージ ${m.id} を通報`} className="mt-1 min-h-11 min-w-11 rounded-full px-3 text-xs underline" onClick={() => setReport(m)}>通報</button>}</div></li>;
      })}</ol>
    </div>
    <form className="shrink-0 border-t border-line py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <label htmlFor="chat-body" className="text-sm">メッセージ</label>
      <textarea ref={composer} id="chat-body" value={body} rows={2} aria-describedby="chat-count" className="mt-2 block min-h-16 w-full resize-none rounded-xl border border-line p-3" onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <div className="mt-2 flex items-center justify-between gap-3"><p id="chat-count" aria-live="polite" className="text-xs text-muted">{[...body].length} / 2000文字</p><button type="submit" disabled={sending || !validateBody(body)} className={`${primaryButton} disabled:opacity-40`}>送信</button></div>
      <p role="status" className="min-h-5 text-xs leading-5"><span key={announcement}>{status}</span></p>
    </form>
  </main>
    {safetyMenu && <SafetyDialog title="ブロック・通報" onClose={() => setSafetyMenu(false)}><div className="flex flex-col gap-3">
      <button type="button" className={safetyButton} onClick={() => { setSafetyMenu(false); safetyTrigger.current?.focus(); setBlockOpen(true); }}>ブロック</button>
      <button type="button" className={safetyButton} onClick={() => { setSafetyMenu(false); safetyTrigger.current?.focus(); setReport("profile"); }}>通報</button>
      <button type="button" className={safetyButton} onClick={() => setSafetyMenu(false)}>キャンセル</button>
    </div></SafetyDialog>}
    {blockOpen && <BlockDialog target={id} returnFocus={safetyTrigger.current} onClose={() => setBlockOpen(false)} />}
    {report !== null && <ReportDialog target={id} returnFocus={report === "profile" ? safetyTrigger.current : undefined} context={report === "profile" ? "profile" : "message"} message={report === "profile" ? undefined : report} onClose={() => setReport(null)} />}
  </>;
}
