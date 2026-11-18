"use client";

import Link from "next/link";
import { useActionState, useRef, useState, type FormEvent } from "react";
import { inputClass, primaryButton, textLink } from "@/components/auth-demo-form";
import { PasswordToggle } from "@/components/password-toggle";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { authMessages, passwordHint, validateAuthInput, type AuthFormState } from "@/lib/auth-validation";
import { safeNextPath } from "@/lib/safe-next";
import { signInAction, signUpAction } from "@/server/auth-actions";
import { pageTitle, standalonePage } from "@/components/ui-tokens";

export function AuthForm({ kind, next, confirmError = false, signoutError = false }: { kind: "signup" | "login"; next?: string; confirmError?: boolean; signoutError?: boolean }) {
  const signup = kind === "signup";
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [localState, setLocalState] = useState<AuthFormState | null>(null);
  const [passwordShown, setPasswordShown] = useState(false);
  const [state, action, pending] = useActionState<AuthFormState, FormData>(async (prev, data) => {
    // React already captured FormData; don't retain the password in the DOM or React state.
    if (passwordRef.current) passwordRef.current.value = "";
    return (signup ? signUpAction : signInAction)(prev, data);
  }, { status: "idle" });
  const current = localState ?? state;
  const errors = current.fieldErrors ?? {};
  const destination = safeNextPath(next);

  function validate(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const input = validateAuthInput(data.get("email"), data.get("password"), signup ? "signup" : "signin");
    setLocalState(null);
    if (!input.valid) {
      event.preventDefault();
      setLocalState({ status: "invalid", fieldErrors: input.fieldErrors });
      if (passwordRef.current) passwordRef.current.value = "";
      (input.fieldErrors.email ? emailRef : passwordRef).current?.focus();
    }
  }

  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}>
    <p className="mb-8 font-brand text-[28px]">Campus Link</p>
    <h1 className={pageTitle}>{signup ? "新規登録" : "ログイン"}</h1>
    <p className="mt-3 text-[14px] text-muted">18歳以上の対象校の学生のみ</p>
    {confirmError && <p role="alert" className="mt-4 text-sm">{authMessages.confirmError}</p>}
    {signoutError && <p role="alert" className="mt-4 text-sm">{authMessages.signoutError}</p>}
    <form noValidate action={action} onSubmit={validate} className="mt-8 space-y-6">
      {!signup && destination && <input type="hidden" name="next" value={destination} />}
      <div><label htmlFor="auth-email">メールアドレス</label>
        <input ref={emailRef} id="auth-email" name="email" type="email" autoComplete="email" aria-invalid={!!errors.email} aria-describedby={errors.email ? "auth-email-error" : undefined} className={inputClass} />
        {errors.email && <p id="auth-email-error" className="mt-2 text-sm">{errors.email}</p>}
      </div>
      <div><label htmlFor="auth-password">パスワード</label>
        <input ref={passwordRef} id="auth-password" name="password" type={passwordShown ? "text" : "password"} autoComplete={signup ? "new-password" : "current-password"} aria-invalid={!!errors.password} aria-describedby={signup ? "auth-password-hint auth-password-error" : "auth-password-error"} className={inputClass} />
        <PasswordToggle shown={passwordShown} onToggle={() => setPasswordShown((shown) => !shown)} controls="auth-password" />
        {/* FIX-005: the rule applies to new passwords only; sign-in accepts an account's older password. */}
        {signup && <p id="auth-password-hint" className="mt-2 text-[13px] text-muted">{passwordHint}</p>}
        <p id="auth-password-error" className="mt-2 text-sm">{errors.password}</p>
      </div>
      <button className={`${primaryButton} w-full`} type="submit" disabled={pending}>{signup ? "新規登録" : "ログイン"}</button>
      <p role={current.status === "idle" || current.status === "sent" ? "status" : "alert"} className="text-sm">{authMessages[current.status]}</p>
    </form>
    {signup && <p className="mt-6 text-sm leading-7">登録すると、<Link href="/terms" prefetch={false} className={textLink}>利用規約</Link>と<Link href="/privacy" prefetch={false} className={textLink}>プライバシーポリシー</Link>に同意したものとみなします。</p>}
    <div className="mt-6 flex flex-col items-start gap-2">
      <Link href={signup ? "/login" : "/signup"} className={textLink}>{signup ? "ログイン" : "新規登録"}</Link>
      <Link href="/welcome" className={textLink}>ウェルカムへ戻る</Link>
    </div>
  </main>;
}
