import { describe, expect, it } from "vitest";
import { realtimeFlags, realtimeJoinFlags, roomsReady, RoomWireProbe, talkListTopic } from "./realtime";

const ready = { readyAt: 1, systemError: false, errorCode: null };

describe("required pre-block Realtime stream", () => {
  it.each(["InvalidJWT", "Unauthorized", "RealtimeRestarting", "DatabaseLackOfConnections", "UnrecognizedCode"])(
    "fails closed for %s instead of skipping or accepting a join acknowledgement", code => {
      for (const event of ["system", "phx_reply"]) {
        const flags = realtimeFlags(JSON.stringify([null, null, "realtime:chat", event, {
          status: "error", extension: "postgres_changes", message: `${code}: private diagnostic`,
          response: { reason: `${code}: private diagnostic` },
        }]));
        expect(flags.systemError).toBe(true);
        // An earlier readiness event must not hide a later auth/system failure.
        expect(() => roomsReady([ready, { ...flags, readyAt: 1 }])).toThrow("Realtime room rejoin failed");
        expect(() => roomsReady([{ ...flags, readyAt: 0 }, ready])).toThrow("Realtime room rejoin failed");
      }
    },
  );

  it("requires both rooms to become ready; a join acknowledgement is insufficient", () => {
    expect(roomsReady([ready, { ...ready, readyAt: 0 }])).toBe(false);
    expect(roomsReady([ready, ready])).toBe(true);
    const join = realtimeFlags(JSON.stringify({ event: "phx_reply", payload: {
      status: "ok", response: { postgres_changes: [{ id: 1 }] },
    } }));
    expect(join.subscribed).toBe(true);
    expect(join.ready).toBe(false);
  });

  it("classifies the room-filter failure without retaining parameters or exception details", () => {
    const flags = realtimeFlags(JSON.stringify({ event: "system", payload: { status: "error",
      message: "Unable to subscribe. Exception: invalid column for filter conversation_id; private parameters",
    } }));
    expect(flags.errorCode).toBe("invalid_conversation_filter_column");
    expect(() => roomsReady([ready, { ...flags, readyAt: 0 }])).toThrow("invalid_conversation_filter_column");
    expect(JSON.stringify(flags)).not.toContain("private parameters");
  });

  it.each([undefined, {}, "secretLikePrefix123: sensitive token", "{:error, unknown_details}"])(
    "retains no arbitrary provider text in diagnostics", message => {
      const flags = realtimeFlags(JSON.stringify({ event: "system", payload: { status: "error", message } }));
      expect(flags.errorCode).toBe("unknown_realtime_error");
      expect(() => roomsReady([ready, { ...flags, readyAt: 0 }])).toThrow("unknown_realtime_error");
      expect(JSON.stringify(flags)).not.toContain("sensitive");
      expect(JSON.stringify(flags)).not.toContain("secretLikePrefix123");
    },
  );
});

it("retains only authentication/filter booleans from outgoing joins, never the token or claims", () => {
  const id = "12345678-1234-4123-8123-123456789abc";
  const claims = { role: "authenticated", sub: id, email: "unit@example.invalid" };
  const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const join = realtimeJoinFlags(JSON.stringify([null, "1", "realtime:chat", "phx_join", {
    access_token: token,
    config: { postgres_changes: [{ schema: "public", table: "messages", filter: `conversation_id=eq.${id}` }] },
  }]), id);
  expect(join).toEqual({ role: "authenticated", userMatches: true, roomFilterValid: true });
  expect(JSON.stringify(join)).not.toContain(token);
  expect(JSON.stringify(join)).not.toContain(id);
  expect(JSON.stringify(join)).not.toContain(claims.email);
  expect(realtimeJoinFlags(JSON.stringify({ event: "phx_join", payload: { access_token: "not-a-jwt" } }), id))
    .toEqual({ role: "unknown", userMatches: false, roomFilterValid: false });
});

