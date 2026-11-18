"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { inputClass, secondaryButton, textLink } from "@/components/auth-demo-form";
import { MAX_PHOTO_BYTES, PHOTO_TYPES, preparePhoto } from "@/lib/photo-downscale";

const messages = {
  invalid: "JPEG、PNG、WebPの画像を選んでください。",
  too_large: "4MB以下の画像を選んでください。",
  too_many: "写真は6枚までです。",
  rate_limited: "しばらくしてから再度お試しください。",
  last_photo: "最後の1枚は削除できません。",
  unauthenticated: "ログインの有効期限が切れました。",
  unavailable: "現在保存できません。時間をおいて再度お試しください。",
};
type Failure = keyof typeof messages;
const uploadFailures: readonly Failure[] = ["invalid", "too_large", "too_many", "rate_limited", "unauthenticated", "unavailable"];

// SEC-007: POST /api/photos answers JSON { status }. Since SEC-015 a request without a session gets 401 JSON
// { status: "unauthenticated" }; the opaque-redirect branch stays as a fallback for a proxy redirect to /login.
async function uploadStatus(data: FormData): Promise<Failure | "ok"> {
  const response = await fetch("/api/photos", { method: "POST", body: data, redirect: "manual", cache: "no-store" });
  if (response.type === "opaqueredirect") return "unauthenticated";
  // FIX-004: Vercel answers an oversized body with its own plain-text 413 before the route runs.
  if (response.status === 413) return "too_large";
  const body: unknown = await response.json().catch(() => null);
  const status = body && typeof body === "object" && "status" in body ? body.status : undefined;
  if (status === "ok" && response.ok) return "ok";
  return uploadFailures.find((failure) => failure === status) ?? "unavailable";
}

export function PhotoManager({ initial, onChange, onPendingChange, disabled = false }: {
  initial: string[];
  onChange?: (ids: string[]) => void;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
}) {
  const [ids, setIds] = useState(initial);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const running = useRef(false);
  const inputId = useId();
  const busy = pending || disabled;

  function update(next: string[]) { setIds(next); onChange?.(next); }
  async function refresh() {
    // Registration fills the first vacant position, so appending the new id
    // locally can claim a different main photo from the persisted order.
    setNeedsRefresh(true);
    update([]);
    const { refreshOnboardingPhotos } = await import("@/server/onboarding-actions");
    const next = await refreshOnboardingPhotos();
    if (next === null) setFailure("unavailable");
    else {
      update(next);
      setNeedsRefresh(false);
      setFailure(null);
    }
  }
  async function run(operation: () => Promise<void>) {
    if (running.current || disabled) return;
    running.current = true;
    setPending(true); onPendingChange?.(true); setFailure(null);
    try { await operation(); } catch { setFailure("unavailable"); } finally {
      running.current = false;
      setPending(false); onPendingChange?.(false);
    }
  }
  function add(file: File | undefined) {
    if (!file || running.current || disabled || needsRefresh) return;
    const accepted = PHOTO_TYPES.includes(file.type);
    if (file.size > MAX_PHOTO_BYTES && !accepted) { setFailure("too_large"); return; }
    if (ids.length >= 6) { setFailure("too_many"); return; }
    if (!accepted) { setFailure("invalid"); return; }
    void run(async () => {
      // UI-014: shrinking runs inside the pending state; an image over 4 MiB that cannot be shrunk below it is too_large.
      const part = await preparePhoto(file);
      if (part.size > MAX_PHOTO_BYTES) { setFailure("too_large"); return; }
      const data = new FormData(); data.set("photo", part);
      const status = await uploadStatus(data);
      if (status === "ok") await refresh();
      else setFailure(status);
    });
  }
  function reorder(index: number, direction: number) {
    const next = [...ids];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    void run(async () => {
      const { reorderPhotos } = await import("@/server/photo-actions");
      const result = await reorderPhotos(next);
      if (result.status === "ok") update(next);
      else setFailure(result.status);
    });
  }
  return <section aria-label="登録する写真" aria-busy={busy} className="space-y-5">
    <div><label htmlFor={inputId}>写真を追加</label><input id={inputId} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || needsRefresh || ids.length >= 6} className={`${inputClass} min-h-11`} onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      add(file);
    }} /><p className="mt-2 text-[13px] text-muted">JPEG、PNG、WebP・4MB以下・6枚まで</p></div>
    {failure && <div role="alert" className="text-sm"><p>{messages[failure]}</p>{failure === "unauthenticated" && <Link href="/login?next=/onboarding" className={textLink}>ログインへ</Link>}</div>}
    {needsRefresh && <button type="button" disabled={busy} onClick={() => { void run(refresh); }} className={`${secondaryButton} min-h-11`}>写真を再読み込み</button>}
    <ol aria-label="登録した写真" className="space-y-5">{ids.map((id, index) => <li key={id} className="rounded-[20px] border border-line p-4">
      <img src={`/media/photos/${id}`} alt={`登録した写真 ${index + 1}`} width={160} height={200} className="aspect-[4/5] rounded-[12px] object-cover" />
      <p className="my-3 text-sm">{index === 0 ? "メイン" : `写真 ${index + 1}`}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || index === 0} onClick={() => reorder(index, -1)} className={`${secondaryButton} min-h-11 min-w-11`}>前へ</button>
        <button type="button" disabled={busy || index === ids.length - 1} onClick={() => reorder(index, 1)} className={`${secondaryButton} min-h-11 min-w-11`}>後へ</button>
        <button type="button" disabled={busy} onClick={() => { void run(async () => {
          const { removePhoto } = await import("@/server/photo-actions");
          const result = await removePhoto(id);
          if (result.status === "ok") update(ids.filter((value) => value !== id));
          else setFailure(result.status);
        }); }} className={`${secondaryButton} min-h-11 min-w-11`}>削除</button>
      </div>
    </li>)}</ol>
  </section>;
}
