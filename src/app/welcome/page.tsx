"use client";

import Link from "next/link";
import { DemoShell, primaryButton, secondaryButton, textLink } from "@/components/auth-demo-form";

export default function WelcomePage() {
  return <DemoShell>
    <h1 className="text-[34px] font-medium leading-snug">学生生活に、<br />新しいつながりを。</h1>
    <p className="mt-4 text-[15px] text-muted">同じ学生どうしで、つながろう。</p>
    <div className="mt-12 flex flex-col gap-4">
      <Link href="/signup" className={primaryButton}>新規登録</Link>
      <Link href="/login" className={secondaryButton}>ログイン</Link>
      <Link href="/" className={`${textLink} justify-center`}>架空のプロフィールを見る</Link>
    </div>
  </DemoShell>;
}
