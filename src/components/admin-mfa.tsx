"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { startTotpEnrollment, verifyTotp } from "@/server/mfa-actions";
import { pageTitle, standalonePage } from "@/components/ui-tokens";

const messages = {
  invalid_code: "コードが正しくありません。もう一度入力してください。",
  rate_limited: "試行回数が上限に達しました。しばらくしてからお試しください。",
  unauthenticated: "ログインの有効期限が切れました。",
  unavailable: "現在確認できません。時間をおいて再度お試しください。",
};
const buttonClass = "inline-flex min-h-12 items-center justify-center rounded-full bg-ink px-6 py-3 text-[15px] font-medium text-white disabled:opacity-50";

export function AdminMfa({ mode, next }: { mode: "challenge" | "enroll"; next: string }) {
  const [challenge, setChallenge] = useState(mode === "challenge");
  const [enrollment, setEnrollment] = useState<{ qrCode: string; secret: string } | null>(null);
  const [message, setMessage] = useState<keyof typeof messages | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const codeRef = useRef<HTMLInputElement>(null);

  async function run(action: "enroll" | "verify") {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setMessage(null);
    try {
      if (action === "enroll") {
        const result = await startTotpEnrollment();
        if (result.status === "enroll") setEnrollment({ qrCode: result.qrCode, secret: result.secret });
        else if (result.status === "already_enrolled") { setEnrollment(null); setChallenge(true); }
        else setMessage(result.status);
      } else {
        const code = codeRef.current?.value;
        if (codeRef.current) codeRef.current.value = "";
        const result = await verifyTotp(code);
        if (result.status === "ok") {
          setEnrollment(null);
          window.location.assign(next);
        } else setMessage(result.status);
      }
    } catch {
      setMessage("unavailable");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void run("verify"); }

  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}>
    <p className="mb-8 font-brand text-[28px]">Campus Link</p>
    <h1 className={pageTitle}>二段階認証</h1>
    <div aria-busy={pending} className="mt-8 space-y-6">
      {!challenge && !enrollment && <button type="button" disabled={pending} onClick={() => void run("enroll")} className={buttonClass}>認証アプリを設定する</button>}
      {enrollment && <div className="space-y-4">
        <img src={enrollment.qrCode} alt="認証アプリに読み取らせるQRコード" width={200} height={200} />
        <dl><dt>手入力用のキー</dt><dd className="mt-2 break-all font-mono" aria-label="手入力用のキー">{enrollment.secret}</dd></dl>
        <p className="text-sm leading-6">認証アプリでQRコードを読み取り、6桁のコードを入力してください。</p>
      </div>}
      {(challenge || enrollment) && <form onSubmit={submit} className="space-y-6" aria-busy={pending}>
        <div><label htmlFor="admin-totp-code">6桁のコード</label>
          <input ref={codeRef} id="admin-totp-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={pending} className="mt-2 min-h-12 w-full min-w-0 rounded-[16px] border border-line bg-white px-4 py-3 text-[16px]" />
        </div>
        <button type="submit" disabled={pending} className={`${buttonClass} w-full`}>確認</button>
      </form>}
      {message && <div role="alert" className="text-sm">
        <p>{messages[message]}</p>
        {message === "unauthenticated" && <Link href="/login?next=/admin/mfa" className="inline-flex min-h-11 min-w-11 items-center py-2 underline underline-offset-4">ログイン</Link>}
      </div>}
    </div>
  </main>;
}
