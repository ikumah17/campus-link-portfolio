import { gate, type Gated } from "./discover-data";
import { callRpc, isUuid, type RpcClient } from "./rpc";
import { validateBody } from "./shared";

// MOBILE-003 (docs/42 §2 #9): ports of the web's src/server/chat-data.ts and chat-actions.ts. Every room operation
// first finds the conversation in list_my_conversations, as the web's actions do, so a block or an ended connection
// turns the room into not_available. A message a moderator hid (MOD-001) arrives with its body already replaced.
export const PAGE_SIZE = 30;
export type LiveConversation = { id: string; partner: { name: string; photoId: string | null }; latest: { body: string; at: string; mine: boolean } | null; unread: boolean };
export type LiveMessage = { id: number; mine: boolean; body: string; createdAt: string; hidden: boolean };
export type MessagePage = { status: "ok"; messages: LiveMessage[]; hasOlder: boolean };
type Failure = { status: "unauthenticated" | "unavailable" };
export type ChatStatus = "validation" | "unavailable" | "unauthenticated" | "not_available" | "invalid_state" | "rate_limited";
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

export async function resolveConversations(client: RpcClient): Promise<{ status: "ok"; rows: { conversation: LiveConversation; counterpart: string }[] } | Failure> {
  const r = await callRpc(client, "list_my_conversations");
  if (r.code !== "ok") return { status: r.code === "unauthenticated" ? r.code : "unavailable" };
  if (!Array.isArray(r.data)) return { status: "unavailable" };
  const rows = [];
  for (const value of r.data) {
    if (!value || typeof value !== "object") return { status: "unavailable" };
    const v = value as Record<string, unknown>;
    const empty = [v.last_message_id, v.last_message_body, v.last_message_at, v.last_message_mine].every((x) => x === null);
    if (!isUuid(v.conversation_id) || !isUuid(v.connection_id) || !isUuid(v.counterpart_id) || typeof v.counterpart_name !== "string" ||
      !(v.counterpart_photo_id === null || isUuid(v.counterpart_photo_id)) || typeof v.unread !== "boolean" ||
      (!empty && (!positive(v.last_message_id) || typeof v.last_message_body !== "string" || typeof v.last_message_at !== "string" || typeof v.last_message_mine !== "boolean"))) return { status: "unavailable" };
    rows.push({ counterpart: v.counterpart_id, conversation: {
      id: v.conversation_id, partner: { name: v.counterpart_name, photoId: v.counterpart_photo_id as string | null },
      latest: empty ? null : { body: v.last_message_body as string, at: v.last_message_at as string, mine: v.last_message_mine as boolean }, unread: v.unread,
    } });
  }
  return { status: "ok", rows };
}

export async function listConversations(client: RpcClient): Promise<{ status: "ok"; conversations: LiveConversation[] } | Failure> {
  try {
    const r = await resolveConversations(client);
    return r.status === "ok" ? { status: "ok", conversations: r.rows.map((row) => row.conversation) } : r;
  } catch {
    return { status: "unavailable" };
  }
}

export async function messagePage(client: RpcClient, id: string, counterpart: string, before: number | null): Promise<MessagePage | Failure> {
  const r = await callRpc(client, "list_messages", { p_conversation: id, p_before: before, p_limit: PAGE_SIZE });
  if (r.code !== "ok") return { status: r.code === "unauthenticated" ? r.code : "unavailable" };
  if (!Array.isArray(r.data)) return { status: "unavailable" };
  const messages: LiveMessage[] = [];
  for (const value of r.data) {
    if (!value || typeof value !== "object") return { status: "unavailable" };
    const v = value as Record<string, unknown>;
    if (!positive(v.id) || !isUuid(v.sender_id) || typeof v.body !== "string" || typeof v.created_at !== "string" || !Number.isFinite(Date.parse(v.created_at)) ||
      !(v.hidden === undefined || typeof v.hidden === "boolean")) return { status: "unavailable" };
    messages.push({ id: v.id, mine: v.sender_id !== counterpart, body: v.body, createdAt: v.created_at, hidden: v.hidden === true });
  }
  return { status: "ok", messages: messages.sort((a, b) => a.id - b.id), hasOlder: r.data.length === PAGE_SIZE };
}

