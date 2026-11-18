"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { PasswordToggle } from "@/components/password-toggle";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { inputClass, noteBox, pageTitle, primaryButton, standalonePage, textLink } from "@/components/ui-tokens";

export { inputClass, primaryButton, secondaryButton, textLink } from "@/components/ui-tokens";
export const demoNotice = "デモ：実際のアカウント作成・ログイン・本人確認は行われません。入力内容は保存されません。架空の情報でお試しください。";

export function DemoShell({ children, notice = true }: { children: ReactNode; notice?: boolean }) {
  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}>
    <p className="font-brand text-[28px]">Campus Link</p>
    {notice && <p role="note" className={`mb-8 mt-4 ${noteBox}`}>{demoNotice}</p>}
    {children}
  </main>;
}

export function AuthDemoForm({ kind }: { kind: "signup" | "login" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordShown, setPasswordShown] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [status, setStatus] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const signup = kind === "signup";
  function submit(event: FormEvent) {
    event.preventDefault();
    const next = {
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? undefined : "メールアドレスの形式を確認してください。",
      password: [...password].length >= 8 && [...password].length <= 72 ? undefined : "パスワードは8〜72文字で入力してください。",
    };
    setErrors(next);
    setStatus("");
    if (next.email) return emailRef.current?.focus();
    if (next.password) return passwordRef.current?.focus();
    setPassword("");
    if (signup) router.push("/onboarding");
    else setStatus("デモのためログインは行われません");
  }
  return <DemoShell>
    <h1 className={pageTitle}>{signup ? "新規登録" : "ログイン"}</h1>
    <p className="mt-3 text-[14px] text-muted">18歳以上の対象校の学生のみ</p>
    <form noValidate autoComplete="off" onSubmit={submit} className="mt-8 space-y-6">
      <div><label htmlFor="demo-email">メールアドレス</label>
        <input ref={emailRef} id="demo-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!errors.email} aria-describedby={errors.email ? "email-error" : undefined} className={inputClass} />
        {errors.email && <p id="email-error" className="mt-2 text-sm">{errors.email}</p>}
      </div>
      <div><label htmlFor="demo-password">パスワード</label>
        <input ref={passwordRef} id="demo-password" type={passwordShown ? "text" : "password"} autoComplete={signup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!errors.password} aria-describedby="password-hint password-error" className={inputClass} />
        <PasswordToggle shown={passwordShown} onToggle={() => setPasswordShown((shown) => !shown)} controls="demo-password" />
        <p id="password-hint" className="mt-2 text-[13px] text-muted">デモ用の8〜72文字を入力してください。</p>
        <p id="password-error" className="mt-2 text-sm">{errors.password}</p>
      </div>
      <button className={`${primaryButton} w-full`} type="submit">{signup ? "入力デモを始める" : "ログインを試す"}</button>
      <p role="status" className="text-sm">{status}</p>
    </form>
    {signup && <p className="mt-6 text-sm leading-7">登録すると、<Link href="/terms" prefetch={false} className={textLink}>利用規約</Link>と<Link href="/privacy" prefetch={false} className={textLink}>プライバシーポリシー</Link>に同意したものとみなします。</p>}
    <div className="mt-6 flex flex-col items-start gap-2">
      <Link href={signup ? "/login" : "/signup"} className={textLink}>{signup ? "ログイン" : "新規登録"}</Link>
      <Link href="/welcome" className={textLink}>ウェルカムへ戻る</Link>
    </div>
  </DemoShell>;
}
