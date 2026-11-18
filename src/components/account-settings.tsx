"use client";
import Link from "next/link";
import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { primaryButton, secondaryButton, inputClass } from "@/components/auth-demo-form";
import { MainNav } from "@/components/main-nav";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { DELETE_CONFIRMATION, PAUSE_NOTE, actionMessages, type AccountActionStatus, type AccountState } from "@/server/account-rules";
import { pageTitle, standalonePage, tabPage, textLink } from "@/components/ui-tokens";

export type AccountActions = {
  pause: () => Promise<{ status: AccountActionStatus }>;
  resume: () => Promise<{ status: AccountActionStatus }>;
  // The live action redirects after a successful deletion, so it only returns refusals.
  remove: (confirmation: string) => Promise<{ status: AccountActionStatus } | undefined>;
};
const DEMO_NOTICE = "デモ：この画面を開いている間だけ保持され、実際のアカウントには反映されません。";
const message = (status: AccountActionStatus | undefined) => status && status !== "ok" ? actionMessages[status] : "";

export function AccountDeleted({ demo = false }: { demo?: boolean }) {
  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}>
    <h1 className={pageTitle}>退会の手続きが完了しました</h1>
    <p className="mt-4 text-[15px] leading-7 text-muted">{demo ? DEMO_NOTICE : "ログアウトしました。"}</p>
    <Link href="/welcome" className={`${secondaryButton} mt-10 w-full`}>トップへ</Link>
  </main>;
}

function DeleteDialog({ onClose, onConfirm, returnFocus }: { onClose: () => void; onConfirm: (word: string) => Promise<AccountActionStatus | undefined>; returnFocus: RefObject<HTMLElement | null> }) {
  const titleId = useId(), bodyId = useId(), inputId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  useLayoutEffect(() => {
    panel.current?.querySelector<HTMLElement>("input")?.focus();
    const trigger = returnFocus.current;
    return () => queueMicrotask(() => {
      if (trigger?.isConnected && !trigger.closest("[inert]")) trigger.focus();
      else document.getElementById(MAIN_CONTENT_ID)?.focus();
    });
  }, [returnFocus]);
  const controls = () => [...(panel.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled)") ?? [])];
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-[28px] bg-white p-6 text-ink shadow-xl" onKeyDown={(e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!inFlight.current) onClose(); }
      if (e.key === "Tab") {
        const list = controls(), first = list[0], last = list.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <h2 id={titleId} className="text-xl font-medium">退会しますか</h2>
      <p id={bodyId} className="mt-3 text-sm leading-7">退会は取り消せません。つながりは終了し、いいねは消えます。データは<Link href="/privacy" prefetch={false} className="underline underline-offset-4">プライバシーポリシー</Link>の保存期間に従って削除されます。</p>
      <form className="mt-5 flex flex-col gap-3" onSubmit={async (e) => {
        e.preventDefault();
        if (inFlight.current || word !== DELETE_CONFIRMATION) return;
        inFlight.current = true; setBusy(true); setStatus("");
        try { setStatus(message(await onConfirm(word))); }
        catch { setStatus(actionMessages.unavailable); }
        finally { inFlight.current = false; setBusy(false); }
      }}>
        <label htmlFor={inputId} className="text-sm">確認のため「{DELETE_CONFIRMATION}」と入力してください</label>
        <input id={inputId} value={word} onChange={(e) => setWord(e.target.value)} autoComplete="off" className={`${inputClass} mt-0`} />
        <button type="submit" className={primaryButton} disabled={busy || word !== DELETE_CONFIRMATION}>退会する</button>
        <button type="button" className={secondaryButton} disabled={busy} onClick={onClose}>キャンセル</button>
      </form>
      <p role="status" className="mt-3 text-sm">{status}</p>
    </div>
  </div>;
}

export function AccountSettingsView({ initialState, actions, demo = false, onStale }: { initialState: AccountState; actions: AccountActions; demo?: boolean; onStale?: () => void }) {
  const [state, setState] = useState(initialState);
  // A server refresh (revalidation or a stale-state reload) brings the database's status without dropping the message.
  const [shown, setShown] = useState(initialState);
  if (shown !== initialState) { setShown(initialState); setState(initialState); }
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const inFlight = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (deleted) return <AccountDeleted demo={demo} />;
  async function toggle() {
    if (inFlight.current || state === "suspended") return;
    inFlight.current = true; setBusy(true); setStatus("");
    const pausing = state === "active";
    try {
      const result = (await (pausing ? actions.pause() : actions.resume())).status;
      if (result === "ok") { setState(pausing ? "deactivated" : "active"); setStatus(pausing ? "休止しました。" : "再開しました。"); }
      else { setStatus(message(result)); if (result === "invalid_state") onStale?.(); }
    } catch { setStatus(actionMessages.unavailable); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function remove(word: string) {
    const result = (await actions.remove(word))?.status;
    if (result === "ok") setDeleted(true);
    return result;
  }
  return <div className="min-h-screen bg-white text-ink">
    <div inert={deleting}>
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className={tabPage}>
        <Link href={"/mypage"} className={textLink}>マイページへ戻る</Link>
        <h1 className={`mt-4 ${pageTitle}`}>アカウント</h1>
        {demo && <p role="note" className="mt-4 rounded-[18px] border border-line px-4 py-3 text-[13px] leading-6 text-ink-soft">{DEMO_NOTICE}</p>}
        <section aria-labelledby="account-pause" className="mt-8 rounded-[24px] bg-surface p-6">
          <h2 id="account-pause" className="text-[15px] font-medium">休止</h2>
          <p className="mt-3 text-[15px] leading-7 text-muted">{PAUSE_NOTE}</p>
          {state === "suspended" ? <p className="mt-4 text-[15px]">このアカウントは停止されています。</p> : <>
            <p className="mt-4 text-[15px]">{state === "deactivated" ? "休止中です。" : "利用中です。"}</p>
            <button type="button" className={`${secondaryButton} mt-4 w-full`} disabled={busy} onClick={toggle}>{state === "deactivated" ? "再開する" : "休止する"}</button>
          </>}
          <p role="status" className="mt-3 text-sm">{status}</p>
        </section>
        <section aria-labelledby="account-delete" className="mt-8 rounded-[24px] bg-surface p-6">
          <h2 id="account-delete" className="text-[15px] font-medium">退会</h2>
          <p className="mt-3 text-[15px] leading-7 text-muted">退会は取り消せません。</p>
          <button ref={trigger} type="button" className={`${secondaryButton} mt-4 w-full`} onClick={() => setDeleting(true)}>退会の手続きへ</button>
        </section>
      </main>
      <MainNav current="mypage" />
    </div>
    {deleting && <DeleteDialog onClose={() => setDeleting(false)} onConfirm={remove} returnFocus={trigger} />}
  </div>;
}

const demoActions: AccountActions = {
  pause: async () => ({ status: "ok" }),
  resume: async () => ({ status: "ok" }),
  remove: async (word) => ({ status: word === DELETE_CONFIRMATION ? "ok" : "invalid" }),
};
// In-memory only, like the other demo settings: nothing is sent and a reload starts over.
export function AccountSettings() {
  return <AccountSettingsView initialState="active" actions={demoActions} demo />;
}
