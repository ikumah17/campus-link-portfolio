import { clientMessageId, latestMessages, listConversations, loadRoom, markRead, messagePage, olderMessages, sendChatMessage } from "../src/chat-data";
import {
  conditionLabels, conditionParams, conditionsFromParams, getProfile, listProfiles, loadDiscover, normalizeConditions, PAGE_SIZE,
  parseProfile, viewerEligible,
} from "../src/discover-data";
import { getLikeState, LIKES_PAGE_SIZE, likeUser, listLikes, loadLikes, loadProfile, unlikeUser } from "../src/like-data";
import { callRpc, RPC_NAMES } from "../src/rpc";
import { blockConversation, blockProfile, report } from "../src/safety-data";
import {
  accountRow, CONV, conversationRow, done, fakeSupabase, likeRow, likeStateRow, masterTables, messageRow, ok, PHOTO_A, profileRow, raised, refusal, SCHOOL,
  TARGET, USER,
} from "./fake-supabase";
const MSG_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const client = (fake: ReturnType<typeof fakeSupabase>) => fake as unknown as Parameters<typeof loadDiscover>[0];


// MOBILE-003: the mapping of discover_profiles, get_profile, the request RPCs, the chat RPCs and block/report.
describe("the app's RPC names (MOBILE-003, MOBILE-LIKES-001)", () => {
  it("adds only the user RPCs of discovery, likes, chat, block and report", () => {
    for (const name of ["discover_profiles", "get_profile", "like_user", "unlike_user", "list_my_likes", "get_like_state",
      "list_my_conversations", "list_messages", "send_message", "mark_read", "block_user", "submit_report"]) {
      expect(RPC_NAMES).toContain(name);
    }
    expect(RPC_NAMES).not.toContain("end_connection");
  });

  it("drops set_modes and the request RPCs (order 34) and refuses them before any request", async () => {
    const dropped = ["set_modes", "send_connection_request", "respond_connection_request", "cancel_connection_request", "list_my_requests"];
    for (const name of dropped) expect(RPC_NAMES).not.toContain(name);
    const fake = fakeSupabase(() => ok([]));
    for (const name of dropped) await expect(callRpc(fake, name as never)).rejects.toThrow("Unknown RPC name");
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(RPC_NAMES.some((name) => name.startsWith("admin_") || name.startsWith("service_"))).toBe(false);
  });

  it("still refuses a name outside the list", async () => {
    await expect(callRpc(fakeSupabase(() => ok([])), "authorize_photo_delivery" as never)).rejects.toThrow("Unknown RPC name");
  });
});

