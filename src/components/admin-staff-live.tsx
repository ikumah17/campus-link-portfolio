"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminLiveShell } from "@/components/admin-live";
import { grantRole, revokeRole, type StaffActionResult } from "@/server/admin-staff-actions";
import type { StaffRole, StaffRow } from "@/server/admin-staff";
import { pageTitle } from "@/components/ui-tokens";

const roleNames: Record<StaffRole, string> = { admin: "管理者", moderator: "通報対応", reviewer: "学生認証審査" };
const control = "min-h-11 rounded-xl border border-line px-4 py-2 disabled:opacity-50";
const unavailable = "現在操作できません。時間をおいて再度お試しください。";
type Selection = { row: StaffRow; role: StaffRole };
function feedback(status: StaffActionResult["status"], granting: boolean): string {
  if (status === "ok") return granting ? "役割を付与しました。" : "役割を外しました。";
  if (status === "invalid_state") return granting ? "すでにその役割があります。" : "状態が変わったか、最後の管理者のため外せません。";
  if (status === "not_found" && granting) return "該当するアカウントがありません。";
  if (status === "mfa_required" && granting) return "二段階認証（TOTP）を登録済みのアカウントにだけ役割を付けられます。";
  if (status === "forbidden") return "この操作の権限がありません。";
  if (status === "invalid") return "入力内容を確認してください。";
  if (status === "unauthenticated") return "再度ログインしてください。";
  return unavailable;
}

export function AdminStaffLive({ rows }: { rows: StaffRow[] }) {
  const router = useRouter();
  const lock = useRef(false), heading = useRef<HTMLHeadingElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null), returnFocus = useRef(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  const [email, setEmail] = useState(""), [role, setRole] = useState<StaffRole>("reviewer");
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
  function close() {
    if (lock.current) return;
    returnFocus.current = true;
    dialog.current?.close();
    setSelection(null);
  }
  async function act(granting: boolean) {
    if (lock.current || granting && selection || !granting && !selection) return;
    lock.current = true;
    setPending(true);
    setMessage("");
    try {
      const result = granting ? await grantRole(email, role) : await revokeRole(selection!.row.handle, selection!.role);
      setMessage(feedback(result.status, granting));
      if (result.status === "ok") {
        if (!granting && selection!.row.isMe && selection!.role === "admin") router.push("/");
        else router.refresh();
      }
    } catch { setMessage(unavailable); }
    finally {
      if (granting) setEmail("");
      lock.current = false;
      setPending(false);
      if (!granting) close();
    }
  }
  return <AdminLiveShell>
    <h1 ref={heading} tabIndex={-1} className={`mt-5 ${pageTitle}`}>担当者と役割</h1>
    <p role="status" className="my-4">{message}</p>
    {!rows.some(r => r.roles.some((active, i) => active === "admin" && r.acting[i] === true)) &&
      <p className="my-6">働いている管理者がいません。運用の手順（docs/38 §2）で付け直してください。</p>}
    {rows.length === 0 && <p className="my-6">担当者はいません。</p>}
    <ul className="my-6 grid gap-4">{rows.map(row => <li key={row.handle} className="rounded-2xl border border-line p-5">
      <h2 className="font-medium">{row.name ?? "名前未設定"}{row.isMe && <span className="ml-3 text-sm">あなた</span>}</h2>
      <p className="my-2 text-sm text-muted">{row.label}</p>
      <ul className="grid gap-2">{row.roles.map((active, i) => <li key={active} className="flex flex-wrap items-center justify-between gap-3">
        <span>{roleNames[active]}{row.acting[i] !== true && <span className="ml-3 text-sm text-muted">無効（要素の変更後）</span>}</span>
        <button className={control} disabled={pending || !!selection} onClick={e => {
          if (lock.current || selection) return;
          trigger.current = e.currentTarget;
          setSelection({ row, role: active });
        }}>{roleNames[active]}を外す</button>
      </li>)}</ul>
    </li>)}</ul>
    <form onSubmit={e => { e.preventDefault(); void act(true); }}>
      <fieldset disabled={pending || !!selection} className="grid gap-4">
        <legend className="mb-4 text-lg">役割を付与する</legend>
        <label>メールアドレス<input className={control + " mt-2 block w-full"} type="email" autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>役割<select className={control + " ml-3"} value={role} onChange={e => setRole(e.target.value as StaffRole)}>
          {Object.entries(roleNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
        </select></label>
        <button className={control} type="submit">付与する</button>
      </fieldset>
    </form>
    {selection && <dialog ref={dialog} tabIndex={-1} aria-labelledby="revoke-role-title" aria-describedby="revoke-role-description"
      className="m-auto max-w-lg rounded-2xl p-6 backdrop:bg-black/40"
      onCancel={e => { e.preventDefault(); close(); }} onKeyDown={e => {
        if (e.key !== "Tab") return;
        const nodes = Array.from(dialog.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const first = nodes[0], last = nodes.at(-1);
        if (!first) { e.preventDefault(); dialog.current?.focus(); }
        else if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first.focus(); }
      }}>
      <h2 id="revoke-role-title" className="text-lg">役割を外す</h2>
      <div id="revoke-role-description" className="my-4">
        <p>{selection.row.label}の{roleNames[selection.role]}を外します。</p>
        {selection.row.isMe && selection.role === "admin" && <p>外すと、この画面を使えなくなります。</p>}
      </div>
      <fieldset disabled={pending} className="flex flex-wrap gap-3">
        <button className={control} onClick={close}>キャンセル</button>
        <button className={control} onClick={() => void act(false)}>外す</button>
      </fieldset>
    </dialog>}
  </AdminLiveShell>;
}
