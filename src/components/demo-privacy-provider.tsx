"use client";
import { createContext, useContext, useRef, type ReactNode } from "react";
import { createPrivacyDemo, type PrivacyGateway } from "@/lib/privacy-gateway";

const PrivacyContext = createContext<PrivacyGateway | null>(null);
export function DemoPrivacyProvider({ children, gateway }: { children: ReactNode; gateway?: PrivacyGateway }) {
  const demo = useRef<PrivacyGateway | null>(null);
  if (!demo.current) demo.current = createPrivacyDemo();
  return <PrivacyContext.Provider value={gateway ?? demo.current}>{children}</PrivacyContext.Provider>;
}
export function usePrivacyGateway() {
  const gateway = useContext(PrivacyContext);
  if (!gateway) throw new Error("PrivacySettings requires DemoPrivacyProvider");
  return gateway;
}
