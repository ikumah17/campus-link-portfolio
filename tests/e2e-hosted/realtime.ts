// Phoenix v2 is a five-item array; v1 uses an object. Keep only flags, never
// credentials from phx_join/access_token or complete message payloads.
function errorCode(message: unknown): string {
  if (typeof message !== "string") return "unknown_realtime_error";
  // Finite labels only: even an arbitrary provider prefix can contain a secret.
  const known = ["InvalidJWT", "InvalidJWTToken", "InvalidJWTExpiration", "MalformedJWT", "Unauthorized",
    "RealtimeDisabledForConfiguration", "UnableToSubscribeToPostgres", "ReconnectSubscribeToPostgres",
    "DatabaseLackOfConnections", "RealtimeRestarting", "ConnectionRateLimitReached"];
  const prefix = message.match(/^([A-Za-z][A-Za-z0-9_]*):/)?.[1];
  if (prefix && known.includes(prefix)) return prefix;
  for (const [pattern, label] of [
    [/subscription_insert_failed/, "subscription_insert_failed"],
    [/malformed_subscription_params/, "malformed_subscription_params"],
    [/invalid column for filter.*conversation_id/i, "invalid_conversation_filter_column"],
    [/unique_violation|23505/, "database_unique_violation"],
    [/insufficient_privilege|permission denied|42501/, "database_permission_denied"],
    [/undefined_table|42P01/, "database_undefined_table"],
    [/undefined_column|42703/, "database_undefined_column"],
    [/invalid_text_representation|22P02/, "database_invalid_text"],
    [/Token has expired/, "expired_token"],
    [/Too many database timeouts/, "database_timeouts"],
    [/Server requested disconnect/, "server_disconnect"],
  ] as const) if (pattern.test(message)) return label;
  return "unknown_realtime_error";
}

export function roomsReady(observations: { readyAt: number; systemError: boolean; errorCode: string | null }[]): boolean {
  // There is deliberately no skip path. Unknown, app/auth and operational
  // errors all fail this required flow, even if another room is already ready.
  for (const observation of observations) {
    if (observation.systemError) throw new Error(`Realtime room rejoin failed: ${observation.errorCode}`);
  }
  return observations.length === 2 && observations.every(observation => observation.readyAt > 0);
}

export function realtimeJoinFlags(raw: string, userId: string) {
  try {
    const decoded = JSON.parse(raw);
    if ((Array.isArray(decoded) ? decoded[3] : decoded.event) !== "phx_join") return null;
    const payload = Array.isArray(decoded) ? decoded[4] : decoded.payload;
    let claims: Record<string, unknown> = {};
    try { claims = JSON.parse(Buffer.from(payload.access_token.split(".")[1], "base64url").toString("utf8")); } catch { /* no user JWT */ }
    return {
      role: claims.role === "authenticated" ? "authenticated" : claims.role === "anon" ? "anon" : "unknown",
      userMatches: claims.sub === userId,
      roomFilterValid: payload.config?.postgres_changes?.some((filter: Record<string, unknown>) =>
        filter.schema === "public" && filter.table === "messages" && typeof filter.filter === "string" &&
        /^conversation_id=eq\.[a-f0-9-]{36}$/.test(filter.filter)) === true,
    };
  } catch { return null; }
}

export function realtimeFlags(raw: string): { insert: boolean; subscribed: boolean; ready: boolean; systemError: boolean; errorCode: string | null } {
  try {
    const decoded = JSON.parse(raw);
    const event = Array.isArray(decoded) ? decoded[3] : decoded.event;
    const payload = Array.isArray(decoded) ? decoded[4] : decoded.payload;
    const systemError = (event === "system" || event === "phx_reply") && payload?.status === "error";
    return {
      insert: event === "postgres_changes" && payload?.data?.type === "INSERT",
      subscribed: event === "phx_reply" && payload?.status === "ok" && Array.isArray(payload?.response?.postgres_changes) && payload.response.postgres_changes.length > 0,
      // A channel join can precede activation of its Postgres subscription.
      ready: event === "system" && payload?.extension === "postgres_changes" && payload?.status === "ok",
      systemError,
      errorCode: systemError ? errorCode(event === "system" ? payload.message : payload.response?.reason) : null,
    };
  } catch { return { insert: false, subscribed: false, ready: false, systemError: false, errorCode: null }; }
}

