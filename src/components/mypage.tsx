import Link from "next/link";
import type { ReactNode } from "react";
import { MainNav } from "@/components/main-nav";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { pageTitle, tabPage } from "@/components/ui-tokens";

function ChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9.5 5 7 7-7 7" />
    </svg>
  );
}

// Minimal settings entry for a fictional account. No login or verification exists; the profile edit is a demo too.
export function MyPage({ footer }: { footer?: ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-ink">
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className={tabPage}>
        <h1 className={pageTitle}>マイページ</h1>
        <p className="mt-2 text-[15px] text-muted">架空アカウントの設定デモ</p>

        <section aria-labelledby="mypage-settings" className="mt-8 rounded-[24px] bg-surface p-2">
          <h2 id="mypage-settings" className="px-4 pb-2 pt-3 text-[15px] font-medium text-ink">
            設定
          </h2>
          <Link href="/mypage/profile" className="mb-2 flex min-h-14 items-center justify-between rounded-[18px] bg-white px-4 py-3 text-[16px]">
            <span>プロフィールを編集</span><ChevronIcon />
          </Link>
          <Link
            href={"/settings/privacy"}
            className="flex min-h-14 items-center justify-between gap-4 rounded-[18px] bg-white px-4 py-3 text-[16px] text-ink transition-colors hover:bg-white/70"
          >
            <span className="flex flex-col">
              <span>公開範囲設定</span>
              <span className="text-[13px] text-muted">デモ・この端末内のみ</span>
            </span>
            <ChevronIcon />
          </Link>
          <Link href={"/settings/blocks"} className="mt-2 flex min-h-14 items-center justify-between rounded-[18px] bg-white px-4 py-3 text-[16px]">
            <span>ブロック中のユーザー</span><ChevronIcon />
          </Link>
          <Link href={"/settings/account"} className="mt-2 flex min-h-14 items-center justify-between rounded-[18px] bg-white px-4 py-3 text-[16px]">
            <span>アカウント</span><ChevronIcon />
          </Link>
          <Link href="/welcome" className="mt-2 flex min-h-14 items-center justify-between rounded-[18px] bg-white px-4 py-3 text-[16px]">
            <span>登録画面のデモ</span><ChevronIcon />
          </Link>
          <Link href="/verification" className="mt-2 flex min-h-14 items-center justify-between rounded-[18px] bg-white px-4 py-3 text-[16px]">
            <span>在学・年齢確認（デモ）</span><ChevronIcon />
          </Link>
          <Link href="/admin" className="mt-2 flex min-h-14 items-center justify-between rounded-[18px] bg-white px-4 py-3 text-[16px]">
            <span>管理画面のデモ</span><ChevronIcon />
          </Link>
        <Link href="/terms" prefetch={false} className="mt-2 flex min-h-14 items-center rounded-[18px] bg-white px-4 py-3 text-[16px]">利用規約</Link>
        <Link href="/privacy" prefetch={false} className="mt-2 flex min-h-14 items-center rounded-[18px] bg-white px-4 py-3 text-[16px]">プライバシーポリシー</Link>
        </section>
        {footer}
      </main>

      <MainNav current="mypage" />
    </div>
  );
}
