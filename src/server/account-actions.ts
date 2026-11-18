"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { callRpc } from "@/server/rpc";
import { DELETE_CONFIRMATION, type AccountActionStatus } from "@/server/account-rules";

const known: AccountActionStatus[] = ["ok", "invalid_state", "forbidden", "unauthenticated"];
const clean = (code: string): { status: AccountActionStatus } => ({ status: (known as string[]).includes(code) ? code as AccountActionStatus : "unavailable" });

async function toggle(name: "deactivate_account" | "reactivate_account") {
  try {
    if (backendMode() !== "supabase") return clean("unavailable");
    const result = clean((await callRpc(await createServerSupabase(), name)).code);
    if (result.status === "ok") for (const path of ["/settings/account", "/mypage"]) revalidatePath(path);
    return result;
  } catch { return clean("unavailable"); }
}
export async function pauseAccount() { return toggle("deactivate_account"); }
export async function resumeAccount() { return toggle("reactivate_account"); }

// Only the own session's request_account_deletion runs here; the retention job removes the Auth user later.
export async function deleteAccount(confirmation: unknown): Promise<{ status: AccountActionStatus }> {
  if (confirmation !== DELETE_CONFIRMATION) return { status: "invalid" };
  if (backendMode() !== "supabase") return clean("unavailable");
  let client;
  try {
    client = await createServerSupabase();
    const result = clean((await callRpc(client, "request_account_deletion")).code);
    if (result.status !== "ok") return result;
  } catch { return clean("unavailable"); }
  try {
    // Global scope revokes every refresh token; auth-js clears this request's cookies even when the call fails.
    await client.auth.signOut({ scope: "global" });
  } catch {
    // The account is already deleted; the gates refuse it on any remaining session.
  }
  redirect("/settings/account/deleted");
}
