import Link from "next/link";
import type { ReactNode } from "react";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import type { StaffRole } from "@/server/admin-gate";
import { pageTitle, textLink } from "@/components/ui-tokens";

export function AdminLiveShell({ children }: { children: ReactNode }) {
  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto min-h-screen w-full max-w-[840px] px-4 pb-16 pt-8 sm:px-8 sm:pt-16">
    <Link href="/admin" prefetch={false} className={textLink}>管理画面へ戻る</Link>
    {children}
  </main>;
}

// Each entry needs the role its page's RPCs require (private.require_staff matches one role exactly).
const entries = [
  { href: "/admin/verifications", label: "学生認証審査", role: "reviewer" },
  { href: "/admin/reports", label: "通報", role: "moderator" },
  { href: "/admin/affiliations", label: "学校・学科・クラス", role: "admin" },
  { href: "/admin/staff", label: "担当者と役割", role: "admin" },
  { href: "/admin/accounts", label: "停止中のアカウント", role: "admin" },
] as const;

export function AdminLiveDashboard({ roles }: { roles: readonly StaffRole[] }) {
  return <AdminLiveShell>
    <h1 className={`mt-5 ${pageTitle}`}>管理画面</h1>
    <div className="mt-7 grid gap-4">
      {entries.filter((entry) => roles.includes(entry.role)).map((entry) =>
        <Link key={entry.href} href={entry.href} prefetch={false} className="block min-h-14 rounded-[24px] border border-line p-6 text-lg">{entry.label}</Link>)}
    </div>
  </AdminLiveShell>;
}

export function AdminUnavailable() {
  return <AdminLiveShell>
    <h1 className={`mt-5 ${pageTitle}`}>管理画面</h1>
    <p role="alert" className="mt-7">現在表示できません。時間をおいて再度お試しください。</p>
  </AdminLiveShell>;
}
