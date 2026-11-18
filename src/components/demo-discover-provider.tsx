"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useDemoLikes } from "@/components/demo-likes-provider";
import { demoViewer } from "@/data/demo-likes";
import { createDiscoverDemo, type DiscoverGateway } from "@/lib/discover-gateway";

// The gateway reads the latest likes when asked, so a like on a card does not reload the list (as on the live page).
const DiscoverContext = createContext<DiscoverGateway | null>(null);
export function DemoDiscoverProvider({ children }: { children: ReactNode }) {
  const { getState } = useDemoLikes();
  const gateway = useMemo(() => createDiscoverDemo(getState, demoViewer), [getState]);
  return <DiscoverContext.Provider value={gateway}>{children}</DiscoverContext.Provider>;
}
export function useDiscoverGateway() {
  const gateway = useContext(DiscoverContext);
  const { getState } = useDemoLikes();
  const fallback = useMemo(() => createDiscoverDemo(getState, demoViewer), [getState]);
  return gateway ?? fallback;
}
