"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { MainNav } from "@/components/main-nav";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { BioField, PurposeFields } from "@/components/onboarding";
import { validateBio, validatePurposes, type Purpose } from "@/lib/onboarding-rules";
import type { ProfileEditStatus } from "@/server/profile-edit-actions";
import { noticeText, pageTitle, primaryButton, tabPage, textLink } from "@/components/ui-tokens";

export const PROFILE_EDIT_TEXT: Record<ProfileEditStatus, string> = {
  ok: "保存しました。", invalid: "入力内容を確認してください。", unauthenticated: "ログインし直してください。",
  unavailable: "現在保存できません。時間をおいて再度お試しください。",
};
export type ProfileEditInput = { bio: string; purposes: Purpose[] };
// The profile edit screen (docs/43 §4.5): only the bio and the purposes change here.
export function ProfileEditView({ initial, save, demo = false }: { initial: ProfileEditInput; save: (input: ProfileEditInput) => Promise<{ status: ProfileEditStatus }>; demo?: boolean }) {
  const [purposes, setPurposes] = useState(initial.purposes), [bio, setBio] = useState(initial.bio);
  const [error, setError] = useState<string | undefined>(), [status, setStatus] = useState(""), [busy, setBusy] = useState(false);
  const running = useRef(false), statusRef = useRef<HTMLParagraphElement>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current) return;
    if (!validateBio(bio)) { setError("自己紹介は500文字以内で入力してください。"); document.getElementById("bio")?.focus(); return; }
    if (!validatePurposes(purposes)) { setStatus(PROFILE_EDIT_TEXT.invalid); return; }
    setError(undefined); running.current = true; setBusy(true);
    let result: { status: ProfileEditStatus };
    try { result = await save({ bio, purposes }); } catch { result = { status: "unavailable" }; }
    setStatus(result.status === "ok" && demo ? "保存しました（デモ・どこにも保存されません）。" : PROFILE_EDIT_TEXT[result.status]);
    running.current = false; setBusy(false); statusRef.current?.focus();
  }
  return <div className="min-h-screen bg-white text-ink">
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className={tabPage}>
      <Link href="/mypage" className={textLink}>マイページへ戻る</Link>
      <h1 className={`mt-4 ${pageTitle}`}>プロフィールを編集</h1>
      {demo && <p className={noticeText}>デモ：変更は架空のもので、どこにも保存されません。</p>}
      <form noValidate autoComplete="off" onSubmit={submit} className="mt-8 space-y-7">
        <PurposeFields purposes={purposes} onChange={setPurposes} disabled={busy} />
        <BioField bio={bio} onChange={setBio} error={error} disabled={busy} />
        <button type="submit" disabled={busy} aria-busy={busy} className={`${primaryButton} w-full disabled:opacity-50`}>保存する</button>
      </form>
      <p role="status" ref={statusRef} tabIndex={-1} className="mt-5 min-h-6 text-sm leading-6">{status}</p>
    </main>
    <MainNav current="mypage" />
  </div>;
}
export function ProfileEdit() {
  return <ProfileEditView demo initial={{ bio: "", purposes: [] }} save={async () => ({ status: "ok" })} />;
}
