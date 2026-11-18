"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";

export function TalkListRealtime() {
  const router = useRouter();

  useEffect(() => {
    let client: ReturnType<typeof createBrowserSupabase>;
    try {
      client = createBrowserSupabase();
    } catch {
      return;
    }
    let active = true;
    let lastRefresh: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reconnect = false;
    const refresh = () => {
      if (!active) return;
      const remaining = lastRefresh === undefined ? 0 : 1000 - (Date.now() - lastRefresh);
      if (remaining <= 0) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        lastRefresh = Date.now();
        router.refresh();
      } else if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          refresh();
        }, remaining);
      }
    };
    let channel: ReturnType<typeof client.channel> | undefined;
    // Load the cookie session before joining on a fresh/direct list navigation.
    void (async () => {
      try { await client.realtime.setAuth(); } catch { return; }
      if (!active) return;
      // The payload is intentionally ignored; server rendering remains authoritative.
      channel = client.channel("talk-list")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, refresh)
      .subscribe(status => {
        if (!active) return;
        if (status === "SUBSCRIBED") {
          if (reconnect) {
            reconnect = false;
            refresh();
          }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          reconnect = true;
        }
      });
    })();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      if (channel) void client.removeChannel(channel);
    };
  }, [router]);

  return null;
}
