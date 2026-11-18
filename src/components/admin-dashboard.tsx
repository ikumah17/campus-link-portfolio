"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { textLink } from "@/components/auth-demo-form";
import { ADMIN_NOTICE } from "@/lib/admin-gateway";
import { useAdmin } from "@/lib/admin-demo";
import { createDemoSubmissions } from "@/data/demo-verifications";
import { noteBox, pageTitle } from "@/components/ui-tokens";

export function AdminShell({ children }: { children: ReactNode }) {
  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto min-h-screen w-full max-w-[840px] px-4 pb-16 pt-8 sm:px-8 sm:pt-16">
    <Link href="/admin" className={textLink}>管理画面へ戻る</Link>
    <p role="note" className={`my-5 ${noteBox}`}>{ADMIN_NOTICE} 再読み込みでリセットされます。</p>
    {children}
  </main>;
}
export function AdminDashboard() {
  const { demo } = useAdmin();
  const reports = demo.gateway.adminListReports(null).data ?? [];
  const cards = [
    { href: "/admin/verifications", label: "学生認証審査", count: createDemoSubmissions().filter((r) => r.status === "submitted" || r.status === "in_review").length, unit: "未完了" },
    { href: "/admin/reports", label: "通報", count: reports.filter((r) => r.available && (r.status === "open" || r.status === "triaged")).length, unit: "未完了" },
    { href: "/admin/affiliations", label: "学校・学科・クラス", count: demo.affiliations().filter((r) => r.isActive).length, unit: "有効（審査待ちはありません）" },
  ];
  return <AdminShell><Link href="/mypage" className={textLink}>マイページへ戻る</Link><h1 className={`mt-5 ${pageTitle}`}>管理画面のデモ</h1>
    <div className="mt-7 grid gap-4">{cards.map((card) => <Link key={card.href} href={card.href} className="block min-h-14 rounded-[24px] border border-line p-6"><span className="block text-lg">{card.label}</span><span className="mt-2 block text-sm text-muted">{card.unit}：{card.count}件</span></Link>)}</div>
  </AdminShell>;
}
