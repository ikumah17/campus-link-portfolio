import type { ChatMessage } from "@/lib/chat-gateway";

// Chat-only fictional partner; deliberately absent from Discover.
export const demoChatPartner = { id: "demo-4", name: "ゆう（架空）", image: "/demo-profile-1.svg", imageAlt: "ゆう（架空）のプレースホルダー画像" };

// Fictional scripted history; never generated in response to the viewer.
export const demoChatMessages: ChatMessage[] = Array.from({ length: 36 }, (_, i) => ({
  id: i + 1, conversationId: "demo-4", sender: i % 2 === 0 ? "demo-viewer" : "demo-4",
  clientMsgId: `seed-${i + 1}`, body: `架空の会話 ${i + 1}：おすすめの本について話しています。`, createdAt: Date.UTC(2026, 9, 29, 10, i),
}));