describe("discovery", () => {
  const schools = [{ id: SCHOOL, name: "架空大学" }];

  it("normalizes conditions and round-trips them through route params", () => {
    const conditions = normalizeConditions({ min: "20", max: "25", genders: ["female", "nope", "female"], schoolIds: [SCHOOL, "unknown"] }, schools);
    expect(conditions).toEqual({ min: 20, max: 25, genders: ["female"], schoolIds: [SCHOOL] });
    expect(conditionParams(conditions)).toEqual({ min: "20", max: "25", g: "female", s: SCHOOL });
    expect(conditionsFromParams(conditionParams(conditions), schools)).toEqual(conditions);
    expect(conditionLabels(conditions, schools)).toEqual(["20〜25歳", "女性", "架空大学"]);
    expect(normalizeConditions({ min: "30", max: "20" }, schools)).toEqual({ min: undefined, max: undefined, genders: [], schoolIds: [] });
    expect(normalizeConditions({ min: "17", max: "121" }, schools)).toEqual({ min: undefined, max: undefined, genders: [], schoolIds: [] });
  });

  it("sends the web's discover_profiles arguments and pages by the last id", async () => {
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) => profileRow({ user_id: `88888888-8888-4888-8888-${String(i).padStart(12, "0")}` }));
    const fake = fakeSupabase(() => ok(rows));
    const result = await listProfiles(fake, { min: 20, genders: ["male"], schoolIds: [], after: TARGET });
    expect(fake.rpc).toHaveBeenCalledWith("discover_profiles", {
      p_min_age: 20, p_max_age: null, p_genders: ["male"], p_school_ids: null, p_after: TARGET, p_limit: PAGE_SIZE,
    });
    expect(result.status === "ok" && result.nextAfter).toBe(rows[PAGE_SIZE - 1].user_id);
  });

  it("refuses a page with a malformed profile", async () => {
    expect(await listProfiles(fakeSupabase(() => ok([profileRow({ photo_ids: ["x"] })])), { genders: [], schoolIds: [] })).toEqual({ status: "unavailable" });
    expect(parseProfile(profileRow({ bio: null, purposes: [], hobbies: null }))).toMatchObject({ bio: "", purposes: [], hobbies: [] });
  });

  it("reads the purposes as the fixed codes and refuses anything else", () => {
    expect(parseProfile(profileRow())).toMatchObject({ purposes: ["friends", "hobby"] });
    for (const purposes of [null, "friends", ["romance"], ["friends", "friends"], [1], ["friends", "partner", "hobby", "study", "talk", "x"]]) {
      expect(parseProfile(profileRow({ purposes }))).toBeNull();
    }
    expect(parseProfile({ ...profileRow(), purpose: "友達づくり", purposes: undefined })).toBeNull();
  });

  it("gives an unviewable and a missing profile the same empty answer", async () => {
    expect(await getProfile(fakeSupabase(() => ok([])), TARGET)).toEqual({ status: "ok", profile: null });
    const fake = fakeSupabase(() => ok([accountRow()]));
    expect(await loadProfile(fake, "not-a-uuid")).toEqual({ status: "ok", profile: null, likeState: null });
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(await getProfile(fakeSupabase(() => ok([profileRow(), profileRow()])), TARGET)).toEqual({ status: "unavailable" });
  });

  it("calls get_profile without a mode", async () => {
    const fake = fakeSupabase(() => ok([]));
    await getProfile(fake, TARGET);
    expect(fake.rpc).toHaveBeenCalledWith("get_profile", { p_target: TARGET });
  });

  it("maps a refused token to unauthenticated and anything else to unavailable", async () => {
    expect(await getProfile(fakeSupabase(() => ({ data: null, error: { code: "PGRST301" }, status: 401 })), TARGET)).toEqual({ status: "unauthenticated" });
    expect(await getProfile(fakeSupabase(() => raised("forbidden")), TARGET)).toEqual({ status: "unavailable" });
    expect(await viewerEligible(fakeSupabase(() => ok([{}])))).toEqual({ status: "unavailable" });
  });

  it("gates discovery: onboarding first, then eligibility, then the page", async () => {
    expect(await loadDiscover(client(fakeSupabase(() => ok([accountRow({ profile_completed: false })]), masterTables)), {})).toEqual({ status: "incomplete" });
    expect(await loadDiscover(client(fakeSupabase(() => ok([accountRow({ account_status: "deleted" })]), masterTables)), {})).toEqual({ status: "unavailable" });
    expect(await loadDiscover(client(fakeSupabase(() => ok([accountRow({ eligible: false })]), masterTables)), {})).toEqual({ status: "not_eligible" });
    const fake = fakeSupabase((name) => name === "my_account" ? ok([accountRow({ eligible: true })]) : ok([profileRow()]), masterTables);
    // An old ?mode= param is ignored: discover_profiles never gets a mode.
    const page = await loadDiscover(client(fake), { g: "female", s: SCHOOL, mode: "friends" } as never, "bad-after");
    expect(page).toMatchObject({ status: "ok", nextAfter: null, conditions: { genders: ["female"], schoolIds: [SCHOOL] } });
    const [name, args] = fake.rpc.mock.calls.at(-1)!;
    expect(name).toBe("discover_profiles");
    expect(args).toMatchObject({ p_after: null, p_school_ids: [SCHOOL] });
    expect(args).not.toHaveProperty("p_mode");
  });
});

