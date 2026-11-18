import { messagePage, resolveConversations } from "./chat-data";
import { callRpc, isUuid, type RpcClient } from "./rpc";
import { reportReasons } from "./shared";

// MOBILE-003 (docs/42 §2 #10–#11): the block and report entry points of the web's src/server/safety-actions.ts, at the
// places the web has them (profile, conversation, message; the request context is gone since order 34, docs/43 §2.8). The database checks the relationship and that a
// reported message came from the counterpart; a counterpart id never reaches the screen or a log. The block list and
// unblocking come in M4.
export type SafetyStatus = "ok" | "validation" | "not_available" | "rate_limited" | "unauthenticated" | "unavailable";
export type ReportKind = "profile" | "conversation" | "message";
const clean = (code: string): SafetyStatus => (["ok", "validation", "not_available", "rate_limited", "unauthenticated"].includes(code) ? code : "unavailable") as SafetyStatus;

async function run(action: () => Promise<SafetyStatus>): Promise<SafetyStatus> {
  try { return await action(); } catch { return "unavailable"; }
}
async function counterpart(client: RpcClient, id: string): Promise<{ status: "ok"; target?: string } | { status: "unauthenticated" | "unavailable" }> {
  const r = await resolveConversations(client);
  return r.status === "ok" ? { status: "ok", target: r.rows.find((v) => v.conversation.id === id)?.counterpart } : r;
}

export function blockProfile(client: RpcClient, target: unknown): Promise<SafetyStatus> {
  if (!isUuid(target)) return Promise.resolve("validation");
  return run(async () => clean((await callRpc(client, "block_user", { p_target: target })).code));
}

export function blockConversation(client: RpcClient, id: unknown): Promise<SafetyStatus> {
  if (!isUuid(id)) return Promise.resolve("validation");
  return run(async () => {
    const r = await counterpart(client, id);
    if (r.status !== "ok") return r.status;
    if (!r.target) return "not_available";
    return clean((await callRpc(client, "block_user", { p_target: r.target })).code);
  });
}

const validReport = (reason: unknown, detail: unknown): detail is string =>
  typeof reason === "string" && Object.hasOwn(reportReasons, reason) && typeof detail === "string" && [...detail.trim()].length <= 1000;

export function report(client: RpcClient, kind: ReportKind, id: unknown, reason: unknown, detail: unknown, messageId?: unknown): Promise<SafetyStatus> {
  if (!isUuid(id) || !validReport(reason, detail) || (kind === "message" && (!Number.isSafeInteger(messageId) || (messageId as number) <= 0))) return Promise.resolve("validation");
  return run(async () => {
    let target = id;
    if (kind === "conversation" || kind === "message") {
      const r = await counterpart(client, id);
      if (r.status !== "ok") return r.status;
      if (!r.target) return "not_available";
      target = r.target;
    }
    if (kind === "message") {
      // list_messages scopes the lookup to the accessible conversation; the exclusive upper bound includes the id.
      const page = await messagePage(client, id, target, (messageId as number) + 1);
      if (page.status !== "ok") return page.status;
      if (!page.messages.some((message) => message.id === messageId && !message.mine)) return "not_available";
    }
    return clean((await callRpc(client, "submit_report", {
      p_target: target, p_context: kind === "conversation" ? "profile" : kind, p_reason: reason, p_detail: detail.trim() || null,
      p_request_id: null, p_message_id: kind === "message" ? messageId : null,
    })).code);
  });
}
