"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { AdminLiveShell } from "@/components/admin-live";
import { REVOCATION_REASONS } from "@/lib/verification-reasons";
import { claimSubmission, revokeVerification, type AdminVerificationResult } from "@/server/admin-verification-actions";
import type { SubmissionRow, SubmissionStatus } from "@/server/admin-verifications";
import { pageTitle } from "@/components/ui-tokens";

export const controlClass = "inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-line px-4 py-2 text-sm disabled:opacity-50";
export const statusLabels: Record<SubmissionStatus, string> = { submitted: "提出済み", in_review: "審査中", approved: "承認済み", rejected: "却下", revoked: "取消済み" };
export function submissionTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
export function VerificationActionError({ status }: { status: AdminVerificationResult["status"] | null }) {
  if (!status || status === "ok") return null;
  const messages = {
    invalid: "入力内容を確認してください。",
    invalid_state: "状態が変わりました。一覧から開き直してください。",
    forbidden: "この操作はできません。",
    unauthenticated: "ログインの有効期限が切れました。",
    unavailable: "現在保存できません。時間をおいて再度お試しください。",
  };
  return <div role="alert" className="mt-4"><p>{messages[status]}</p>
    {status === "invalid_state" && <Link href="/admin/verifications" prefetch={false} className={`${controlClass} mt-2`}>一覧へ戻る</Link>}
    {status === "unauthenticated" && <Link href="/login?next=/admin/verifications" prefetch={false} className={`${controlClass} mt-2`}>ログイン</Link>}
  </div>;
}

export function AdminVerificationList({ submissions, status, notice = null }: {
  submissions: SubmissionRow[]; status: SubmissionStatus; notice?: "decided" | "released" | null;
}) {
  const router = useRouter();
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AdminVerificationResult["status"] | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  async function act(row: SubmissionRow, revoke: boolean) {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try {
      const r = revoke ? await revokeVerification({ submissionId: row.id, reason }) : await claimSubmission(row.id);
      if (r.status !== "ok") setError(r.status);
      else if (revoke) { setRevokeId(null); setReason(""); router.refresh(); }
      else router.push(`/admin/verifications/${row.id}`);
    } catch { setError("unavailable"); }
    finally { lock.current = false; setPending(false); }
  }
  return <AdminLiveShell>
    <h1 className={`mt-5 ${pageTitle}`}>学生認証審査</h1>
    {notice && <p role="status" className="mt-4">{notice === "decided" ? "審査結果を保存しました。" : "担当を外しました。"}</p>}
    <nav aria-label="提出の状態" className="mt-6 flex flex-wrap gap-2">
      {(Object.keys(statusLabels) as SubmissionStatus[]).map(s => <Link key={s} href={`/admin/verifications?status=${s}`} prefetch={false} aria-current={status === s ? "page" : undefined} className={`${controlClass} ${status === s ? "bg-ink text-white" : ""}`}>{statusLabels[s]}</Link>)}
    </nav>
    <VerificationActionError status={error} />
    <section aria-label="提出一覧" aria-busy={pending} className="mt-6">
      {submissions.length === 0 ? <p>この状態の提出はありません。</p> : <ul className="grid gap-4">{submissions.map(row => <li key={row.id} className="rounded-[24px] border border-line p-5">
        <dl className="grid gap-2 text-sm"><div><dt className="inline">種類： </dt><dd className="inline">{row.kind === "age" ? "年齢確認" : "在学確認"}</dd></div>
          <div><dt className="inline">状態： </dt><dd className="inline">{statusLabels[row.status]}</dd></div>
          <div><dt className="inline">提出日時： </dt><dd className="inline"><time dateTime={row.created_at}>{submissionTime(row.created_at)}（日本時間）</time></dd></div></dl>
        <div className="mt-4">
          {row.status === "submitted" && <button className={controlClass} disabled={pending} onClick={() => void act(row, false)}>担当する</button>}
          {row.status === "in_review" && (row.assignedToMe ? <Link className={controlClass} href={`/admin/verifications/${row.id}`} prefetch={false}>開く</Link> : <p>他の担当者が審査中</p>)}
          {row.status === "approved" && (revokeId !== row.id ? <button className={controlClass} disabled={pending} onClick={() => { setRevokeId(row.id); setReason(""); }}>確認を取り消す</button> :
            <form onSubmit={e => { e.preventDefault(); void act(row, true); }}><label className="grid gap-2">取消理由<select required className={controlClass} value={reason} disabled={pending} onChange={e => setReason(e.target.value)}><option value="">選択してください</option>{Object.entries(REVOCATION_REASONS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
              <button type="submit" disabled={pending || !reason} className={`${controlClass} mt-3`}>取り消す</button>
              <button type="button" disabled={pending} className={`${controlClass} ml-2`} onClick={() => setRevokeId(null)}>戻る</button></form>)}
        </div>
      </li>)}</ul>}
    </section>
  </AdminLiveShell>;
}
