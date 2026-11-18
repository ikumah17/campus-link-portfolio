import { getDemoProfile } from "@/data/demo-profiles";
import { demoChatPartner } from "@/data/demo-chats";
import { demoViewer } from "@/data/demo-likes";
import type { ChatGateway } from "@/lib/chat-gateway";
import type { LikeAction, LikesState } from "@/lib/likes-demo";
import { validateReport, type MyReport, type ReportInput, type SafetyGateway } from "@/lib/safety-gateway";

export function createSafetyDemo(getState: () => LikesState, dispatch: (action: LikeAction) => void, chat: ChatGateway, me = demoViewer): SafetyGateway {
  const reports: (MyReport & { input: ReportInput; message_snapshot: string | null })[] = [];
  const pair = (a: string, b: string, target: string) => (a === me && b === target) || (a === target && b === me);
  const visibleName = (target: string): string | null => {
    if (getState().blocks?.some((b) => b.blocked_id === target)) return null;
    return getDemoProfile(target)?.name ?? (target === demoChatPartner.id && getState().connections.some(([a, b]) => pair(a, b, target)) ? demoChatPartner.name : null);
  };
  return {
    async blockUser(target) {
      if (target === me) return { code: "validation", data: null };
      dispatch({ type: "block", me, target, name: visibleName(target) });
      return { code: "ok", data: null };
    },
    async unblockUser(target) { dispatch({ type: "unblock", target }); return { code: "ok", data: null }; },
    async listMyBlocks() {
      return { code: "ok", data: (getState().blocks ?? []).map(({ blocked_id, blocked_name_snapshot, created_at }) => ({ blocked_id, blocked_name_snapshot, created_at })) };
    },
    async submitReport(input) {
      if (!validateReport(input)) return { code: "validation", data: null };
      const state = getState();
      let snapshot: string | null = null;
      if (input.context === "message") {
        const page = await chat.listMessages(input.target, { before: input.messageId! + 1, limit: 1 });
        const message = page.data.find((m) => m.id === input.messageId && m.sender === input.target && m.conversationId === input.target);
        if (!message) return { code: "not_available", data: null };
        snapshot = message.body;
      } else if (input.target === me || !(visibleName(input.target) || state.likes.some((l) => pair(l.liker, l.liked, input.target)) || [...state.connections, ...(state.endedConnections ?? []).map((c) => c.members)].some(([a, b]) => pair(a, b, input.target)))) {
        return { code: "not_available", data: null };
      }
      reports.push({ id: `report-${reports.length + 1}`, created_at: Date.now(), status: "open", input: { ...input }, message_snapshot: snapshot });
      return { code: "ok", data: null };
    },
    async myReports() { return { code: "ok", data: reports.map(({ id, created_at, status }) => ({ id, created_at, status })) }; },
  };
}
