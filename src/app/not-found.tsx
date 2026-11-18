import Link from "next/link";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { pageTitle, primaryButton } from "@/components/ui-tokens";

// Next's built-in 404 uses inline styles that violate the production nonce policy.
export default function NotFound() {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex min-h-screen w-full max-w-[560px] flex-col justify-center gap-6 px-4 py-16 sm:px-8">
      <h1 className={pageTitle}>ページが見つかりません</h1>
      <p className="text-muted">お探しのページは存在しないか、移動した可能性があります。</p>
      <Link href="/" className={`${primaryButton} self-start`}>
        Discoverへ戻る
      </Link>
    </main>
  );
}
