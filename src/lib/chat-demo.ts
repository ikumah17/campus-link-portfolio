import { getDemoProfile } from "@/data/demo-profiles";
import { demoChatMessages, demoChatPartner } from "@/data/demo-chats";
import { demoViewer } from "@/data/demo-likes";
import type { LikesState } from "@/lib/likes-demo";
import { validateBody, type ChatGateway, type ChatMessage, type Conversation } from "@/lib/chat-gateway";

export function createChatDemo(getRequests: () => LikesState, me = demoViewer): ChatGateway {
  const messages = demoChatMessages.map((m) => ({ ...m }));
  const read = new Map<string, number>();
  const partner = (id: string) => id === demoChatPartner.id ? demoChatPartner : getDemoProfile(id);
  const connected = (id: string) => !!partner(id) && getRequests().connections.some(([a, b]) => (a === me && b === id) || (b === me && a === id));
  const history = (id: string) => messages.filter((m) => m.conversationId === id);
  return {
    async listMyConversations() {
      const ids = [...new Set(getRequests().connections.flatMap(([a, b]) => a === me ? [b] : b === me ? [a] : []))];
      const data: Conversation[] = ids.filter(connected).map((id) => {
        const profile = partner(id)!;
        const rows = history(id);
        return { id, partner: { name: profile.name, image: profile.image, imageAlt: profile.imageAlt }, latest: rows.at(-1) ?? null,
          unread: rows.some((m) => m.sender !== me && m.id > (read.get(id) ?? 0)) };
      });
      data.sort((a, b) => (b.latest?.createdAt ?? 0) - (a.latest?.createdAt ?? 0) || a.id.localeCompare(b.id));
      return { code: "ok", data };
    },
    async listMessages(id, { before, limit = 30 } = {}) {
      if (!connected(id)) return { code: "ok", data: [] };
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (before !== undefined && (!Number.isInteger(before) || before < 1))) return { code: "validation", data: [] };
      return { code: "ok", data: history(id).filter((m) => before === undefined || m.id < before).slice().reverse().slice(0, limit).map((m) => ({ ...m })) };
    },
    async sendMessage(id, clientMsgId, body) {
      if (!connected(id)) return { code: "not_available", data: null };
      if (!validateBody(body) || !clientMsgId) return { code: "validation", data: null };
      const prior = messages.find((m) => m.sender === me && m.clientMsgId === clientMsgId);
      if (prior) return { code: "ok", data: { ...prior } };
      const row: ChatMessage = { id: (messages.at(-1)?.id ?? 0) + 1, conversationId: id, sender: me, clientMsgId, body, createdAt: Date.now() };
      messages.push(row);
      return { code: "ok", data: { ...row } };
    },
    async markRead(id, messageId) {
      if (!connected(id)) return { code: "not_available", data: null };
      if (!history(id).some((m) => m.id === messageId)) return { code: "validation", data: null };
      read.set(id, Math.max(read.get(id) ?? 0, messageId));
      return { code: "ok", data: null };
    },
  };
}
