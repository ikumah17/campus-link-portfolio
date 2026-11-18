"use client";

import { useEffect, useRef, useState } from "react";
import { AdminShell } from "@/components/admin-dashboard";
import { inputClass, primaryButton, secondaryButton } from "@/components/auth-demo-form";
import { nameLimits, type Affiliation, type Level, type AdminResult } from "@/lib/admin-gateway";
import { useAdmin } from "@/lib/admin-demo";
import { pageTitle } from "@/components/ui-tokens";

const labels = { school: "学校", department: "学科", class: "クラス" };
type Editor = { level: Level; id: string | null; parentId: string | null; name: string; active: boolean; sort: string; year: string };
export function AdminAffiliations() {
  const { demo, refresh } = useAdmin();
  const [editor, setEditor] = useState<Editor | null>(null); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const nameRef = useRef<HTMLInputElement>(null); const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => { if (editor) nameRef.current?.focus(); }, [editor?.id, editor?.level, editor?.parentId]); // Focus only when opening a different editor.
  function open(level: Level, parentId: string | null, row?: Affiliation) {
    trigger.current = document.activeElement as HTMLElement;
    setError(""); setEditor({ level, parentId, id: row?.id ?? null, name: row?.name ?? "", active: row?.isActive ?? true, sort: String(row?.sortOrder ?? 0), year: row?.academicYear === null ? "" : String(row?.academicYear ?? 2026) });
    requestAnimationFrame(() => nameRef.current?.focus());
  }
  function close() { setEditor(null); setError(""); requestAnimationFrame(() => trigger.current?.focus()); }
  function save(row: Editor): AdminResult<Affiliation> {
    if (row.level !== "class" && !row.sort.trim()) return { code: "validation", data: null };
    return row.level === "school" ? demo.gateway.adminUpsertSchool(row.id, row.name, row.active, Number(row.sort))
      : row.level === "department" ? demo.gateway.adminUpsertDepartment(row.id, row.parentId!, row.name, row.active, Number(row.sort))
      : demo.gateway.adminUpsertClass(row.id, row.parentId!, row.name, row.year.trim() ? Number(row.year) : null, row.active);
  }
  const items = demo.affiliations();
  function branch(parentId: string | null) {
    return <ul className={parentId ? "ml-2 space-y-3 border-l border-line pl-2 sm:ml-4 sm:pl-4" : "space-y-5"}>{items.filter((r) => r.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja")).map((row) => <li key={row.id}>
      <section aria-label={row.name} className={`rounded-[20px] border border-line p-3 ${row.isActive ? "" : "bg-surface text-muted"}`}>
        <h2 className={`break-words text-base ${row.isActive ? "" : "opacity-70"}`}>{row.name} {!row.isActive && <span>（無効）</span>}</h2>
        <p className="mt-2 text-sm text-muted">{labels[row.level]} · {row.level === "class" ? `年度：${row.academicYear ?? "未設定"}` : `表示順：${row.sortOrder}`}</p>
        <div className="mt-3 flex flex-wrap gap-2"><button className={secondaryButton} onClick={() => open(row.level, row.parentId, row)}>編集</button>
          <button role="switch" aria-checked={row.isActive} aria-label={`${row.name}の有効状態`} className={secondaryButton} onClick={() => {
            const result = save({ level: row.level, id: row.id, parentId: row.parentId, name: row.name, active: !row.isActive, sort: String(row.sortOrder), year: row.academicYear === null ? "" : String(row.academicYear) });
            if (result.code === "ok") { refresh(); setMessage(`${row.name}を${row.isActive ? "無効" : "有効"}にしました（デモ）。`); }
          }}>{row.isActive ? "無効にする" : "有効にする"}</button>
          {row.level !== "class" && <button className={secondaryButton} onClick={() => open(row.level === "school" ? "department" : "class", row.id)}>{row.level === "school" ? "学科" : "クラス"}を追加</button>}
        </div>
      </section><div className="mt-3">{row.level !== "class" && branch(row.id)}</div>
    </li>)}</ul>;
  }
  return <AdminShell><h1 className={pageTitle}>学校・学科・クラス</h1><p className="mt-3 text-sm text-muted">削除は行わず、無効にして残します。親が無効でも子の状態は変更されません。</p>
    <button className={`${secondaryButton} mt-5`} onClick={() => open("school", null)}>学校を追加</button><p role="status" className="my-4 min-h-6 text-sm">{message}</p>
    {editor && <form noValidate aria-label={`${labels[editor.level]}の編集`} className="mb-6 rounded-[24px] border border-line p-5" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }} onSubmit={(event) => {
      event.preventDefault(); const result = save(editor);
      if (result.code !== "ok") { setError(result.code === "validation" ? `名前は1〜${nameLimits[editor.level]}文字、表示順・年度は整数で入力してください。` : result.code === "invalid_state" ? "同じ階層に同名の項目があります。" : "項目が見つかりません。"); nameRef.current?.focus(); return; }
      refresh(); setMessage(`${labels[editor.level]}を保存しました（デモ）。`); close();
    }}>
      <h2 className="text-xl">{labels[editor.level]}{editor.id ? "を編集" : "を追加"}</h2>
      <label className="mt-4 block" htmlFor="affiliation-name">名前</label><input ref={nameRef} id="affiliation-name" className={inputClass} value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} aria-invalid={!!error} aria-describedby="affiliation-count affiliation-error" />
      <p id="affiliation-count" className="mt-2 text-sm text-muted">{[...editor.name].length} / {nameLimits[editor.level]}文字</p>
      {editor.level === "class" ? <><label className="mt-4 block" htmlFor="affiliation-year">年度（任意）</label><input id="affiliation-year" type="number" className={inputClass} value={editor.year} onChange={(e) => setEditor({ ...editor, year: e.target.value })} /></> : <><label className="mt-4 block" htmlFor="affiliation-sort">表示順</label><input id="affiliation-sort" type="number" className={inputClass} value={editor.sort} onChange={(e) => setEditor({ ...editor, sort: e.target.value })} /></>}
      <p role="alert" id="affiliation-error" className="my-3 text-sm">{error}</p><div className="flex flex-wrap gap-3"><button type="submit" className={primaryButton}>保存する</button><button type="button" className={secondaryButton} onClick={close}>キャンセル</button></div>
    </form>}
    {branch(null)}
  </AdminShell>;
}