describe("existing room channel lifetime", () => {
  const id = "12345678-1234-4123-8123-123456789abc";
  const frame = (event: string, payload: unknown, ref = "1", topic = "realtime:chat") => JSON.stringify([null, ref, topic, event, payload]);
  function joining() {
    const probe = new RoomWireProbe();
    probe.observe(frame("phx_join", { access_token: "never-retain-this-secret", config: { postgres_changes: [
      { schema: "public", table: "messages", filter: `conversation_id=eq.${id}` },
    ] } }), true);
    return probe;
  }
  const joined = { status: "ok", response: { postgres_changes: [{ id: 1 }] } };
  it("ties joined state to the exact outgoing room, socket topic and join ref", () => {
    const probe = joining();
    probe.observe(frame("phx_reply", joined, "other"), false);
    probe.observe(frame("phx_reply", joined, "1", "unrelated"), false);
    expect(probe.snapshot(id)?.state).toBe("joining");
    probe.observe(frame("system", { status: "ok", extension: "postgres_changes" }), false);
    expect(probe.snapshot(id)?.state).toBe("joining");
    probe.observe(frame("phx_reply", joined), false);
    expect(probe.snapshot(id)).toMatchObject({ state: "joined", ready: true, joins: 1, leaves: 0 });
    expect(JSON.stringify(probe.snapshot(id))).not.toContain("secret");
  });
  it.each(["phx_leave", "phx_close", "phx_error"])("does not retain a stale joined state after %s", event => {
    const probe = joining();
    probe.observe(frame("phx_reply", joined), false);
    probe.observe(frame(event, {}), event === "phx_leave");
    expect(probe.snapshot(id)?.state).not.toBe("joined");
    probe.observe(frame("phx_reply", joined), false);
    expect(probe.snapshot(id)?.state).not.toBe("joined");
  });
  it("counts only this room's received INSERTs and retains no body or token updates", () => {
    const probe = joining();
    const payload = { data: { type: "INSERT", record: { body: "private-body", access_token: "private-token" } } };
    probe.observe(frame("postgres_changes", payload, "1", "another-room"), false, 100);
    probe.observe(frame("postgres_changes", payload), false, 101);
    probe.observe(frame("access_token", { access_token: "new-private-token" }), true);
    expect(probe.snapshot(id)).toMatchObject({ insertCount: 1, insertAt: 101, tokenUpdates: 1 });
    expect(JSON.stringify(probe.snapshot(id))).not.toContain("private");
  });
  it("counts talk list INSERTs per run room on the talk-list topic only, without bodies or other room ids", () => {
    const other = "87654321-4321-4321-8321-cba987654321";
    const foreign = "11111111-2222-4333-8444-555555555555";
    const probe = new RoomWireProbe();
    expect(probe.listSnapshot([id])).toBeNull();
    probe.observe(frame("phx_join", { access_token: "never-retain-this-secret", config: { postgres_changes: [
      { event: "INSERT", schema: "public", table: "messages" },
    ] } }, "7", talkListTopic), true);
    probe.observe(frame("phx_reply", joined, "7", talkListTopic), false);
    probe.observe(frame("system", { status: "ok", extension: "postgres_changes" }, "8", talkListTopic), false);
    const insert = (conversation: string) => ({ data: { type: "INSERT", record: { conversation_id: conversation, body: "private-body" } } });
    probe.observe(frame("postgres_changes", insert(id), "9", talkListTopic), false, 200);
    probe.observe(frame("postgres_changes", insert(other), "9", talkListTopic), false, 201);
    probe.observe(frame("postgres_changes", insert(foreign), "9", talkListTopic), false, 202);
    probe.observe(frame("postgres_changes", insert(id)), false, 203);
    probe.observe(frame("postgres_changes", { data: { type: "UPDATE", record: { conversation_id: id } } }, "9", talkListTopic), false, 204);
    const list = probe.listSnapshot([id, other])!;
    expect(list).toMatchObject({ topic: talkListTopic, state: "joined", ready: true, joins: 1, insertCount: 3, otherInserts: 1,
      rooms: { [id]: { count: 1, at: 200 }, [other]: { count: 1, at: 201 } } });
    expect(JSON.stringify(list)).not.toContain("private");
    expect(JSON.stringify(list)).not.toContain("secret");
    expect(JSON.stringify(list)).not.toContain(foreign);
    // The room-filtered channel keyed by id is not created by the unfiltered talk list join.
    expect(probe.snapshot(id)).toBeNull();
  });
  it("ignores a filtered join on the talk-list topic", () => {
    const probe = new RoomWireProbe();
    probe.observe(frame("phx_join", { config: { postgres_changes: [
      { schema: "public", table: "messages", filter: `conversation_id=eq.${id}` },
    ] } }, "7", talkListTopic), true);
    expect(probe.listSnapshot([id])).toBeNull();
  });
  it("proves the original socket is responsive only with a matching heartbeat reply", () => {
    const probe = joining();
    probe.observe(frame("heartbeat", {}, "ping", "phoenix"), true);
    probe.observe(frame("phx_reply", { status: "ok" }, "wrong", "phoenix"), false);
    expect(probe.snapshot(id)?.heartbeatReplies).toBe(0);
    probe.observe(frame("phx_reply", { status: "ok" }, "ping", "phoenix"), false);
    probe.observe(frame("phx_reply", { status: "ok" }, "ping", "phoenix"), false);
    expect(probe.snapshot(id)?.heartbeatReplies).toBe(1);
  });
});
