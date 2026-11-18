"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminLiveShell } from "@/components/admin-live";
import { reportDate } from "@/components/admin-report-list-live";
import { reportReasons } from "@/lib/safety-gateway";
import { reactivateSuspendedAccount, type AccountActionResult } from "@/server/admin-account-actions";
import type { SuspendedRow } from "@/server/admin-accounts";
import { pageTitle } from "@/components/ui-tokens";

const control = "min-h-11 rounded-xl border border-line px-4 py-2 disabled:opacity-50";
const unavailable = "現在操作できません。時間をおいて再度お試しください。";
function reasonLabel(reason: string | null): string {
  if (reason === null) return "記録なし";
  return Object.hasOwn(reportReasons, reason) ? reportReasons[reason as keyof typeof reportReasons] : reason;
}
function feedback(status: AccountActionResult["status"]): string {
  if (status === "ok") return "停止を解除しました。";
  if (status === "invalid_state") return "状態が変わったため解除できませんでした。";
  if (status === "forbidden") return "この操作の権限がありません。";
  if (status === "invalid") return "入力内容を確認してください。";
  if (status === "unauthenticated") return "再度ログインしてください。";
  return unavailable;
}

export function AdminAccountsLive({ rows }: { rows: SuspendedRow[] }) {
  const router = useRouter();
  const lock = useRef(false), heading = useRef<HTMLHeadingElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null), returnFocus = useRef(false);
  const [selection, setSelection] = useState<SuspendedRow | null>(null);
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    if (selection) {
      dialog.current?.showModal();
      dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [selection]);
  useEffect(() => { if (selection && pending) dialog.current?.focus(); }, [selection, pending]);
  useEffect(() => {
    if (!selection && !pending && returnFocus.current) {
      returnFocus.current = false;
      if (trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus();
      else heading.current?.focus();
    }
  }, [selection, pending, rows]);
  // A reactivated account leaves the refreshed list with its button; keep focus on the page instead of losing it.
  useEffect(() => {
    if (trigger.current && !trigger.current.isConnected && (!document.activeElement || document.activeElement === document.body)) {
      trigger.current = null;
      heading.current?.focus();
    }
  }, [rows]);
  function close() {
    if (lock.current) return;
    returnFocus.current = true;
    dialog.current?.close();
    setSelection(null);
  }
  async function reactivate() {
    if (lock.current || !selection) return;
    lock.current = true;
    setPending(true);
    setMessage("");
    try {
      const result = await reactivateSuspendedAccount(selection.userId);
      setMessage(feedback(result.status));
      if (result.status === "ok" || result.status === "invalid_state") router.refresh();
    } catch { setMessage(unavailable); }
    finally {
      lock.current = false;
      setPending(false);
      close();
    }
  }
  return <AdminLiveShell>
    <h1 ref={heading} tabIndex={-1} className={`mt-5 ${pageTitle}`}>停止中のアカウント</h1>
    <p role="status" className="my-4">{message}</p>
    {rows.length === 0 && <p className="my-6">停止中のアカウントはありません。</p>}
    <ul className="my-6 grid gap-4">{rows.map(row => <li key={row.userId} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line p-5">
      <div>
        <h2 className="font-medium">{row.name}</h2>
        <p className="mt-2 text-sm text-muted">ID {row.shortId}</p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm text-muted">
          <dt>停止日</dt><dd>{row.suspendedAt === null ? "記録なし" : reportDate(row.suspendedAt)}</dd>
          <dt>理由</dt><dd>{reasonLabel(row.reason)}</dd>
        </dl>
      </div>
      <button className={control} disabled={pending || !!selection} onClick={e => {
        if (lock.current || selection) return;
        trigger.current = e.currentTarget;
        setSelection(row);
      }}>停止を解除</button>
    </li>)}</ul>
    {selection && <dialog ref={dialog} tabIndex={-1} aria-labelledby="reactivate-title" aria-describedby="reactivate-description"
      className="m-auto max-w-lg rounded-2xl p-6 backdrop:bg-black/40"
      onCancel={e => { e.preventDefault(); close(); }} onKeyDown={e => {
        if (e.key !== "Tab") return;
        const nodes = Array.from(dialog.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const first = nodes[0], last = nodes.at(-1);
        if (!first) { e.preventDefault(); dialog.current?.focus(); }
        else if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first.focus(); }
      }}>
      <h2 id="reactivate-title" className="text-lg">停止を解除</h2>
      <p id="reactivate-description" className="my-4">{selection.name}（ID {selection.shortId}）の停止を解除し、利用できる状態に戻します。</p>
      <fieldset disabled={pending} className="flex flex-wrap gap-3">
        <button className={control} onClick={close}>キャンセル</button>
        <button className={control} onClick={() => void reactivate()}>解除する</button>
      </fieldset>
    </dialog>}
  </AdminLiveShell>;
}
