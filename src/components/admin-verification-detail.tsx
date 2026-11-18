"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { AdminLiveShell } from "@/components/admin-live";
import { controlClass, submissionTime, VerificationActionError } from "@/components/admin-verification-list";
import { REJECTION_REASONS } from "@/lib/verification-reasons";
import { decideSubmission, releaseSubmission, type AdminVerificationResult } from "@/server/admin-verification-actions";
import type { SubmissionDetail } from "@/server/admin-verifications";
import { pageTitle } from "@/components/ui-tokens";

// Provisional enrollment validity: the reviewer can change this next March 31.
export function defaultValidityDate(now = new Date()): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const year = Number(today.slice(0, 4));
  // The action requires a date after today, so 31 March itself moves to next year.
  return `${today < `${year}-03-31` ? year : year + 1}-03-31`;
}
export function AdminVerificationDetail({ submission }: { submission: SubmissionDetail }) {
  const router = useRouter();
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AdminVerificationResult["status"] | null>(null);
  const [reason, setReason] = useState("");
  const [validUntil, setValidUntil] = useState(defaultValidityDate);
  async function act(action: "approve" | "reject" | "release") {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try {
      const r = action === "release" ? await releaseSubmission(submission.id) : await decideSubmission({
        id: submission.id, kind: submission.kind, approve: action === "approve", reason: action === "reject" ? reason : null,
        validUntil: submission.kind === "enrollment" && action === "approve" ? validUntil : null, expectedVersion: submission.version,
      });
      if (r.status === "ok") router.push(`/admin/verifications?notice=${action === "release" ? "released" : "decided"}`);
      else setError(r.status);
    } catch { setError("unavailable"); }
    finally { lock.current = false; setPending(false); }
  }
  return <AdminLiveShell>
    <h1 className={`mt-5 ${pageTitle}`}>提出の審査</h1>
    <dl className="mt-6 grid gap-3"><div><dt>種類</dt><dd>{submission.kind === "age" ? "年齢確認" : "在学確認"}</dd></div>
      <div><dt>提出日時</dt><dd><time dateTime={submission.created_at}>{submissionTime(submission.created_at)}（日本時間）</time></dd></div>
      {submission.kind === "age" ? <div><dt>申告した生年月日</dt><dd>{submission.birth_date ?? "確認できません"}</dd></div> : <>
        <div><dt>学校</dt><dd>{submission.school_name ?? "確認できません"}</dd></div>
        <div><dt>学科</dt><dd>{submission.department_name ?? "確認できません"}</dd></div>
        <div><dt>クラス</dt><dd>{submission.class_name ?? "確認できません"}</dd></div>
      </>}
    </dl>
    <section aria-label="提出資料" className="mt-6 grid gap-4">{Array.from({ length: submission.documentCount }, (_, i) =>
      // The audited document route authorizes each lazy request independently.
      // eslint-disable-next-line @next/next/no-img-element
      <img key={i} src={`/admin/documents/${submission.id}/${i + 1}`} alt={`提出資料 ${i + 1}`} width={480} loading="lazy" className="h-auto max-w-full rounded-xl border border-line" />)}</section>
    <VerificationActionError status={error} />
    <fieldset disabled={pending} aria-busy={pending} className="mt-7 grid gap-4">
      <legend className="sr-only">審査の操作</legend>
      <form onSubmit={e => { e.preventDefault(); void act("approve"); }} className="grid gap-3">
        {submission.kind === "enrollment" && <label className="grid gap-2">有効期限<input type="date" required value={validUntil} onChange={e => setValidUntil(e.target.value)} className={controlClass} /></label>}
        <button type="submit" className={controlClass}>承認</button>
      </form>
      <form onSubmit={e => { e.preventDefault(); void act("reject"); }} className="grid gap-3">
        <label className="grid gap-2">却下理由<select required value={reason} onChange={e => setReason(e.target.value)} className={controlClass}><option value="">選択してください</option>{Object.entries(REJECTION_REASONS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
        <button type="submit" disabled={!reason || pending} className={controlClass}>却下</button>
      </form>
      <button type="button" className={controlClass} onClick={() => void act("release")}>担当を外す</button>
    </fieldset>
  </AdminLiveShell>;
}
