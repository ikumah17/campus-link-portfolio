import "server-only";

import { callRpc, type RpcClient } from "@/server/rpc";

export async function profileGate(client: RpcClient): Promise<"completed" | "incomplete" | "unauthenticated" | "unavailable"> {
  try {
    const account = await callRpc(client, "my_account");
    if (account.code === "unauthenticated") return "unauthenticated";
    if (account.code !== "ok" || !Array.isArray(account.data) || account.data.length !== 1) return "unavailable";
    const row: unknown = account.data[0];
    if (!row || typeof row !== "object" || !("profile_completed" in row)) return "unavailable";
    // A deleted account keeps its Auth user until retention; no app page may serve it.
    if ("account_status" in row && row.account_status === "deleted") return "unavailable";
    if (row.profile_completed === true) return "completed";
    if (row.profile_completed === false) return "incomplete";
  } catch {
    // Never forward account values or provider errors to the page.
  }
  return "unavailable";
}
