"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode, type FormEvent } from "react";
import { primaryButton, secondaryButton, textLink } from "@/components/auth-demo-form";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { kindLabels, statusLabels, sampleRefs, sampleLabel, submit, withdraw, type VerificationKind, type VerificationState } from "@/lib/verification-demo";
import { noteBox, pageTitle } from "@/components/ui-tokens";

export function VerificationShell({ children }: { children: ReactNode }) {
  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto min-h-screen w-full max-w-[720px] px-4 pb-16 pt-8 sm:px-8 sm:pt-16">
    <Link href="/mypage" className={textLink}>マイページへ戻る</Link>
    <p role="note" className={`mb-8 mt-4 ${noteBox}`}>デモ：実際の資料は扱いません。架空のサンプルだけを選べます。審査結果はどこにも保存されません。再読み込みでリセットされます。</p>
    {children}
  </main>;
}
export function Verification() {
  const [state, setState] = useState<VerificationState>([]);
  const [status, setStatus] = useState("");
  return <VerificationShell>
    <h1 className={pageTitle}>在学・年齢確認</h1>
    <p className="mt-3 text-sm leading-6 text-muted">在学確認の対象は登録した学校・学科・クラスです（デモ）。</p>
    <p role="status" className="my-5 min-h-6 text-sm">{status}</p>
    <div className="space-y-6">{(["age", "enrollment"] as const).map((kind) => <VerificationCard key={kind} kind={kind} state={state} onResult={(next, message) => { setState(next); setStatus(message); }} />)}</div>
  </VerificationShell>;
}
function VerificationCard({ kind, state, onResult }: { kind: VerificationKind; state: VerificationState; onResult: (state: VerificationState, message: string) => void }) {
  const [refs, setRefs] = useState<string[]>([]);
  const [error, setError] = useState("");
  const firstSample = useRef<HTMLButtonElement>(null);
  const current = state.filter((s) => s.kind === kind).at(-1);
  const unfinished = current?.status === "submitted" || current?.status === "in_review";
  function send(event: FormEvent) {
    event.preventDefault();
    const result = submit(state, kind, refs);
    if (result.code !== "ok") {
      setError(result.code === "validation" ? "架空のサンプル資料を1〜3点選んでください。" : "未完了の提出があります。");
      firstSample.current?.focus(); return;
    }
    setError(""); onResult(result.state, `${kindLabels[kind]}を提出しました（デモ）。`);
  }
  return <section aria-labelledby={`${kind}-title`} className="rounded-[24px] border border-line p-5 sm:p-7">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id={`${kind}-title`} className="text-xl font-medium">{kindLabels[kind]}</h2><p className="rounded-full bg-surface px-4 py-2 text-sm">{current ? statusLabels[current.status] : "未提出"}</p></div>
    <form onSubmit={send} className="mt-5 space-y-4">
      <fieldset><legend className="text-sm">架空の資料を選択</legend><div className="mt-3 flex flex-col gap-3">{sampleRefs.map((ref, i) => <button ref={i === 0 ? firstSample : undefined} key={ref} type="button" aria-pressed={refs.includes(ref)} aria-invalid={!!error} aria-describedby={error ? `${kind}-error` : undefined} onClick={() => { setRefs((prev) => prev.includes(ref) ? prev.filter((r) => r !== ref) : [...prev, ref]); setError(""); }} className={`${secondaryButton} ${refs.includes(ref) ? "border-ink bg-surface" : ""}`}>{sampleLabel(ref)}</button>)}</div></fieldset>
      {error && <p id={`${kind}-error`} className="text-sm">{error}</p>}
      <div className="flex flex-wrap gap-3"><button type="submit" disabled={unfinished} className={`${primaryButton} disabled:opacity-40`}>提出（デモ）</button>
        {current?.status === "submitted" && <button type="button" className={secondaryButton} onClick={() => { const result = withdraw(state, current.id); if (result.code === "ok") { setError(""); onResult(result.state, `${kindLabels[kind]}を取り下げました（デモ）。`); firstSample.current?.focus(); } }}>取り下げ</button>}
      </div>
      {unfinished && <p className="text-sm text-muted">未完了の提出があるため、再提出できません。</p>}
    </form>
  </section>;
}