export const loadConversationList = (client: RpcClient): Promise<Gated<{ status: "ok"; conversations: LiveConversation[] }>> =>
  gate(client, () => listConversations(client));

export type Room = { conversation: LiveConversation; messages: LiveMessage[]; hasOlder: boolean };
export function loadRoom(client: RpcClient, id: unknown): Promise<Gated<{ status: "ok"; room: Room | null }>> {
  if (!isUuid(id)) return Promise.resolve({ status: "ok", room: null });
  return gate(client, async () => {
    const r = await resolveConversations(client);
    if (r.status !== "ok") return r;
    const row = r.rows.find((v) => v.conversation.id === id);
    if (!row) return { status: "ok", room: null };
    const page = await messagePage(client, id, row.counterpart, null);
    if (page.status !== "ok") return page;
    return { status: "ok", room: { conversation: row.conversation, messages: page.messages, hasOlder: page.hasOlder } };
  });
}

// src/server/chat-actions.ts perform.
async function perform(client: RpcClient, id: string, operation: "latest" | "older" | "send" | "read", value?: number, token?: string, body?: string): Promise<MessagePage | { status: "ok" } | { status: ChatStatus }> {
  try {
    const resolved = await resolveConversations(client);
    if (resolved.status !== "ok") return resolved;
    const row = resolved.rows.find((r) => r.conversation.id === id);
    if (!row) return { status: "not_available" };
    if (operation === "send" || operation === "read") {
      const r = operation === "send"
        ? await callRpc(client, "send_message", { p_conversation: id, p_client_msg_id: token, p_body: body })
        : await callRpc(client, "mark_read", { p_conversation: id, p_message_id: value });
      if (r.code !== "ok") return { status: (["not_available", "invalid_state", "rate_limited", "validation", "unauthenticated"].includes(r.code) ? r.code : "unavailable") as ChatStatus };
      if (operation === "read") return { status: "ok" };
    }
    return await messagePage(client, id, row.counterpart, operation === "older" ? value! : null);
  } catch {
    return { status: "unavailable" };
  }
}

export type PageResult = MessagePage | { status: ChatStatus };
export function sendChatMessage(client: RpcClient, id: unknown, token: unknown, body: unknown): Promise<PageResult> {
  if (!isUuid(id) || !isUuid(token) || typeof body !== "string" || !validateBody(body)) return Promise.resolve({ status: "validation" });
  return perform(client, id, "send", undefined, token, body) as Promise<PageResult>;
}
export function olderMessages(client: RpcClient, id: unknown, before: unknown): Promise<PageResult> {
  if (!isUuid(id) || !Number.isSafeInteger(before) || (before as number) <= 0) return Promise.resolve({ status: "validation" });
  return perform(client, id, "older", before as number) as Promise<PageResult>;
}
export function latestMessages(client: RpcClient, id: unknown): Promise<PageResult> {
  if (!isUuid(id)) return Promise.resolve({ status: "validation" });
  return perform(client, id, "latest") as Promise<PageResult>;
}
export async function markRead(client: RpcClient, id: unknown, messageId: unknown): Promise<{ status: "ok" | ChatStatus }> {
  if (!isUuid(id) || !Number.isSafeInteger(messageId) || (messageId as number) <= 0) return { status: "validation" };
  return { status: (await perform(client, id, "read", messageId as number)).status };
}

/** The client message id of one send: an idempotency key for send_message, not a secret. */
export function clientMessageId(random: () => number = Math.random): string {
  const native = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  if (native) {
    try {
      const value = native.call((globalThis as { crypto?: unknown }).crypto);
      if (isUuid(value)) return value;
    } catch {
      // Fall through to the version-4 form below.
    }
  }
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = "89ab"[Math.floor(random() * 4)];
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
