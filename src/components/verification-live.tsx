"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { primaryButton, secondaryButton, textLink } from "@/components/auth-demo-form";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { reasonLabel } from "@/lib/verification-reasons";
import { submitVerification, withdrawVerification, type VerificationResult } from "@/server/verification-actions";
import type { VerificationState } from "@/server/verification-data";
import { pageTitle } from "@/components/ui-tokens";
const kinds = { age: "年齢確認", enrollment: "在学確認" };
const labels = { submitted: "提出済み", in_review: "審査中", approved: "承認", rejected: "却下", withdrawn: "取り下げ", revoked: "取消し", superseded: "無効" };
const samples = ["synthetic:sample-1", "synthetic:sample-2", "synthetic:sample-3"];
const errors = { invalid: "架空のサンプル資料を1〜3点選んでください。", invalid_state: "状態が変わりました。画面を確認してください。", unauthenticated: "ログインの有効期限が切れました。", unavailable: "現在保存できません。時間をおいて再度お試しください。" };
function expiry(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" }).format(new Date(value)) + "まで";
}
export function VerificationLive({ state }: { state: VerificationState }) {
  const router = useRouter();
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [refs, setRefs] = useState<Record<"age" | "enrollment", string[]>>({ age: [], enrollment: [] });
  const [message, setMessage] = useState("");
  const [error, setError] = useState<Exclude<VerificationResult["status"], "ok"> | null>(null);
  async function act(kind: "age" | "enrollment", id?: string) {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(null); setMessage("");
    try {
      const r = id ? await withdrawVerification(id) : await submitVerification(kind, refs[kind]);
      if (r.status === "ok") { setMessage(`${kinds[kind]}を${id ? "取り下げました" : "提出しました"}。`); router.refresh(); }
      else { setError(r.status); if (r.status === "invalid_state") router.refresh(); }
    } catch { setError("unavailable"); }
    finally { lock.current = false; setPending(false); }
  }
  return <main id={MAIN_CONTENT_ID} tabIndex={-1} aria-busy={pending} className="mx-auto min-h-screen w-full max-w-[720px] px-4 pb-16 pt-8 sm:px-8 sm:pt-16">
    <Link href="/mypage" className={textLink}>マイページへ戻る</Link>
    <p role="note" className="mb-8 mt-4 rounded-[20px] bg-surface p-4 text-[13px] leading-6 text-muted">開発中のため、実際の資料は扱いません。架空のサンプルだけを選べます。</p>
    <h1 className={pageTitle}>在学・年齢確認</h1>
    <p role="status" className="my-5 min-h-6 text-sm">{message}</p>
    {error && <p role="alert">{errors[error]}{error === "unauthenticated" && <Link href="/login?next=/verification" className={textLink}>ログイン</Link>}</p>}
    {!state.account.has_profile ? <p>先にプロフィールを作成してください。<Link href="/onboarding" className={textLink}>プロフィールを作成</Link></p> :
      <div className="space-y-6">{(["age", "enrollment"] as const).map(kind => {
        const row = state[kind];
        const unfinished = row?.status === "submitted" || row?.status === "in_review";
        const verified = kind === "age" ? state.account.age_verified : state.account.affiliation_confirmed;
        const missing = kind === "enrollment" && state.account.affiliation_status === null;
        return <section key={kind} aria-labelledby={`${kind}-title`} className="rounded-[24px] border border-line p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 id={`${kind}-title`} className="text-xl font-medium">{kinds[kind]}</h2><p className="rounded-full bg-surface px-4 py-2 text-sm">{row ? labels[row.status] : "未提出"}</p></div>
          {missing ? <p>先に所属を登録してください。<Link href="/onboarding" className={textLink}>所属を登録</Link></p> : <>
            {verified && <p>確認済みです。{kind === "enrollment" && row?.status === "approved" && expiry(row.valid_until)}</p>}
            {row && ["rejected", "revoked", "superseded"].includes(row.status) && <p>{reasonLabel(row.decision_reason)}</p>}
            {!(kind === "age" && verified) && <form className="mt-5 space-y-4" onSubmit={e => { e.preventDefault(); void act(kind); }}>
              <fieldset disabled={pending}><legend className="text-sm">架空の資料を選択</legend><div className="mt-3 flex flex-col gap-3">{samples.map((ref, i) => <button type="button" key={ref} aria-pressed={refs[kind].includes(ref)} className={`${secondaryButton} ${refs[kind].includes(ref) ? "border-ink bg-surface" : ""}`} onClick={() => setRefs(prev => ({ ...prev, [kind]: prev[kind].includes(ref) ? prev[kind].filter(r => r !== ref) : [...prev[kind], ref] }))}>架空のサンプル資料{i + 1}</button>)}</div></fieldset>
              <div className="flex flex-wrap gap-3"><button disabled={pending || unfinished} className={`${primaryButton} disabled:opacity-40`}>提出</button>{row?.status === "submitted" && <button type="button" disabled={pending} className={secondaryButton} onClick={() => void act(kind, row.id)}>取り下げ</button>}</div>
              {row?.status === "in_review" && <p>審査中のため、取り下げできません。</p>}
            </form>}
          </>}
        </section>;
      })}</div>}
  </main>;
}
