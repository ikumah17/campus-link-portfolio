"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { inputClass, primaryButton, secondaryButton } from "@/components/auth-demo-form";
import { VerificationShell } from "@/components/verification";
import { createDemoSubmissions, demoReviewer } from "@/data/demo-verifications";
import { claim, release, decide, kindLabels, statusLabels, sampleLabel, type Result, type VerificationStatus } from "@/lib/verification-demo";
import { pageTitle } from "@/components/ui-tokens";

const filters = ["submitted", "in_review", "approved", "rejected"] as const;
export function AdminVerifications() {
  const [state, setState] = useState(createDemoSubmissions);
  const [filter, setFilter] = useState<VerificationStatus>("submitted");
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const current = state.find((s) => s.id === selected);
  function apply(result: Result, message: string) {
    if (result.code !== "ok") {
      setError(result.code === "validation" ? "却下理由を1〜200文字で入力してください。" : "状態が変わったため操作できません。もう一度選んでください。");
      reasonInput.current?.focus(); return;
    }
    setState([...result.state]); setError(""); setStatus(`${message}（デモ）。`);
    requestAnimationFrame(() => detailHeading.current?.focus());
  }
  return <VerificationShell>
    <Link href="/admin" className="mb-4 inline-flex min-h-11 min-w-11 items-center underline">管理画面へ戻る</Link>
    <h1 className={pageTitle}>審査画面のデモ</h1>
    <p className="mt-3 text-sm leading-6 text-muted">実際のアクセス制御はありません。架空の人物だけを表示しています。</p>
    <p className="mt-2 text-sm leading-6 text-muted">利用者画面の提出とは連動しません。デモ審査担当（架空）として操作します。</p>
    <div role="tablist" aria-label="提出状況" className="mt-7 flex flex-wrap gap-2">{filters.map((value) => <button key={value} id={`tab-${value}`} type="button" role="tab" aria-selected={filter === value} aria-controls="submission-list" tabIndex={filter === value ? 0 : -1} className={`${secondaryButton} ${filter === value ? "border-ink bg-surface" : ""}`} onClick={() => setFilter(value)} onKeyDown={(event) => {
      const index = filters.indexOf(value);
      const next = event.key === "ArrowRight" ? (index + 1) % filters.length : event.key === "ArrowLeft" ? (index + filters.length - 1) % filters.length : event.key === "Home" ? 0 : event.key === "End" ? filters.length - 1 : null;
      if (next !== null) { event.preventDefault(); setFilter(filters[next]); document.getElementById(`tab-${filters[next]}`)?.focus(); }
    }}>{statusLabels[value]}</button>)}</div>
    <p role="status" className="my-5 min-h-6 text-sm">{status}</p>
    <div role="tabpanel" id="submission-list" aria-labelledby={`tab-${filter}`} tabIndex={0} className="rounded-[24px] border border-line p-3">
      <ul className="space-y-3">{state.filter((s) => s.status === filter).map((s) => <li key={s.id}><button type="button" aria-pressed={selected === s.id} className="min-h-14 w-full rounded-[18px] bg-surface p-4 text-left" onClick={() => { setSelected(s.id); setReason(""); setError(""); requestAnimationFrame(() => detailHeading.current?.focus()); }}>
        <span className="flex flex-wrap justify-between gap-2"><span>{kindLabels[s.kind]} · {s.displayName}</span><span className="text-sm">{statusLabels[s.status]}</span></span><span className="mt-2 block text-sm leading-6 text-muted">{s.affiliation}</span>
      </button></li>)}</ul>
      {!state.some((s) => s.status === filter) && <p className="p-4 text-sm text-muted">この状態の提出はありません。</p>}
    </div>
    {current && <section aria-labelledby="detail-title" className="mt-6 rounded-[24px] border border-line p-5 sm:p-7">
      <h2 id="detail-title" ref={detailHeading} tabIndex={-1} className="text-xl font-medium">提出の詳細</h2>
      <dl className="mt-5 space-y-2 text-sm leading-6"><dt>表示名</dt><dd>{current.displayName}</dd><dt>種類と状態</dt><dd>{kindLabels[current.kind]} · {statusLabels[current.status]}</dd><dt>申告した生年月日（架空）</dt><dd>{current.birthDate}</dd><dt>提出時の所属（架空）</dt><dd>{current.affiliation}</dd><dt>架空の資料</dt><dd>{current.refs.map((ref) => <span key={ref} className="block">{sampleLabel(ref)}</span>)}</dd>
        {current.reviewerId && <><dt>担当</dt><dd>デモ審査担当（架空）</dd></>}
        {current.decidedAt && <><dt>決定日時（架空・固定）</dt><dd>{current.decidedAt}</dd></>}
        {current.reason && <><dt>却下理由</dt><dd className="whitespace-pre-wrap break-words">{current.reason}</dd></>}
      </dl>
      <div className="mt-6 flex flex-wrap gap-3">
        {current.status === "submitted" && <button type="button" className={primaryButton} onClick={() => apply(claim(state, current.id, demoReviewer), "担当しました")}>担当する</button>}
        {current.status === "in_review" && current.reviewerId === demoReviewer && <>
          <button type="button" className={secondaryButton} onClick={() => apply(release(state, current.id, demoReviewer), "担当を外しました")}>担当を外す</button>
          <button type="button" className={primaryButton} onClick={() => apply(decide(state, current.id, demoReviewer, true, "", current.version), "承認しました")}>承認</button>
        </>}
      </div>
      {current.status === "in_review" && current.reviewerId === demoReviewer && <form noValidate className="mt-5" onSubmit={(event) => { event.preventDefault(); apply(decide(state, current.id, demoReviewer, false, reason, current.version), "却下しました"); }}>
        <label htmlFor="rejection-reason">却下理由（1〜200文字）</label><textarea ref={reasonInput} id="rejection-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} aria-invalid={!!error} aria-describedby="reason-count reason-error" className={inputClass} />
        <p id="reason-count" className="mt-2 text-right text-sm text-muted">{[...reason].length} / 200文字</p><p id="reason-error" className="mt-2 text-sm">{error}</p>
        <button type="submit" className={`${secondaryButton} mt-3`}>却下</button>
      </form>}
    </section>}
  </VerificationShell>;
}
