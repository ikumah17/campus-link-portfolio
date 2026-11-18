import Link from "next/link";
import { MAIN_CONTENT_ID } from "@/components/skip-link";

import { backendMode } from "@/lib/backend";
import { pageTitle, primaryButton } from "@/components/ui-tokens";

export default function NotFound() {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-6 bg-white px-4 text-center text-ink">
      <h1 className={pageTitle}>プロフィールが見つかりません</h1>
      <p className="text-[15px] text-muted">{backendMode() === "supabase" ? "このプロフィールは表示できません。" : "このデモに存在しないプロフィールです。"}</p>
      <Link href="/" className={primaryButton}>
        一覧へ戻る
      </Link>
    </main>
  );
}
