"use client";
import { createContext, useContext, useRef, type ReactNode } from "react";
import { useDemoLikes } from "@/components/demo-likes-provider";
import { useChatGateway } from "@/components/demo-chat-provider";
import { createSafetyDemo } from "@/lib/safety-demo";
import type { SafetyGateway } from "@/lib/safety-gateway";

const SafetyContext = createContext<SafetyGateway | null>(null);
export function DemoSafetyProvider({ children }: { children: ReactNode }) {
  const { getState, dispatch } = useDemoLikes();
  const chat = useChatGateway();
  const gateway = useRef<SafetyGateway | null>(null);
  if (!gateway.current) gateway.current = createSafetyDemo(getState, dispatch, chat);
  return <SafetyContext.Provider value={gateway.current}>{children}</SafetyContext.Provider>;
}
export function useSafetyGateway() { return useContext(SafetyContext); }
