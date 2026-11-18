export type ChatCode = "ok" | "validation" | "not_available" | "rate_limited";
export type ChatResult<T> = { code: ChatCode; data: T };
export type ChatMessage = { id: number; conversationId: string; sender: string; clientMsgId: string; body: string; createdAt: number };
export type Conversation = { id: string; partner: { name: string; image: string; imageAlt: string }; latest: ChatMessage | null; unread: boolean };
export const CHAT_NOTICE = "デモ：メッセージは架空で、どこにも送信・保存されません。";
export function validateBody(body: string): boolean { return body.trim().length > 0 && [...body].length <= 2000; }
export interface ChatGateway {
  // list_my_conversations()
  listMyConversations(): Promise<ChatResult<Conversation[]>>;
  // list_messages(p_conversation, p_before, p_limit), newest first
  listMessages(conversationId: string, options?: { before?: number; limit?: number }): Promise<ChatResult<ChatMessage[]>>;
  // send_message(p_conversation, p_client_msg_id, p_body)
  sendMessage(conversationId: string, clientMsgId: string, body: string): Promise<ChatResult<ChatMessage | null>>;
  // mark_read(p_conversation, p_message_id)
  markRead(conversationId: string, messageId: number): Promise<ChatResult<null>>;
}
