import { describe, expect, it } from "vitest";
import { createChatDemo } from "@/lib/chat-demo";
import { validateBody } from "@/lib/chat-gateway";
import { createDemoLikes, demoViewer } from "@/data/demo-likes";
import { like } from "@/lib/likes-demo";

describe("chat gateway contract", () => {
  it.each([["", false], ["a", true], ["a".repeat(2000), true], ["a".repeat(2001), false], [" \n\t　", false], ["😀".repeat(2000), true], ["😀".repeat(2001), false]] as const)("validates code points (%#)", (body, valid) => expect(validateBody(body)).toBe(valid));
  it("pages newest first without gaps or repeats and validates boundaries", async () => {
    const state = createDemoLikes(); const gateway = createChatDemo(() => state);
    const id = state.connections[0][1];
    const first = await gateway.listMessages(id);
    expect(first.data).toHaveLength(30); expect(first.data.map((m) => m.id)).toEqual(Array.from({ length: 30 }, (_, i) => 36 - i));
    const second = await gateway.listMessages(id, { before: first.data.at(-1)!.id, limit: 30 });
    expect(second.data.map((m) => m.id)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(new Set([...first.data, ...second.data].map((m) => m.id)).size).toBe(36);
    expect((await gateway.listMessages(id, { before: 1 })).data).toEqual([]);
    expect((await gateway.listMessages(id, { limit: 1 })).data[0].id).toBe(36);
    expect((await gateway.listMessages(id, { limit: 100 })).data).toHaveLength(36);
    for (const limit of [0, -1, 101, 1.5, NaN]) expect((await gateway.listMessages(id, { limit })).code).toBe("validation");
    expect((await gateway.listMessages(id, { before: 0 })).code).toBe("validation");
  });
  it("deduplicates sender/client id, leaves bodies unchanged, and rejects invalid writes", async () => {
    const state = createDemoLikes(); const gateway = createChatDemo(() => state); const id = state.connections[0][1];
    const first = await gateway.sendMessage(id, crypto.randomUUID(), " \nhello😀 ");
    expect(first.code).toBe("ok"); expect(first.data?.body).toBe(" \nhello😀 ");
    expect(await gateway.sendMessage(id, first.data!.clientMsgId, "retry")).toEqual(first);
    expect((await gateway.listMessages(id)).data).toHaveLength(30);
    expect((await gateway.listMessages(id, { limit: 100 })).data).toHaveLength(37);
    expect((await gateway.sendMessage(id, "invalid", " ")).code).toBe("validation");
    expect((await gateway.sendMessage(id, "invalid", "a".repeat(2001))).code).toBe("validation");
  });
  it("treats unknown and inaccessible alike and immediately follows connections", async () => {
    let state = createDemoLikes(); const gateway = createChatDemo(() => state);
    expect((await gateway.listMyConversations()).data.map((r) => r.id)).toEqual([state.connections[0][1]]);
    for (const id of ["unknown", "demo-3"]) {
      expect(await gateway.listMessages(id)).toEqual({ code: "ok", data: [] });
      expect(await gateway.sendMessage(id, "x", "hello")).toEqual({ code: "not_available", data: null });
      expect(await gateway.markRead(id, 1)).toEqual({ code: "not_available", data: null });
    }
    state = like(state, demoViewer, "demo-2").state;
    expect((await gateway.listMyConversations()).data.map((r) => r.id)).toContain("demo-2");
    expect((await gateway.listMessages("demo-2")).data).toEqual([]);
    await gateway.sendMessage("demo-2", "new", "new conversation");
    expect((await gateway.listMyConversations()).data[0].id).toBe("demo-2");
    state = { ...state, connections: [] };
    expect((await gateway.listMyConversations()).data).toEqual([]);
    expect((await gateway.listMessages("demo-2")).data).toEqual([]);
  });
  it("marks incoming messages read monotonically and protects data from caller mutations", async () => {
    const state = createDemoLikes(); const gateway = createChatDemo(() => state); const id = state.connections[0][1];
    expect((await gateway.listMyConversations()).data[0].unread).toBe(true);
    expect((await gateway.markRead(id, 999)).code).toBe("validation");
    await gateway.markRead(id, 36); await gateway.markRead(id, 1);
    const result = await gateway.listMyConversations(); expect(result.data[0].unread).toBe(false);
    result.data[0].partner.name = "mutated";
    const page = await gateway.listMessages(id); page.data[0].body = "mutated";
    expect((await gateway.listMyConversations()).data[0].partner.name).not.toBe("mutated");
    expect((await gateway.listMessages(id)).data[0].body).not.toBe("mutated");
  });
});
