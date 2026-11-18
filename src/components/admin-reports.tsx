"use client";

import { useRef, useState } from "react";
import { AdminShell } from "@/components/admin-dashboard";
import { inputClass, secondaryButton } from "@/components/auth-demo-form";
import { reportReasons } from "@/lib/safety-gateway";
import { contextLabels, reportStatuses, statusLabels, transitions, type AdminReport, type ReportStatus } from "@/lib/admin-gateway";
import { useAdmin } from "@/lib/admin-demo";
import { pageTitle } from "@/components/ui-tokens";

export function AdminReports() {
  const { demo, refresh } = useAdmin();
  const [filter, setFilter] = useState<ReportStatus>("open");
  const [current, setCurrent] = useState<AdminReport | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [note, setNote] = useState(""); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const heading = useRef<HTMLHeadingElement>(null); const noteRef = useRef<HTMLTextAreaElement>(null);
  function focusDetail() { requestAnimationFrame(() => heading.current?.focus()); }
  function changeTab(value: ReportStatus) { setFilter(value); setCurrent(null); setUnavailable(false); setError(""); }
  function update(status: ReportStatus) {
    if (!current) return;
    const result = demo.gateway.adminUpdateReport(current.id, status, note);
    if (result.code !== "ok") { setError(result.code === "validation" ? "メモは1000文字以内で入力してください。" : "状態が変わったため操作できません。"); noteRef.current?.focus(); return; }
    refresh(); setCurrent(result.data); setNote(""); setError(""); setMessage(`${statusLabels[status]}に変更しました（デモ）。`); focusDetail();
  }
  return <AdminShell><h1 className={pageTitle}>通報</h1><p className="mt-3 text-sm text-muted">実際の運用では閲覧と変更を監査します。このデモでは監査を行いません。</p>
    <div role="tablist" aria-label="通報の状態" className="mt-6 flex flex-wrap gap-2">{reportStatuses.map((value, index) => <button key={value} id={`report-tab-${value}`} role="tab" aria-selected={filter === value} aria-controls="report-list" tabIndex={filter === value ? 0 : -1} className={secondaryButton} onClick={() => changeTab(value)} onKeyDown={(event) => {
      const next = event.key === "ArrowRight" ? (index + 1) % 4 : event.key === "ArrowLeft" ? (index + 3) % 4 : event.key === "Home" ? 0 : event.key === "End" ? 3 : null;
      if (next !== null) { event.preventDefault(); changeTab(reportStatuses[next]); document.getElementById(`report-tab-${reportStatuses[next]}`)?.focus(); }
    }}>{statusLabels[value]}</button>)}</div>
    <p role="status" className="my-4 min-h-6 text-sm">{message}</p>
    <div id="report-list" role="tabpanel" aria-labelledby={`report-tab-${filter}`} tabIndex={0} className="rounded-[24px] border border-line p-3"><ul className="space-y-3">{demo.gateway.adminListReports(filter).data?.map((row) => <li key={row.id}><button className="min-h-14 w-full rounded-[18px] bg-surface p-4 text-left" onClick={() => {
      const result = demo.gateway.adminGetReport(row.id); setCurrent(result.data); setUnavailable(result.code === "not_available"); setNote(""); setError(""); focusDetail();
    }}><span className="block">{contextLabels[row.context]} · {reportReasons[row.reason]}</span><span className="mt-2 block text-sm text-muted">{row.createdAt} · {statusLabels[row.status]}</span></button></li>)}</ul>
    {!demo.gateway.adminListReports(filter).data?.length && <p className="p-4 text-sm">この状態の通報はありません。</p>}</div>
    {(current || unavailable) && <section aria-labelledby="report-detail" className="mt-6 rounded-[24px] border border-line p-5 sm:p-7"><h2 ref={heading} id="report-detail" tabIndex={-1} className="text-xl font-medium">通報の詳細</h2>
      {unavailable ? <p className="mt-4">この通報は担当できません</p> : current && <>
        <dl className="mt-4 space-y-2 break-words text-sm leading-6"><dt>理由</dt><dd>{reportReasons[current.reason]}</dd><dt>詳細（架空）</dt><dd>{current.detail}</dd><dt>状態</dt><dd>{statusLabels[current.status]}</dd></dl>
        {current.snapshot && <blockquote className="mt-4 rounded-[16px] bg-surface p-4 text-sm">{current.snapshot}</blockquote>}
        {current.note && <p className="mt-4 whitespace-pre-wrap break-words text-sm">対応メモ：{current.note}</p>}
        {transitions[current.status].length > 0 && <div className="mt-5"><label htmlFor="report-note">対応メモ（任意）</label><textarea ref={noteRef} id="report-note" className={inputClass} rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={!!error} aria-describedby="report-note-count report-error" />
          <p id="report-note-count" className="mt-2 text-sm text-muted">{[...note].length} / 1000文字</p><p role="alert" id="report-error" className="my-2 text-sm">{error}</p>
          <div className="flex flex-wrap gap-3">{transitions[current.status].map((status) => <button key={status} className={secondaryButton} onClick={() => update(status)}>{statusLabels[status]}にする</button>)}</div>
        </div>}
      </>}
    </section>}
  </AdminShell>;
}
