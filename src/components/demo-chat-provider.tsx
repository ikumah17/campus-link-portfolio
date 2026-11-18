"use client";
import { createContext, useContext, useRef, type ReactNode } from "react";
import { useDemoLikes } from "@/components/demo-likes-provider";
import { createChatDemo } from "@/lib/chat-demo";
import type { ChatGateway } from "@/lib/chat-gateway";

const ChatContext = createContext<ChatGateway | null>(null);
export function DemoChatProvider({ children, gateway }: { children: ReactNode; gateway?: ChatGateway }) {
  const { getState } = useDemoLikes();
  const gatewayRef = useRef<ChatGateway | null>(null);
  if (!gatewayRef.current) gatewayRef.current = gateway ?? createChatDemo(getState);
  return <ChatContext.Provider value={gatewayRef.current}>{children}</ChatContext.Provider>;
}
export function useChatGateway() {
  const gateway = useContext(ChatContext);
  if (!gateway) throw new Error("DemoChatProvider is required");
  return gateway;
}
