"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Affiliation, Level } from "@/lib/admin-gateway";
import { AdminLiveShell } from "@/components/admin-live";
import { saveAffiliation, setAffiliationActive, type AffiliationActionResult } from "@/server/admin-affiliation-actions";
import { pageTitle } from "@/components/ui-tokens";

type Draft = Omit<Affiliation, "id"> & { id: string | null };
const labels = { school: "学校", department: "学科", class: "クラス" };
function message(status: AffiliationActionResult["status"], limit: number) {
  if (status === "invalid") return `名前は1〜${limit}文字、表示順は0〜9999、年度は2000〜2100の整数で入力してください。`;
  if (status === "duplicate") return "同じ階層に同名の項目があります。";
  if (status === "not_found") return "項目が見つかりません。再読み込みしてください。";
  if (status === "forbidden") return "この操作の権限がありません。";
  return "保存できませんでした。時間をおいてもう一度お試しください。";
}
export function AdminAffiliationsLive({ rows }: { rows: Affiliation[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState(false);
  const focusAfterRender = useRef<"opener" | "name" | null>(null);
  useLayoutEffect(() => {
    if (busy || !focusAfterRender.current) return;
    (focusAfterRender.current === "opener" ? opener.current : nameInput.current)?.focus();
    focusAfterRender.current = null;
  });
  function close() { focusAfterRender.current = "opener"; setDraft(null); }
  function open(row: Draft, button: HTMLButtonElement) {
    opener.current = button; setDraft(row); setName(row.name); setNumber(row.level === "class" ? String(row.academicYear ?? "") : String(row.sortOrder)); setNotice(""); setError(false);
  }
  async function run(action: () => Promise<AffiliationActionResult>, success: string, editing = false) {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    let result: AffiliationActionResult;
    try { result = await action(); } catch { result = { status: "unavailable" }; }
    pending.current = false; setBusy(false);
    setError(result.status !== "ok");
    if (result.status === "ok") { setNotice(success); if (editing) close(); router.refresh(); }
    else { setNotice(message(result.status, draft?.level === "class" ? 40 : 80)); if (editing) focusAfterRender.current = "name"; }
  }
  function add(level: Level, parentId: string | null, button: HTMLButtonElement) { open({ id: null, level, parentId, name: "", isActive: true, sortOrder: 0, academicYear: null }, button); }
  function tree(level: Level, parentId: string | null) {
    return rows.filter(r => r.level === level && r.parentId === parentId).map(r => { const year = r.level === "class" ? `年度：${r.academicYear ?? "未設定"}` : null; const label = year ? `${r.name}（${year}）` : r.name; return <li key={r.id} className="mt-4 rounded-2xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className={r.isActive ? "" : "text-muted"}>{r.name}{!r.isActive && "（無効）"}</span>
        {year && <span className="text-sm text-muted">{year}</span>}
        <button className="min-h-11 px-3 underline" disabled={busy} onClick={e => open(r, e.currentTarget)} aria-label={`${label}を編集`}>編集</button>
        <button className="min-h-11 px-3 underline" role="switch" aria-checked={r.isActive} aria-label={`${label}の有効状態`} disabled={busy} onClick={() => void run(() => setAffiliationActive(r.level, r.id, !r.isActive), `${r.name}を${r.isActive ? "無効" : "有効"}にしました。`)}>{r.isActive ? "有効" : "無効"}</button>
        {level !== "class" && <button className="min-h-11 px-3 underline" disabled={busy} onClick={e => add(level === "school" ? "department" : "class", r.id, e.currentTarget)}>{level === "school" ? "学科を追加" : "クラスを追加"}</button>}
      </div>
      {level !== "class" && <ul className="pl-4">{tree(level === "school" ? "department" : "class", r.id)}</ul>}
    </li>; });
  }
  return <AdminLiveShell>
    <h1 className={`mt-5 ${pageTitle}`}>学校・学科・クラス</h1>
    <p className="mt-5 text-sm">削除は行わず、無効にして残します。親が無効でも子の状態は変更されません。</p>
    <p className="mt-2 text-sm">変更は監査ログに記録されます。</p>
    <button className="mt-5 min-h-11 rounded-full border border-line px-5 text-sm" disabled={busy} onClick={e => add("school", null, e.currentTarget)}>学校を追加</button>
    {notice && <p className="mt-4" role={error ? "alert" : "status"}>{notice}</p>}
    {!rows.some(r => r.level === "school") && <p className="mt-5">学校はまだありません。</p>}
    <ul>{tree("school", null)}</ul>
    {draft && <form className="mt-6 grid gap-4 rounded-2xl border border-line p-5" aria-label={`${labels[draft.level]}の編集`} onKeyDown={e => { if (e.key === "Escape" && !pending.current) { e.preventDefault(); close(); } }} onSubmit={e => {
      e.preventDefault();
      const numeric = number.trim() === "" ? (draft.level === "class" ? null : NaN) : Number(number);
      void run(() => saveAffiliation({ ...draft, name, sortOrder: draft.level === "class" ? 0 : numeric, academicYear: draft.level === "class" ? numeric : null }), `${labels[draft.level]}を保存しました。`, true);
    }}>
      <label>名前<input className="block min-h-11 w-full rounded-lg border border-line px-3" ref={nameInput} autoFocus value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
      <p>{[...name].length} / {draft.level === "class" ? 40 : 80}文字</p>
      <label>{draft.level === "class" ? "年度（任意）" : "表示順"}<input className="block min-h-11 rounded-lg border border-line px-3" inputMode="numeric" value={number} disabled={busy} onChange={e => setNumber(e.target.value)} /></label>
      <div className="flex gap-4"><button className="min-h-11 px-4 underline" disabled={busy} type="submit">保存</button><button className="min-h-11 px-4 underline" disabled={busy} type="button" onClick={close}>キャンセル</button></div>
    </form>}
  </AdminLiveShell>;
}