type RoomWire = {
  state: "joining" | "joined" | "leaving" | "closed" | "errored";
  ready: boolean; joins: number; leaves: number; insertCount: number; insertAt: number; tokenUpdates: number;
};
// TEST-007: the talk list joins one unfiltered public.messages INSERT channel.
export const talkListTopic = "realtime:talk-list";
const uuid = /^[a-f0-9-]{36}$/;
export class RoomWireProbe {
  private rooms = new Map<string, { topic: string; ref: string | null; value: RoomWire }>();
  // Per conversation id INSERT counts on the talk list topic; only snapshot() callers' ids leave the probe.
  private list: { ref: string | null; value: RoomWire; rooms: Map<string, { count: number; at: number }> } | null = null;
  private heartbeatRef: string | null = null;
  private heartbeatReplies = 0;
  observe(raw: string, sent: boolean, now = Date.now()) {
    try {
      const data = JSON.parse(raw);
      const [ref, topic, event, payload] = Array.isArray(data)
        ? [data[1], data[2], data[3], data[4]] : [data.ref, data.topic, data.event, data.payload];
      if (typeof topic !== "string") return;
      if (topic === "phoenix") {
        if (sent && event === "heartbeat" && typeof ref === "string") this.heartbeatRef = ref;
        if (!sent && event === "phx_reply" && this.heartbeatRef !== null && ref === this.heartbeatRef && payload?.status === "ok") {
          this.heartbeatReplies++;
          this.heartbeatRef = null;
        }
        return;
      }
      if (sent && event === "phx_join" && topic === talkListTopic) {
        const unfiltered = (payload?.config?.postgres_changes ?? []).some((filter: Record<string, unknown>) =>
          filter.schema === "public" && filter.table === "messages" && filter.filter === undefined);
        if (!unfiltered) return;
        const old = this.list;
        this.list = { ref, rooms: old?.rooms ?? new Map(), value: {
          state: "joining", ready: false, joins: (old?.value.joins ?? 0) + 1, leaves: old?.value.leaves ?? 0,
          insertCount: old?.value.insertCount ?? 0, insertAt: old?.value.insertAt ?? 0, tokenUpdates: old?.value.tokenUpdates ?? 0,
        } };
        return;
      }
      if (sent && event === "phx_join") {
        for (const filter of payload?.config?.postgres_changes ?? []) {
          const id = typeof filter.filter === "string" && filter.filter.match(/^conversation_id=eq\.([a-f0-9-]{36})$/)?.[1];
          if (filter.schema !== "public" || filter.table !== "messages" || !id) continue;
          const old = this.rooms.get(id)?.value;
          this.rooms.set(id, { topic, ref, value: {
            state: "joining", ready: false, joins: (old?.joins ?? 0) + 1, leaves: old?.leaves ?? 0,
            insertCount: old?.insertCount ?? 0, insertAt: old?.insertAt ?? 0, tokenUpdates: old?.tokenUpdates ?? 0,
          } });
        }
        return;
      }
      if (topic === talkListTopic) {
        if (!this.list) return;
        const insert = track(this.list, sent, ref, event, payload, now);
        const id = payload?.data?.record?.conversation_id;
        if (insert && typeof id === "string" && uuid.test(id)) {
          const room = this.list.rooms.get(id) ?? { count: 0, at: 0 };
          this.list.rooms.set(id, { count: room.count + 1, at: now });
        }
        return;
      }
      for (const room of this.rooms.values()) if (room.topic === topic) track(room, sent, ref, event, payload, now);
    } catch { /* Non-JSON transport messages cannot establish a joined channel. */ }
  }
  snapshot(id: string) {
    const room = this.rooms.get(id);
    return room ? { ...room.value, heartbeatReplies: this.heartbeatReplies } : null;
  }
  // Counts for the given (run-owned) room ids only; other rooms' INSERTs are a bare count.
  listSnapshot(ids: string[]) {
    if (!this.list) return null;
    const rooms: Record<string, { count: number; at: number }> = {};
    for (const id of ids) rooms[id] = { ...this.list.rooms.get(id) ?? { count: 0, at: 0 } };
    let otherInserts = 0;
    for (const [id, room] of this.list.rooms) if (!ids.includes(id)) otherInserts += room.count;
    return { topic: talkListTopic, ...this.list.value, rooms, otherInserts, heartbeatReplies: this.heartbeatReplies };
  }
}

// Returns whether the frame was a received INSERT on this channel.
function track(channel: { ref: string | null; value: RoomWire }, sent: boolean, ref: unknown, event: unknown, payload: any, now: number) {
  const value = channel.value;
  if (sent) {
    if (event === "phx_leave") { value.state = "leaving"; value.leaves++; }
    if (event === "access_token") value.tokenUpdates++;
    return false;
  }
  if (event === "phx_reply" && ref === channel.ref && payload?.status === "ok" &&
    payload.response?.postgres_changes?.length > 0 && value.state === "joining") value.state = "joined";
  if (event === "system" && payload?.extension === "postgres_changes" && payload.status === "ok") value.ready = true;
  if (event === "phx_close") value.state = "closed";
  if (event === "phx_error" || ((event === "system" || event === "phx_reply") && payload?.status === "error")) value.state = "errored";
  if (event === "postgres_changes" && payload?.data?.type === "INSERT") { value.insertCount++; value.insertAt = now; return true; }
  return false;
}