describe("likes (MOBILE-LIKES-001)", () => {
  it("reads one list with the web's arguments and pages by the last row", async () => {
    const fake = fakeSupabase(() => ok([likeRow()]));
    expect(await listLikes(fake, "received")).toEqual({ status: "ok", next: null, likes: [{ id: TARGET, likedAt: "2026-11-17T03:00:00Z", profile: expect.objectContaining({ id: TARGET, purposes: ["friends", "hobby"] }) }] });
    expect(fake.rpc).toHaveBeenCalledWith("list_my_likes", { p_direction: "received", p_before_at: null, p_before_id: null, p_limit: LIKES_PAGE_SIZE });
    const rows = Array.from({ length: LIKES_PAGE_SIZE }, (_, i) => {
      const id = `88888888-8888-4888-8888-${String(i).padStart(12, "0")}`;
      return likeRow({ counterpart_id: id, liked_at: `2026-11-17T03:00:${String(i).padStart(2, "0")}Z` }, { user_id: id });
    });
    const full = fakeSupabase(() => ok(rows));
    const page = await listLikes(full, "sent", { at: "2026-11-18T00:00:00Z", id: TARGET });
    expect(full.rpc).toHaveBeenCalledWith("list_my_likes", { p_direction: "sent", p_before_at: "2026-11-18T00:00:00Z", p_before_id: TARGET, p_limit: LIKES_PAGE_SIZE });
    expect(page.status === "ok" && page.next).toEqual({ at: rows[LIKES_PAGE_SIZE - 1].liked_at, id: rows[LIKES_PAGE_SIZE - 1].counterpart_id });
  });

  it("refuses a malformed row, a profile of someone else and an unknown direction", async () => {
    expect(await listLikes(fakeSupabase(() => ok([likeRow({ counterpart_id: USER })])), "received")).toEqual({ status: "unavailable" });
    expect(await listLikes(fakeSupabase(() => ok([likeRow({ liked_at: null })])), "received")).toEqual({ status: "unavailable" });
    expect(await listLikes(fakeSupabase(() => ok([likeRow({ counterpart: null })])), "received")).toEqual({ status: "unavailable" });
    const fake = fakeSupabase(() => ok([]));
    expect(await listLikes(fake, "both" as never)).toEqual({ status: "unavailable" });
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(await listLikes(fakeSupabase(() => ({ data: null, error: { code: "PGRST301" }, status: 401 })), "sent")).toEqual({ status: "unauthenticated" });
  });

  it("loads both lists behind the gate", async () => {
    const fake = fakeSupabase((name, args) => name === "my_account" ? ok([accountRow()]) : ok(args.p_direction === "received" ? [likeRow()] : []));
    expect(await loadLikes(fake)).toMatchObject({ status: "ok", received: { likes: [{ id: TARGET }], next: null }, sent: { likes: [], next: null } });
    expect(await loadLikes(fakeSupabase(() => ok([accountRow({ profile_completed: false })])))).toEqual({ status: "incomplete" });
    const broken = fakeSupabase((name, args) => name === "my_account" ? ok([accountRow()]) : args.p_direction === "sent" ? ok([{ broken: true }]) : ok([]));
    expect(await loadLikes(broken)).toEqual({ status: "unavailable" });
  });

  it("reads the like state, with an unviewable person as null", async () => {
    const fake = fakeSupabase(() => ok([likeStateRow({ liked_me: true })]));
    expect(await getLikeState(fake, TARGET)).toEqual({ status: "ok", state: { iLiked: false, likedMe: true, conversationId: null } });
    expect(fake.rpc).toHaveBeenCalledWith("get_like_state", { p_target: TARGET });
    expect(await getLikeState(fakeSupabase(() => ok([likeStateRow({ conversation_id: CONV })])), TARGET)).toMatchObject({ state: { conversationId: CONV } });
    expect(await getLikeState(fakeSupabase(() => ok([])), TARGET)).toEqual({ status: "ok", state: null });
    expect(await getLikeState(fakeSupabase(() => ok([likeStateRow({ i_liked: "yes" })])), TARGET)).toEqual({ status: "unavailable" });
    expect(await getLikeState(fakeSupabase(() => ok([likeStateRow(), likeStateRow()])), TARGET)).toEqual({ status: "unavailable" });
  });

  it("loads a profile with its like state, and still shows it when the state cannot be read", async () => {
    const answer = (state: () => ReturnType<typeof ok>) => fakeSupabase((name) => name === "my_account" ? ok([accountRow()]) : name === "get_profile" ? ok([profileRow()]) : state());
    expect(await loadProfile(answer(() => ok([likeStateRow({ i_liked: true })])), TARGET)).toMatchObject({ status: "ok", profile: { id: TARGET }, likeState: { iLiked: true } });
    expect(await loadProfile(answer(() => raised("forbidden")), TARGET)).toMatchObject({ status: "ok", profile: { id: TARGET }, likeState: null });
    expect(await loadProfile(answer(() => ({ data: null, error: { code: "PGRST301" }, status: 401 })), TARGET)).toEqual({ status: "unauthenticated" });
    const missing = fakeSupabase((name) => name === "my_account" ? ok([accountRow()]) : ok([]));
    expect(await loadProfile(missing, TARGET)).toEqual({ status: "ok", profile: null, likeState: null });
    expect(missing.rpc).not.toHaveBeenCalledWith("get_like_state", expect.anything());
  });

  it("likes and takes back with the web's arguments; a match answers the conversation", async () => {
    const fake = fakeSupabase(() => done());
    expect(await likeUser(fake, TARGET)).toEqual({ status: "ok" });
    expect(fake.rpc).toHaveBeenLastCalledWith("like_user", { p_target: TARGET });
    expect(await unlikeUser(fake, TARGET)).toEqual({ status: "ok" });
    expect(fake.rpc).toHaveBeenLastCalledWith("unlike_user", { p_target: TARGET });
    const match = fakeSupabase(() => ({ data: { ok: true, code: "ok", ref: CONV }, error: null, status: 200 }));
    expect(await likeUser(match, TARGET)).toEqual({ status: "ok", conversationId: CONV });
    const bad = fakeSupabase(() => ({ data: { ok: true, code: "ok", ref: "not-a-uuid" }, error: null, status: 200 }));
    expect(await likeUser(bad, TARGET)).toEqual({ status: "unavailable" });
    expect(await likeUser(fake, "x")).toEqual({ status: "validation" });
    expect(fake.rpc).toHaveBeenCalledTimes(2);
  });

  it.each(["not_available", "already_connected", "rate_limited"])("passes the refusal %s through", async (code) => {
    expect(await likeUser(fakeSupabase(() => refusal(code)), TARGET)).toEqual({ status: code });
  });

  it("shows forbidden, invalid_state and mfa_required as unavailable, and a raised validation as validation", async () => {
    expect(await likeUser(fakeSupabase(() => raised("forbidden")), TARGET)).toEqual({ status: "unavailable" });
    expect(await unlikeUser(fakeSupabase(() => refusal("invalid_state")), TARGET)).toEqual({ status: "unavailable" });
    expect(await likeUser(fakeSupabase(() => refusal("mfa_required")), TARGET)).toEqual({ status: "unavailable" });
    expect(await likeUser(fakeSupabase(() => raised("validation")), TARGET)).toEqual({ status: "validation" });
  });
});

