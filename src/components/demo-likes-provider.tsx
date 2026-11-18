"use client";

import { createContext, useContext, useCallback, useRef, useState, type Dispatch, type ReactNode } from "react";
import { createDemoLikes } from "@/data/demo-likes";
import { likesReducer, type LikeAction, type LikesState } from "@/lib/likes-demo";

// The default supports isolated static rendering; the root layout always supplies the live reducer.
const LikesContext = createContext<{ state: LikesState; dispatch: Dispatch<LikeAction>; getState: () => LikesState }>({ state: createDemoLikes(), dispatch: () => {}, getState: createDemoLikes });
export function DemoLikesProvider({ children, initialState }: { children: ReactNode; initialState?: LikesState }) {
  const [state, setState] = useState(() => initialState ?? createDemoLikes());
  const latest = useRef(state);
  const getState = useCallback(() => latest.current, []);
  const dispatch = useCallback((action: LikeAction) => {
    latest.current = likesReducer(latest.current, action);
    setState(latest.current);
  }, []);
  return <LikesContext.Provider value={{ state, dispatch, getState }}>{children}</LikesContext.Provider>;
}
export function useDemoLikes() { return useContext(LikesContext); }
