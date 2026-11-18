import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NotMyAccountButton } from "@/components/logout-button";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { pageTitle, primaryButton, standalonePage } from "@/components/ui-tokens";
import { backendMode } from "@/lib/backend";
import { safeNextPath } from "@/lib/safe-next";
import { createServerSupabase } from "@/lib/supabase/server";
import { callerAccount } from "@/server/admin-gate";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ログインの確認 | Campus Link" };

// SEC-005 L-2: a confirmation link signs in whoever opens it, so the link's account is shown before the app opens.
// Public in the proxy like /auth/confirm: without a usable session this page shows nothing and sends the visitor to /login.
async function signedInEmail(): Promise<string | undefined> {
  try {
    const client = await createServerSupabase();
    const { data, error } = await client.auth.getUser();
    const user = data?.user;
    if (error || !user || user.is_anonymous || typeof user.email !== "string" || !user.email) return undefined;
    // A deleted or unreadable account sees nothing, as the confirmation route refuses it.
    return await callerAccount(client) === "usable" ? user.email : undefined;
  } catch {
    return undefined;
  }
}

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  if (backendMode() === "demo") notFound();
  const email = await signedInEmail();
  if (!email) redirect("/login");
  const params = await searchParams;
  const next = (typeof params.next === "string" ? safeNextPath(params.next) : undefined) ?? "/onboarding";
  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className={standalonePage}>
    <p className="mb-8 font-brand text-[28px]">Campus Link</p>
    <h1 className={pageTitle}>このアカウントでログインしました</h1>
    <p className="mt-3 break-all text-[15px]">{email}</p>
    <div className="mt-8 flex flex-col gap-3">
      <Link href={next} prefetch={false} className={`${primaryButton} w-full`}>続ける</Link>
      <NotMyAccountButton />
    </div>
  </main>;
}
