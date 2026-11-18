import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

// MOBILE-003 (docs/42 §2 #9): Realtime through the app's own supabase-js session. The web's browser client cannot read
// its HttpOnly cookies, so it fetches a short-lived token from /api/realtime-token; the app holds its session itself
// (Keychain), and supabase-js hands that access token to Realtime on connect and on every refresh. No token route is
// needed, Bearer or otherwise. The payload of a change is never read: the app re-reads through the RPCs, which decide
// (messages RLS, rls_conversation_member), exactly as the web refreshes its server render.
export type RealtimeClient = Pick<SupabaseClient, "channel" | "removeChannel" | "realtime">;
const RECOVERING = ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"];

/**
 * Joins one channel for new messages (all of the user's, or one conversation's) and calls onChange for each insert and
 * after a rejoin that followed an error. Returns the unsubscribe; it is safe before the join has finished.
 */
export function watchMessages(client: RealtimeClient, name: string, conversationId: string | null, onChange: () => void): () => void {
  let active = true;
  let recovering = false;
  let channel: ReturnType<RealtimeClient["channel"]> | undefined;
  void (async () => {
    // Load the session's token before joining, so the first join carries the user's JWT.
    try { await client.realtime.setAuth(); } catch { return; }
    if (!active) return;
    const filter = { event: "INSERT" as const, schema: "public", table: "messages", ...(conversationId ? { filter: `conversation_id=eq.${conversationId}` } : {}) };
    channel = client.channel(name)
      .on("postgres_changes", filter, () => { if (active) onChange(); })
      .subscribe((status) => {
        if (!active) return;
        if (RECOVERING.includes(status)) recovering = true;
        else if (status === "SUBSCRIBED" && recovering) { recovering = false; onChange(); }
      });
  })();
  return () => {
    active = false;
    if (channel) void client.removeChannel(channel);
  };
}

/** At most one call per interval: the first runs at once, later ones are folded into one at the end of the interval. */
export function throttle(callback: () => void, intervalMs: number, now: () => number = Date.now) {
  let last: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    const remaining = last === undefined ? 0 : intervalMs - (now() - last);
    if (remaining <= 0) {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      last = now();
      callback();
    } else if (timer === undefined) {
      timer = setTimeout(() => { timer = undefined; run(); }, remaining);
    }
  };
  return { run, cancel: () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; } };
}

/**
 * The screen's live feed: the Realtime channel while enabled, and a refresh when the app returns to the foreground
 * (the web's focus and visibilitychange). onChange is read through a ref, so a new closure never rejoins.
 */
export function useMessageFeed(client: RealtimeClient | null, name: string, conversationId: string | null, enabled: boolean, onChange: () => void) {
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    if (!client || !enabled) return;
    const stop = watchMessages(client, name, conversationId, () => callback.current());
    let state = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active" && state !== "active") callback.current();
      state = next;
    });
    return () => { stop(); subscription.remove(); };
  }, [client, name, conversationId, enabled]);
}
