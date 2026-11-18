import Link from "next/link";
import { MainNav } from "@/components/main-nav";
import { LogoutButton, LogoutEverywhereButton } from "@/components/logout-button";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import type { MyPageData } from "@/server/mypage-data";
import { pageTitle, tabPage, textLink } from "@/components/ui-tokens";

const affiliationLabels = { confirmed: "確認済み", pending: "審査中", rejected: "確認できませんでした", unconfirmed: "未確認", expired: "期限切れ" };
export function MyPageLive({ page }: { page: MyPageData }) {
  return <div className="min-h-screen bg-white text-ink">
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className={tabPage}>
      <h1 className={pageTitle}>マイページ</h1>
      <p className="mt-2 text-[15px] text-muted">{page.name}</p>
      {page.accountStatus === "suspended" && <p className="mt-4">このアカウントは停止されています。</p>}
      {page.accountStatus === "deactivated" && <p className="mt-4">アカウントは休止中です。 <Link href={"/settings/account"} className={textLink}>再開する</Link></p>}
      <section aria-labelledby="mypage-status" className="mt-8 rounded-[24px] bg-surface p-6">
        <h2 id="mypage-status" className="text-[15px] font-medium">確認状況</h2>
        <dl className="mt-4 grid grid-cols-2 gap-3"><dt>年齢確認</dt><dd>{page.ageVerified ? "確認済み" : "未確認"}</dd><dt>在学確認</dt><dd>{affiliationLabels[page.affiliation]}</dd></dl>
        {!page.eligible && page.accountStatus !== "deactivated" && <p className="mt-4 text-[15px]">確認が済むと、探す・いいね・トークを利用できます。 <Link href="/verification" className={textLink}>在学・年齢確認へ</Link></p>}
      </section>
      <section aria-labelledby="mypage-settings" className="mt-8 rounded-[24px] bg-surface p-2">
        <h2 id="mypage-settings" className="px-4 pb-2 pt-3 text-[15px] font-medium">設定</h2>
        {[["プロフィールを編集", "/mypage/profile"], ["公開範囲設定", "/settings/privacy"], ["ブロック中のユーザー", "/settings/blocks"], ["アカウント", "/settings/account"], ["在学・年齢確認", "/verification"]].map(([label, href]) => <Link key={href} href={href} className="mt-2 flex min-h-14 items-center justify-between rounded-[18px] bg-white px-4 py-3 text-[16px]">
          <span>{label}</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9.5 5 7 7-7 7" /></svg>
        </Link>)}
      <Link href="/terms" prefetch={false} className="mt-2 flex min-h-14 items-center rounded-[18px] bg-white px-4 py-3 text-[16px]">利用規約</Link>
        <Link href="/privacy" prefetch={false} className="mt-2 flex min-h-14 items-center rounded-[18px] bg-white px-4 py-3 text-[16px]">プライバシーポリシー</Link>
        </section>
      <LogoutButton />
      <LogoutEverywhereButton />
    </main>
    <MainNav current="mypage" />
  </div>;
}