describe("chat", () => {
  const chat = (messages: unknown[] = [messageRow(1, TARGET), messageRow(2, USER)], extra: Record<string, () => ReturnType<typeof ok>> = {}) => fakeSupabase((name) => {
    if (extra[name]) return extra[name]();
    if (name === "my_account") return ok([accountRow()]);
    if (name === "list_my_conversations") return ok([conversationRow()]);
    if (name === "list_messages") return ok(messages);
    return done();
  });

  it("reads the conversation list, with an empty one", async () => {
    expect(await listConversations(chat())).toMatchObject({ status: "ok", conversations: [{ id: CONV, partner: { name: "架空の相手", photoId: PHOTO_A }, unread: true, latest: { body: "こんにちは", mine: false } }] });
    const empty = conversationRow({ last_message_id: null, last_message_body: null, last_message_at: null, last_message_mine: null });
    expect(await listConversations(fakeSupabase(() => ok([empty])))).toMatchObject({ status: "ok", conversations: [{ latest: null }] });
    expect(await listConversations(fakeSupabase(() => ok([conversationRow({ counterpart_id: "x" })])))).toEqual({ status: "unavailable" });
  });

  it("orders messages, marks the counterpart's and keeps the hidden flag", async () => {
    const page = await messagePage(chat([messageRow(3, TARGET, { hidden: true, body: "置換え" }), messageRow(1, USER)]), CONV, TARGET, null);
    expect(page).toEqual({ status: "ok", hasOlder: false, messages: [
      { id: 1, mine: true, body: "本文1", createdAt: "2026-11-17T03:00:00Z", hidden: false },
      { id: 3, mine: false, body: "置換え", createdAt: "2026-11-17T03:00:00Z", hidden: true },
    ] });
    expect(await messagePage(chat([messageRow(1, USER, { created_at: "never" })]), CONV, TARGET, null)).toEqual({ status: "unavailable" });
  });

  it("opens a room only through the user's conversation list", async () => {
    expect(await loadRoom(chat(), CONV)).toMatchObject({ status: "ok", room: { conversation: { id: CONV }, messages: [{ id: 1 }, { id: 2 }] } });
    expect(await loadRoom(chat(), TARGET)).toEqual({ status: "ok", room: null });
    const fake = chat();
    expect(await loadRoom(fake, "bad")).toEqual({ status: "ok", room: null });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("sends, pages, reads and marks read with the web's arguments", async () => {
    const fake = chat();
    expect(await sendChatMessage(fake, CONV, MSG_ID, "こんにちは")).toMatchObject({ status: "ok" });
    expect(fake.rpc).toHaveBeenCalledWith("send_message", { p_conversation: CONV, p_client_msg_id: MSG_ID, p_body: "こんにちは" });
    await olderMessages(fake, CONV, 5);
    expect(fake.rpc).toHaveBeenLastCalledWith("list_messages", { p_conversation: CONV, p_before: 5, p_limit: 30 });
    await latestMessages(fake, CONV);
    expect(fake.rpc).toHaveBeenLastCalledWith("list_messages", { p_conversation: CONV, p_before: null, p_limit: 30 });
    expect(await markRead(fake, CONV, 2)).toEqual({ status: "ok" });
    expect(fake.rpc).toHaveBeenLastCalledWith("mark_read", { p_conversation: CONV, p_message_id: 2 });
  });

  it("refuses bad input before any request", async () => {
    const fake = chat();
    expect(await sendChatMessage(fake, CONV, MSG_ID, "   ")).toEqual({ status: "validation" });
    expect(await sendChatMessage(fake, CONV, MSG_ID, "あ".repeat(2001))).toEqual({ status: "validation" });
    expect(await olderMessages(fake, CONV, 0)).toEqual({ status: "validation" });
    expect(await markRead(fake, CONV, 1.5)).toEqual({ status: "validation" });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("answers not_available once the conversation is gone (a block or an ended connection)", async () => {
    const gone = chat(undefined, { list_my_conversations: () => ok([]) });
    expect(await latestMessages(gone, CONV)).toEqual({ status: "not_available" });
    expect(await sendChatMessage(gone, CONV, MSG_ID, "こんにちは")).toEqual({ status: "not_available" });
    expect(gone.rpc).not.toHaveBeenCalledWith("send_message", expect.anything());
  });

  it("passes the send refusals through", async () => {
    expect(await sendChatMessage(chat(undefined, { send_message: () => refusal("rate_limited") }), CONV, MSG_ID, "x")).toEqual({ status: "rate_limited" });
    expect(await sendChatMessage(chat(undefined, { send_message: () => raised("forbidden") }), CONV, MSG_ID, "x")).toEqual({ status: "unavailable" });
  });

  it("makes a version-4 client message id", () => {
    const value = clientMessageId(() => 0.5);
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("block and report", () => {
  const safety = (extra: Record<string, () => ReturnType<typeof ok>> = {}) => fakeSupabase((name) => {
    if (extra[name]) return extra[name]();
    if (name === "list_my_conversations") return ok([conversationRow()]);
    if (name === "list_messages") return ok([messageRow(7, TARGET), messageRow(6, USER)]);
    return done();
  });

  it("blocks a profile, and a conversation's counterpart", async () => {
    const fake = safety();
    expect(await blockProfile(fake, TARGET)).toBe("ok");
    expect(fake.rpc).toHaveBeenLastCalledWith("block_user", { p_target: TARGET });
    expect(await blockConversation(fake, CONV)).toBe("ok");
    expect(fake.rpc).toHaveBeenLastCalledWith("block_user", { p_target: TARGET });
    expect(await blockConversation(safety({ list_my_conversations: () => ok([]) }), CONV)).toBe("not_available");
  });

  it("reports a profile, a conversation and a message with the web's arguments (no request context since order 34)", async () => {
    const fake = safety();
    expect(await report(fake, "profile", TARGET, "spam", "  詳細  ")).toBe("ok");
    expect(fake.rpc).toHaveBeenLastCalledWith("submit_report", { p_target: TARGET, p_context: "profile", p_reason: "spam", p_detail: "詳細", p_request_id: null, p_message_id: null });
    await report(fake, "conversation", CONV, "harassment", "");
    expect(fake.rpc).toHaveBeenLastCalledWith("submit_report", { p_target: TARGET, p_context: "profile", p_reason: "harassment", p_detail: null, p_request_id: null, p_message_id: null });
    await report(fake, "message", CONV, "other", "", 7);
    expect(fake.rpc).toHaveBeenCalledWith("list_messages", { p_conversation: CONV, p_before: 8, p_limit: 30 });
    expect(fake.rpc).toHaveBeenLastCalledWith("submit_report", { p_target: TARGET, p_context: "message", p_reason: "other", p_detail: null, p_request_id: null, p_message_id: 7 });
    expect(fake.rpc.mock.calls.filter(([name]) => name === "submit_report").map(([, args]) => args?.p_request_id)).toEqual([null, null, null]);
  });

  it("refuses to report the user's own message, an unknown reason or a long detail", async () => {
    const fake = safety();
    expect(await report(fake, "message", CONV, "other", "", 6)).toBe("not_available");
    expect(await report(fake, "profile", TARGET, "unknown", "")).toBe("validation");
    expect(await report(fake, "profile", TARGET, "spam", "あ".repeat(1001))).toBe("validation");
    expect(fake.rpc).not.toHaveBeenCalledWith("submit_report", expect.anything());
  });

  it("passes rate_limited through and hides other refusals", async () => {
    expect(await report(safety({ submit_report: () => refusal("rate_limited") }), "profile", TARGET, "spam", "")).toBe("rate_limited");
    expect(await blockProfile(safety({ block_user: () => raised("forbidden") }), TARGET)).toBe("unavailable");
  });
});
